import asyncio
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import zipfile
from unittest.mock import patch

os.environ["DEBUG"] = "false"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from fastapi import FastAPI, HTTPException

from app.config import settings
from app.routers import machine_config
from app.services import config_sync
from app.services.config_store import ConfigStore, digest
from app.services.devices import registry
from app.services.lifecycle import ProfileLifecycle

root = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("profile_switch_rules", root / "detection-service/app/rules.py")
protocol = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = protocol
spec.loader.exec_module(protocol)

# Три файла из make-test-profiles.py: python profile-switch-check.py <папка с test-rsm-2000-v1/v2 и test-iskra-v1 .varan>
if len(sys.argv) != 2:
    sys.exit("usage: profile-switch-check.py <folder with test profiles>")
FILES = Path(sys.argv[1])
BOARD = "fixture-board"
RSM, ISKRA = "test-rsm-2000", "test-iskra"
RSM_CAMERAS = {"camera_2", "camera_3"}
ISKRA_CAMERAS = {"camera_3", "camera_1", "camera_4", "camera_5", "camera_6"}


class Fake:
    # Плата, шлюз и детекции по протоколу мастера: hold, /config, /runtime
    def __init__(self):
        self.board = {"transition_id": "", "held": False, "modules": [], "available": ["cameras", "neural", "surround"], "applied": None, "assets": set(), "state": "running"}
        self.services = {name: {"state": "running", "transition_id": "", "revision": "", "applied": None} for name in ("gateway", "detection")}
        self.down = False
        self.log = []

    def revision(self):
        return (self.board["applied"] or {}).get("revision", "")

    def hold(self):
        board = self.board
        return {"data": {"transition_id": board["transition_id"], "held": board["held"], "modules": board["modules"], "available": board["available"], "revision": self.revision()}}

    def handle(self, request: httpx.Request) -> httpx.Response:
        port, path, method = request.url.port, request.url.path, request.method
        body = json.loads(request.content) if request.content and "json" in request.headers.get("content-type", "") else None
        self.log.append((port, method, path))
        if port == 7777:
            return self.handle_board(request, path, method, body)
        name = "gateway" if port == 9090 else "detection"
        service = self.services[name]
        if path == "/runtime" and method == "GET":
            return httpx.Response(200, json={"data": {k: v for k, v in service.items() if k != "applied"}})
        if path == "/runtime":
            service.update(state="stopped" if body["action"] == "stop" else "running", transition_id=body["transition_id"])
            return httpx.Response(200, json={"data": {k: v for k, v in service.items() if k != "applied"}})
        assert path == "/config" and method == "PUT", path
        service.update(revision=body["revision"], applied=body)
        return httpx.Response(200, json={"data": {"revision": body["revision"]}})

    def handle_board(self, request, path, method, body):
        board = self.board
        if self.down:
            raise httpx.ConnectError("board offline", request=request)
        if path == "/config/hold":
            if method == "PUT":
                if body["held"]:
                    board.update(held=True, transition_id=body["transition_id"])
                else:
                    board.update(held=False, modules=body["modules"])
            return httpx.Response(200, json=self.hold())
        if path.endswith(("/start", "/stop")):
            assert board["held"] and board["transition_id"] == body["transition_id"]
            return httpx.Response(200, json={"data": {"state": "running" if path.endswith("/start") else "stopped", "transition_id": body["transition_id"], "revision": self.revision()}})
        if path == "/config" and method == "GET":
            return httpx.Response(200, json={"data": board["applied"] or {}})
        if path == "/config/assets":
            board["assets"].add(request.url.params["sha256"])
            return httpx.Response(200, json={"data": {}})
        assert path == "/config" and method == "PUT", path
        missing = [sha for sha in body["assets"] if sha not in board["assets"]]
        if missing:
            return httpx.Response(409, json={"error": "missing assets", "missing_assets": missing})
        board["applied"] = body
        return httpx.Response(200, json={"data": {"revision": body["revision"]}})


def zip_doc(path: Path) -> dict:
    with zipfile.ZipFile(path) as z:
        return json.loads(z.read("profile.json"))


