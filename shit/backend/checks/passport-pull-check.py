import copy
from contextlib import ExitStack
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

import httpx

os.environ["DEBUG"] = "false"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.routers import machine_config
from app.services import config_pull
from app.services.config_store import ConfigStore
from app.services.config_sync import build_packages


class Sync:
    pushes = 0
    client = None

    async def push_checked(self):
        self.pushes += 1
        return None


with tempfile.TemporaryDirectory(prefix="passport-pull-check-") as folder, ExitStack() as cleanup:
    store = ConfigStore(str(Path(folder) / "config.db"), str(Path(folder) / "assets"))
    cleanup.callback(store.close)
    sync = Sync()
    camera = {"place": "main", "camera": {"id": "camera_1", "display_name": "Камера, вперёд", "ip_adress": "192.0.2.41", "port": "554", "user": "operator", "password": "fixture-only", "production": 2},
              "streams": {"stream_1": {"channel": 1, "substream": 1, "purposes": ["view", "neural"], "latency": 0, "use_udp": False, "reconnect": 10, "record_path": "/storage/internal", "segment": 600}}}
    neural = {"name": "Объекты пути", "model_file": "fixture.rknn", "classes": {"0": {"name": "Предмет", "superclass": "obstacle"}}, "superclasses": {"obstacle": {"name": "Препятствие", "color": "#9f93f5"}}, "thresholds": {"confidence": .45, "nms": .5}, "tracker": {"type": "iou", "min_hits": 3}, "zones": [{"id": 1, "name": "На пути", "color": "#68a5ff", "threshold": .2}]}
    projection = {"place": "main", "name": "Схема", "width": 1200, "height": 600, "machine": {"rect": [400, 220, 400, 160]},
                  "cameras": {"front": {"name": "Впереди", "region": [100, 40, 600, 340], "camera_id": "camera_1"}},
                  "top": {"resolution": {"width": 1280, "height": 640}}, "surround": {"resolution": {"width": 1920, "height": 1080}}}
    base = {
        ("place", "main"): {"name": "Основной модуль", "modules": ["neural", "birdview"]},
        ("camera", "camera_1"): camera,
        ("neural_config", "path-a"): neural,
        ("video_stream", "stream-a"): {"id": "stream-a", "name": "Путь", "place": "main", "width": 640, "height": 640, "rows": 1, "cols": 1, "tiles": [{"camera": "camera_1", "row": 0, "col": 0, "row_span": 1, "col_span": 1}]},
        ("neural_slot", "stream-a|path-a"): {"place": "main", "stream_id": "stream-a", "config_id": "path-a", "fps": 15, "depth": 2},
        ("projection", "scheme"): projection,
        ("surround_output", "main"): {"active": "scheme", "configs": {"scheme": {"cameras": {"front": "camera_1"}, "fps": 20, "dual_output": False, "stream_id": "birdview_linker", "stream_name": "Круговой обзор"}}},
        ("machine", "settings"): {"active_integration": "", "tz_offset_min": 180},
    }
    store.create_version("profile-a", "Профиль А", base)
    store.create_version("profile-b", "Профиль Б", base)
    store.set_active("profile-a")
    store.put("profile-a", "binding", "main", {"device_id": "fixture-device"})
    store.put("profile-b", "binding", "main", {"device_id": "fixture-device"})

    board = {"parts": None, "fail": None}

    def board_handler(request: httpx.Request) -> httpx.Response:
        if board["fail"]:
            raise board["fail"]
        assert request.url.path == "/config"
        return httpx.Response(200, json={"data": {"revision": "fixture", "parts": board["parts"]}})

    app = FastAPI()
    app.include_router(machine_config.router, prefix="/api")
    sync.client = httpx.AsyncClient(transport=httpx.MockTransport(board_handler))
    registry_get = lambda device_id: {"id": device_id, "ip": "192.0.2.10"} if device_id == "fixture-device" else None
    with patch.object(machine_config, "get_store", lambda: store), patch.object(machine_config, "sync", sync), patch.object(config_pull.registry, "get", registry_get), TestClient(app) as client:
        def snapshot(profile="profile-a"):
            return machine_config._library_snapshot(profile)

        def applied():
            return copy.deepcopy(build_packages(store, "profile-a")["fixture-device"]["package"]["parts"])

        def diff(profile="profile-a"):
            return client.get(f"/api/config/profiles/{profile}/board-diff")

        # Плата совпадает с профилем и паспортом
        board["parts"] = applied()
        response = diff()
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["items"] == [] and result["skipped"] == [] and result["devices"][0]["state"] == "ok"
        assert result["context"] == snapshot()["context"] and result["revision"] == snapshot()["revision"]

        # Плата ушла вперёд: адрес камеры, порог, новый поток; проекции на плате нет
        parts = applied()
        parts["cameras"][0]["camera"]["ip_adress"] = "192.0.2.99"
        parts["neural"]["configurations"]["path-a"]["thresholds"]["confidence"] = .6
        parts["neural"]["streams"]["stream-new"] = {"id": "stream-new", "name": "Новый", "width": 320, "height": 320, "rows": 1, "cols": 1, "tiles": []}
        del parts["surround"]["projections"]["scheme"]
        board["parts"] = parts
        result = diff().json()
        items = {(item["kind"], item["key"]): item for item in result["items"]}
        assert set(items) == {("camera", "camera_1"), ("neural_config", "path-a"), ("video_stream", "stream-new")}, items.keys()
        assert items[("camera", "camera_1")]["changes"] == [{"path": "camera.ip_adress", "was": "192.0.2.41", "now": "192.0.2.99"}]
        assert items[("camera", "camera_1")]["body"]["place"] == "main" and items[("camera", "camera_1")]["name"] == "Камера, вперёд"
        assert items[("neural_config", "path-a")]["changes"] == [{"path": "thresholds.confidence", "was": .45, "now": .6}]
        assert items[("video_stream", "stream-new")]["state"] == "add" and items[("video_stream", "stream-new")]["body"]["place"] == "main"
        assert [(item["kind"], item["key"], item["reason"]) for item in result["skipped"]] == [("projection", "scheme", "absent_on_board")]

        # Выбранные отличия пишутся в паспорт обычной ручкой, профиль не меняется
        chosen = [{"kind": item["kind"], "key": item["key"], "body": item["body"]} for item in result["items"]]
        before = snapshot()
        response = client.put("/api/config/profiles/profile-a/passport", json={"context": result["context"], "revision": result["revision"], "changes": chosen})
        assert response.status_code == 200, response.text
        assert store.version_entities(store.profile("profile-a")["version_id"]) == base
        assert set(store.passport("profile-a")) == {("binding", "main"), ("camera", "camera_1"), ("neural_config", "path-a"), ("video_stream", "stream-new")}
        again = diff().json()
        assert again["items"] == [], again["items"]

        # Устройство не отвечает, нет в реестре, не загруженный профиль
        board["fail"] = httpx.ConnectTimeout("fixture timeout")
        result = diff().json()
        assert result["items"] == [] and result["devices"][0]["state"] == "error" and "fixture timeout" in result["devices"][0]["error"]
        board["fail"] = None
        board["parts"] = None
        assert diff().json()["devices"][0]["error"] == "Board has no applied configuration"
        with patch.object(config_pull.registry, "get", lambda device_id: None):
            assert diff().json()["devices"][0]["error"] == "Device fixture-device is not registered"
        assert diff("profile-b").status_code == 409
        assert diff("missing").status_code == 404

        # Сброс паспорта: остаются привязка и карточка машины
        store.put("profile-a", "machine", "identity", {"name": "Машина А", "serial": "42"})
        current = snapshot()
        response = client.post("/api/config/profiles/profile-a/passport/reset", json={"context": current["context"], "revision": "stale"})
        assert response.status_code == 409 and len(store.passport("profile-a")) == 5
        sync.pushes = 0
        response = client.post("/api/config/profiles/profile-a/passport/reset", json={"context": current["context"], "revision": current["revision"]})
        assert response.status_code == 200, response.text
        body = response.json()
        assert sorted((item["kind"], item["key"]) for item in body["removed"]) == [("camera", "camera_1"), ("neural_config", "path-a"), ("video_stream", "stream-new")]
        assert set(store.passport("profile-a")) == {("binding", "main"), ("machine", "identity")}
        assert body["snapshot"]["entities"]["camera"]["camera_1"]["state"] == "profile" and sync.pushes == 1
        current = snapshot()
        response = client.post("/api/config/profiles/profile-a/passport/reset", json={"context": current["context"], "revision": current["revision"]})
        assert response.status_code == 200 and response.json()["removed"] == [] and sync.pushes == 1

        # Не загруженный профиль сбрасывается без отправки на плату
        store.put("profile-b", "camera", "camera_1", {**camera, "camera": {**camera["camera"], "ip_adress": "192.0.2.77"}})
        current = snapshot("profile-b")
        response = client.post("/api/config/profiles/profile-b/passport/reset", json={"context": current["context"], "revision": current["revision"]})
        assert response.status_code == 200 and len(response.json()["removed"]) == 1 and sync.pushes == 1
        assert client.post("/api/config/profiles/missing/passport/reset", json={"context": "", "revision": ""}).status_code == 404

        # Паспорт по умолчанию заменяется текущим состоянием: новая версия, отличия свёрнуты, привязка и карточка машины остаются
        store.put("profile-b", "camera", "camera_1", {**camera, "camera": {**camera["camera"], "ip_adress": "192.0.2.88"}})
        store.put("profile-b", "machine", "identity", {"name": "Машина Б", "serial": "7"})
        before = store.profile("profile-b")["version_id"]
        current = snapshot("profile-b")
        stale = client.post("/api/config/profiles/profile-b/passport/fold", json={"context": current["context"], "revision": "stale"})
        assert stale.status_code == 409 and store.profile("profile-b")["version_id"] == before
        response = client.post("/api/config/profiles/profile-b/passport/fold", json={"context": current["context"], "revision": current["revision"]})
        assert response.status_code == 200, response.text
        body = response.json()
        after = store.profile("profile-b")["version_id"]
        assert body["folded"] == 1 and after != before and body["version"]["created"] is True and sync.pushes == 1
        assert ("machine", "identity") not in store.version_entities(after)
        assert set(store.passport("profile-b")) == {("binding", "main"), ("machine", "identity")}
        folded = body["snapshot"]["entities"]["camera"]["camera_1"]
        assert folded["state"] == "profile" and folded["body"]["camera"]["ip_adress"] == "192.0.2.88"
        current = snapshot("profile-b")
        response = client.post("/api/config/profiles/profile-b/passport/fold", json={"context": current["context"], "revision": current["revision"]})
        assert response.status_code == 409 and store.profile("profile-b")["version_id"] == after
        store.remove("profile-b", "machine", "identity")

        # Смена интеграции при сбросе идёт через жизненный цикл профиля
        store.put("profile-a", "machine", "settings", {"active_integration": "iskra", "tz_offset_min": 180})
        calls = []

        async def switch(profile_id, edit=None, **_):
            calls.append(profile_id)
            edit()
            return {"phase": "complete"}

        current = snapshot()
        with patch.object(machine_config.lifecycle, "switch", switch):
            response = client.post("/api/config/profiles/profile-a/passport/reset", json={"context": current["context"], "revision": current["revision"]})
        assert response.status_code == 200 and calls == ["profile-a"] and response.json()["ok"] is True, response.text
        assert ("machine", "settings") not in store.passport("profile-a")

        # Новая версия профиля меняет сущность, которую переопределил паспорт: «Оставить своё» снимает конфликт
        store.put("profile-a", "camera", "camera_1", {**camera, "camera": {**camera["camera"], "ip_adress": "192.0.2.55"}})
        newer = {**base, ("camera", "camera_1"): {**camera, "camera": {**camera["camera"], "ip_adress": "192.0.2.60"}}}
        store.create_version("profile-a", "Профиль А", newer)
        current = snapshot()
        assert current["entities"]["camera"]["camera_1"].get("profile_newer") is True
        response = client.put("/api/config/profiles/profile-a/passport", json={"context": current["context"], "revision": current["revision"], "changes": [{"kind": "camera", "key": "camera_1", "keep": True}]})
        assert response.status_code == 200, response.text
        kept = response.json()["snapshot"]["entities"]["camera"]["camera_1"]
        assert "profile_newer" not in kept and kept["state"] == "replaced" and kept["body"]["camera"]["ip_adress"] == "192.0.2.55"
        current = snapshot()
        response = client.put("/api/config/profiles/profile-a/passport", json={"context": current["context"], "revision": current["revision"], "changes": [{"kind": "camera", "key": "camera_1", "reset": True}, {"kind": "neural_config", "key": "path-a", "keep": True}]})
        assert response.status_code == 409 and ("camera", "camera_1") in store.passport("profile-a")

        # Идущий переход блокирует сброс
        store.put("profile-a", "camera", "camera_1", {**camera, "camera": {**camera["camera"], "ip_adress": "192.0.2.55"}})
        store.save_profile_transition({"id": "transition-check", "profile_id": "profile-b", "phase": "loading"})
        current = snapshot()
        response = client.post("/api/config/profiles/profile-a/passport/reset", json={"context": current["context"], "revision": current["revision"]})
        assert response.status_code == 409 and ("camera", "camera_1") in store.passport("profile-a")
        assert diff().status_code == 409
print("passport-pull-check: OK")