async def main():
    with tempfile.TemporaryDirectory(prefix="profile-switch-check-") as folder:
        store = ConfigStore(str(Path(folder) / "config.db"), str(Path(folder) / "assets"))
        fake = Fake()
        client = httpx.AsyncClient(transport=httpx.MockTransport(fake.handle))
        sync = config_sync.ConfigSync()
        sync._client = client
        lifecycle = ProfileLifecycle(lambda: store)
        lifecycle._client = client

        async def master(method, path, body=None):
            model = protocol.IskraSettings if "/iskra" in path else protocol.RsmSettings
            if method == "GET":
                return {"defaults": model().model_dump()}
            return model.model_validate(body).model_dump()

        online = lambda device_id: {"id": device_id, "ip": "192.0.2.10", "status": "online"} if device_id == BOARD else None
        app = FastAPI()
        app.include_router(machine_config.router, prefix="/api")
        patches = [
            patch.object(machine_config, "get_store", lambda: store), patch.object(machine_config, "sync", sync),
            patch.object(machine_config, "lifecycle", lifecycle), patch.object(machine_config, "_master", master),
            patch.object(config_sync, "get_store", lambda: store), patch.object(registry, "get", online),
            patch.object(registry, "snapshot_one", online),
        ]
        for item in patches:
            item.start()
        api = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://master")

        async def call(method, path, expect=200, **kwargs):
            response = await api.request(method, "/api" + path, **kwargs)
            assert response.status_code == expect, f"{method} {path}: {response.status_code} {response.text[:400]}"
            return response

        async def settle(expect="complete"):
            for _ in range(8):
                await lifecycle.advance()
                if (store.profile_transition() or {}).get("phase") == "complete" or (store.profile_transition() or {}).get("error"):
                    break
            state = store.profile_transition()
            assert state["phase"] == expect, state
            return state

        async def upload(name, activate=False):
            path = FILES / name
            with open(path, "rb") as source:
                response = await call("POST", "/config/load", files={"file": (name, source.read())}, data={"activate": str(activate).lower()})
            return response.json()

        async def workspace(profile):
            return (await call("GET", f"/config/profiles/{profile}/workspace")).json()

        def cameras(snapshot):
            return set(snapshot["entities"].get("camera", {}))

        def board_cameras():
            return {item["camera"]["id"] for item in fake.board["applied"]["parts"]["cameras"]}

        # Импорт: первый профиль становится активным и переходит через шлюз и детекции
        loaded = await upload("test-rsm-2000-v1.varan")
        assert loaded["profile"]["id"] == RSM and loaded["broken"] == []
        await settle()
        assert store.active_profile() == RSM
        loaded = await upload("test-iskra-v1.varan")
        assert loaded["profile"]["id"] == ISKRA and loaded["broken"] == [] and store.active_profile() == RSM
        listing = (await call("GET", "/config/profiles")).json()
        assert [item["id"] for item in listing["profiles"]] == [RSM, ISKRA] and listing["active"] == RSM

        # Состав профилей различается: камеры, нейроконфигурации, интеграция, пояс, раскладки, правила
        rsm, iskra = await workspace(RSM), await workspace(ISKRA)
        assert cameras(rsm) == RSM_CAMERAS and cameras(iskra) == ISKRA_CAMERAS
        assert set(rsm["entities"]["neural_config"]) == {"railway_camera"} and set(iskra["entities"]["neural_config"]) == {"railway_camera_seg"}
        assert rsm["entities"]["machine"]["settings"]["body"] == {"active_integration": "rsm-2000", "tz_offset_min": 180}
        assert iskra["entities"]["machine"]["settings"]["body"] == {"active_integration": "iskra", "tz_offset_min": 300}
        assert set(rsm["entities"]["layout"]) == {"РСМ-2000"} and set(iskra["entities"]["layout"]) == {"Искра 360"}
        assert "projection" not in rsm["entities"] and set(iskra["entities"]["projection"]) == {"test_v2_new"}
        assert rsm["entities"]["rules"]["rsm-2000"]["body"]["table"]["cameras"] == {"camera_2": 1, "camera_3": 2}
        assert iskra["entities"]["rules"]["iskra"]["body"]["table"]["cameras"][0]["camera_id"] == "camera_3"
        assert rsm["broken"] == [] and iskra["broken"] == []

        # Экспорт каждого профиля повторяет файл: те же сущности и файлы моделей
        for profile, name in ((RSM, "test-rsm-2000-v1.varan"), (ISKRA, "test-iskra-v1.varan")):
            response = await call("GET", f"/config/profiles/{profile}/export")
            assert name in response.headers["content-disposition"]
            exported = Path(folder) / name
            exported.write_bytes(response.content)
            original, again = zip_doc(FILES / name), zip_doc(exported)
            assert again["entities"] == original["entities"] and set(again["assets"]) == set(original["assets"])
            with zipfile.ZipFile(exported) as z:
                assert {f"assets/{sha}" for sha in again["assets"]} <= set(z.namelist())

        # Тот же файл повторно новой версии не создаёт; файл v2 добавляет версию, камер три
        assert (await upload("test-iskra-v1.varan"))["version"]["created"] is False
        assert len((await call("GET", "/config/profiles")).json()["profiles"][1]["versions"]) == 1

        # Привязка места к плате: у каждого профиля своя, активному сразу уходит пакет
        for profile in (ISKRA, RSM):
            snapshot = await workspace(profile)
            await call("PUT", f"/config/profiles/{profile}/passport", json={"context": snapshot["context"], "revision": snapshot["revision"], "changes": [{"kind": "binding", "key": "board-1", "body": {"device_id": BOARD}}]})
        assert board_cameras() == RSM_CAMERAS and fake.board["applied"]["parts"].keys() == {"cameras", "neural"}

        # Переключения: РСМ → Искра → РСМ → Искра; плата получает именно набор выбранного профиля
        for target, expected, integration, offset in ((ISKRA, ISKRA_CAMERAS, "iskra", 300), (RSM, RSM_CAMERAS, "rsm-2000", 180), (ISKRA, ISKRA_CAMERAS, "iskra", 300), (RSM, RSM_CAMERAS, "rsm-2000", 180)):
            response = (await call("POST", "/config/active", json={"profile_id": target})).json()
            assert response["transition"]["phase"] == "stopping"
            await settle()
            assert store.active_profile() == target
            assert board_cameras() == expected
            parts = fake.board["applied"]["parts"]
            assert set(parts["neural"]["configurations"]) == ({"railway_camera_seg"} if target == ISKRA else {"railway_camera"})
            assert ("surround" in parts) == (target == ISKRA)
            assert fake.services["gateway"]["applied"]["active"] == integration and fake.services["gateway"]["applied"]["time"]["tz_offset_min"] == offset
            assert fake.services["detection"]["applied"]["active"] == integration
            assert all(item["state"] == "running" for item in fake.services.values()) and fake.board["held"] is False
            status = (await call("GET", "/config/status")).json()
            assert status["transition"]["profile_id"] == target and status["transition"]["phase"] == "complete"
            assert fake.board["applied"]["revision"] == config_sync.build_packages(store)[BOARD]["package"]["revision"]

        # Паспорт у каждого профиля свой: правка РСМ не видна в Искре и переживает переключения
        snapshot = await workspace(RSM)
        config = copy.deepcopy(snapshot["entities"]["neural_config"]["railway_camera"]["body"])
        config["thresholds"]["confidence"] = 0.55
        response = (await call("PUT", f"/config/profiles/{RSM}/passport", json={"context": snapshot["context"], "revision": snapshot["revision"], "changes": [{"kind": "neural_config", "key": "railway_camera", "body": config}]})).json()
        assert response["application_error"] is None
        assert fake.board["applied"]["parts"]["neural"]["configurations"]["railway_camera"]["thresholds"]["confidence"] == 0.55
        await call("POST", "/config/active", json={"profile_id": ISKRA})
        await settle()
        assert (await workspace(ISKRA))["entities"]["neural_config"]["railway_camera_seg"]["state"] == "profile"
        await call("POST", "/config/active", json={"profile_id": RSM})
        await settle()
        assert fake.board["applied"]["parts"]["neural"]["configurations"]["railway_camera"]["thresholds"]["confidence"] == 0.55
        counts = {item["id"]: item["overrides"] for item in (await call("GET", "/config/profiles")).json()["profiles"]}
        assert counts == {RSM: 1, ISKRA: 0}

        # Сравнение с платой: совпадает, затем плата уходит вперёд, отличие пишется в паспорт
        diff = (await call("GET", f"/config/profiles/{RSM}/board-diff")).json()
        assert diff["items"] == [] and diff["devices"][0]["state"] == "ok"
        fake.board["applied"]["parts"]["cameras"][0]["camera"]["port"] = "8554"
        diff = (await call("GET", f"/config/profiles/{RSM}/board-diff")).json()
        assert [(item["kind"], item["key"], item["changes"][0]["path"]) for item in diff["items"]] == [("camera", "camera_2", "camera.port")]
        item = diff["items"][0]
        await call("PUT", f"/config/profiles/{RSM}/passport", json={"context": diff["context"], "revision": diff["revision"], "changes": [{"kind": "camera", "key": "camera_2", "body": item["body"]}]})
        assert (await workspace(RSM))["entities"]["camera"]["camera_2"]["body"]["camera"]["port"] == "8554"
        assert (await call("GET", f"/config/profiles/{RSM}/board-diff")).json()["items"] == []
        assert (await call("GET", f"/config/profiles/{ISKRA}/board-diff", expect=409)).status_code == 409

        # Версия v2 того же профиля: на активном идёт переход, камер три, паспорт получает конфликт
        loaded = await upload("test-rsm-2000-v2.varan")
        assert loaded["version"]["number"] == 2 and loaded["version"]["created"] is True
        await settle()
        assert board_cameras() == RSM_CAMERAS | {"camera_6"}
        after = await workspace(RSM)
        assert cameras(after) == RSM_CAMERAS | {"camera_6"} and after["version"]["number"] == 2
        assert after["entities"]["neural_config"]["railway_camera"].get("profile_newer") is True
        assert after["entities"]["camera"]["camera_2"].get("profile_newer") is None
        # «Оставить своё»: значение паспорта остаётся, конфликт снят
        await call("PUT", f"/config/profiles/{RSM}/passport", json={"context": after["context"], "revision": after["revision"], "changes": [{"kind": "neural_config", "key": "railway_camera", "keep": True}]})
        kept = await workspace(RSM)
        assert "profile_newer" not in kept["entities"]["neural_config"]["railway_camera"]
        assert kept["entities"]["neural_config"]["railway_camera"]["body"]["thresholds"] == {**config["thresholds"]}
        # Сброс всего паспорта: отличия уходят, привязка остаётся, плата получает значения профиля v2
        removed = (await call("POST", f"/config/profiles/{RSM}/passport/reset", json={"context": kept["context"], "revision": kept["revision"]})).json()
        assert sorted(item["kind"] for item in removed["removed"]) == ["camera", "neural_config"]
        reset = await workspace(RSM)
        assert reset["entities"]["binding"]["board-1"]["body"] == {"device_id": BOARD}
        assert all(entry["state"] == "profile" for kind, entries in reset["entities"].items() if kind != "binding" for entry in entries.values())
        thresholds = fake.board["applied"]["parts"]["neural"]["configurations"]["railway_camera"]["thresholds"]
        assert thresholds["confidence"] == 0.4 and thresholds["nms"] == 0.5

        # Версии: выбор v1 возвращает две камеры, экспорт v1 и v2 различается
        versions = {version["number"]: version["id"] for version in (await call("GET", "/config/profiles")).json()["profiles"][0]["versions"]}
        old = (await call("GET", f"/config/profiles/{RSM}/export", params={"version_id": versions[1]})).content
        new = (await call("GET", f"/config/profiles/{RSM}/export", params={"version_id": versions[2]})).content
        for content, count in ((old, 2), (new, 3)):
            path = Path(folder) / "version.varan"
            path.write_bytes(content)
            assert len([entity for entity in zip_doc(path)["entities"] if entity["kind"] == "camera"]) == count
        await call("POST", f"/config/profiles/{RSM}/select", json={"version_id": versions[1]})
        await settle()
        assert board_cameras() == RSM_CAMERAS and (await workspace(RSM))["version"]["number"] == 1
        await call("DELETE", f"/config/profiles/{RSM}/versions/{versions[2]}")
        await call("DELETE", f"/config/profiles/{RSM}", expect=409)

        # Сбои: привязка к незарегистрированному устройству отказывает до остановки модулей
        snapshot = await workspace(ISKRA)
        await call("PUT", f"/config/profiles/{ISKRA}/passport", json={"context": snapshot["context"], "revision": snapshot["revision"], "changes": [{"kind": "binding", "key": "board-1", "body": {"device_id": "ghost-board"}}]})
        calls = len(fake.log)
        response = await call("POST", "/config/active", json={"profile_id": ISKRA}, expect=409)
        assert "not registered" in response.json()["detail"] and len(fake.log) == calls and store.active_profile() == RSM
        snapshot = await workspace(ISKRA)
        await call("PUT", f"/config/profiles/{ISKRA}/passport", json={"context": snapshot["context"], "revision": snapshot["revision"], "changes": [{"kind": "binding", "key": "board-1", "body": {"device_id": BOARD}}]})

        # Плата не отвечает: переход встаёт на остановке с ошибкой, профиль не меняется; после возврата платы повтор доводит до конца
        fake.down = True
        await call("POST", "/config/active", json={"profile_id": ISKRA})
        state = await settle("stopping")
        assert state["error"] and store.active_profile() == RSM
        stuck = (await call("GET", "/config/status")).json()["transition"]
        assert stuck["phase"] == "stopping" and stuck["error"] and stuck["previous_profile_id"] == RSM
        fake.down = False
        await call("POST", "/config/transition/retry", json={"transition_id": stuck["id"]})
        await settle()
        assert store.active_profile() == ISKRA and board_cameras() == ISKRA_CAMERAS
        # Возврат прежнего профиля после сбоя: «Загрузить прежний профиль»
        fake.down = True
        await call("POST", "/config/active", json={"profile_id": RSM})
        await settle("stopping")
        stuck = (await call("GET", "/config/status")).json()["transition"]
        fake.down = False
        await call("POST", "/config/transition/retry", json={"transition_id": stuck["id"], "profile_id": ISKRA})
        await settle()
        assert store.active_profile() == ISKRA and board_cameras() == ISKRA_CAMERAS

        await api.aclose()
        for item in patches:
            item.stop()
        store.close()
    print("profile-switch-check: OK")


asyncio.run(main())
