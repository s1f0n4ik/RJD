import asyncio
import os
import sys
import tempfile
import time
import types
from pathlib import Path
from unittest.mock import patch

os.environ["DEBUG"] = "false"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

from app.services import config_sync, runtime_state as module
from app.services.config_store import ConfigStore
from app.services.lifecycle import ProfileLifecycle

BOARD = "board-1"


class Board:
    # Плата по протоколу мастера: hold, /camera, /neural/status, /linker/status
    def __init__(self):
        self.stream = 3
        self.slot = {"stream_id": "st", "config_id": "cfg", "running": True, "code": 0, "error": ""}
        self.linker = {"running": True, "export_id": "exp1"}
        self.held = False
        self.down = False
        self.revision = ""

    def handle(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("board offline", request=request)
        path = request.url.path
        if path == "/system/info":
            return httpx.Response(200, json={"data": {"config_revision": self.revision}})
        if path == "/config/hold":
            return httpx.Response(200, json={"data": {"held": self.held, "revision": "r", "transition_id": ""}})
        if path == "/camera":
            return httpx.Response(200, json={"data": {"cameras": {"camera_a": {"streams": {"stream_1": {"status": self.stream}}}}, "virtual": []}})
        if path == "/neural/status":
            return httpx.Response(200, json={"data": [self.slot]})
        if path == "/linker/status":
            return httpx.Response(200, json={"data": self.linker})
        raise AssertionError(path)


async def main():
    with tempfile.TemporaryDirectory(prefix="runtime-state-check-") as folder:
        store = ConfigStore(str(Path(folder) / "config.db"), str(Path(folder) / "assets"))
        store.create_version("p", "P", {
            ("place", "board"): {"modules": ["neural", "birdview"]},
            ("camera", "camera_a"): {"place": "board", "camera": {"id": "camera_a"},
                                     "streams": {"stream_1": {"purposes": ["view"]}, "stream_2": {"purposes": []}}},
            ("neural_slot", "s1"): {"place": "board", "stream_id": "st", "config_id": "cfg"},
            ("surround_output", "board"): {"active": "exp1", "configs": {}},
        })
        store.put("p", "binding", "board", {"device_id": BOARD})
        store.set_active("p")
        board = Board()
        online = {"status": "online"}
        registry = types.SimpleNamespace(
            get=lambda device_id: {"id": device_id, "ip": "192.0.2.10"} if device_id == BOARD else None,
            snapshot_one=lambda device_id: online if device_id == BOARD else None,
            client=httpx.AsyncClient(transport=httpx.MockTransport(board.handle)),
        )
        lifecycle = ProfileLifecycle(lambda: store)
        patches = [patch.object(module, "get_store", lambda: store), patch.object(module, "registry", registry),
                   patch.object(module, "lifecycle", lifecycle), patch.object(module, "sync", config_sync.ConfigSync()),
                   patch.object(module, "POLL_S", 0.05)]
        for item in patches:
            item.start()
        state = module.RuntimeState()
        packages = module.build_packages(store)
        board.revision = packages[BOARD]["package"]["revision"]

        async def snapshot():
            await state.refresh()
            return state._snapshot

        # Всё работает: ok, повторные сборки не меняют seq (время наблюдения не в счёт)
        first = await snapshot()
        assert first["summary"] == {"state": "ok", "problems": []}, first["summary"]
        assert [item["kind"] for item in first["devices"][0]["items"]] == ["camera", "slot", "surround"]
        await asyncio.sleep(0.01)
        assert (await snapshot())["seq"] == first["seq"]

        # Поток не запущен: сразу после перехода — запускается, по истечении льготы — сбой
        store.save_profile_transition({"id": "t", "profile_id": "p", "phase": "complete", "participants": [], "updated": time.time()})
        board.stream = 1
        starting = await snapshot()
        assert starting["summary"]["state"] == "starting" and starting["seq"] > first["seq"]
        with patch.object(module, "STARTING_GRACE_S", 0):
            failed = await snapshot()
        assert failed["summary"]["state"] == "issues"
        assert failed["summary"]["problems"][0]["code"] == "not_running" and failed["summary"]["problems"][0]["stream"] == "stream_1"
        board.stream = 3

        # Ошибка слота и выхода 360 видна сразу, без льготы
        board.slot.update(running=False, code=6006, error="no cameras in storage")
        board.linker = {"running": True, "export_id": "other"}
        broken = await snapshot()
        codes = {(item["kind"], item["code"], item["detail"]) for item in broken["summary"]["problems"]}
        assert ("slot", "slot_error", "no cameras in storage") in codes and any(kind == "surround" for kind, _, _ in codes), codes
        board.slot.update(running=True, code=0, error="")
        board.linker = {"running": True, "export_id": "exp1"}
        assert (await snapshot())["summary"]["state"] == "ok"

        # Плата на другой ревизии пакета — применяется; удержание после перехода — сбой
        board.revision = "old"
        assert (await snapshot())["summary"]["state"] == "starting"
        board.revision = packages[BOARD]["package"]["revision"]
        board.held = True
        assert (await snapshot())["summary"]["problems"][0]["code"] == "held"
        board.held = False

        # Нет связи: unknown; плата вернулась — льгота на запуск
        online["status"] = "offline"
        assert (await snapshot())["summary"]["state"] == "unknown"
        online["status"] = "online"
        board.down = True
        assert (await snapshot())["devices"][0]["error"] == "unreachable"
        board.down = False
        board.stream = 1
        returned = await snapshot()
        assert returned["summary"]["state"] == "starting", returned["summary"]
        board.stream = 3

        # Переход идёт: платы не опрашиваются, итог transition
        store.save_profile_transition({"id": "t2", "profile_id": "p", "phase": "loading", "participants": [], "updated": time.time()})
        moving = await snapshot()
        assert moving["summary"]["state"] == "transition" and moving["devices"] == []
        store.save_profile_transition({"id": "t2", "profile_id": "p", "phase": "complete", "participants": [], "updated": time.time()})

        # Long-poll: тот же seq ждёт до таймаута, изменение будит ответ, чужой boot отвечает сразу
        current = await snapshot()
        started = time.monotonic()
        same = await state.wait(current["boot"], current["seq"], 0.3)
        assert same["seq"] == current["seq"] and time.monotonic() - started >= 0.25
        waiting = asyncio.create_task(state.wait(current["boot"], current["seq"], 5))
        await asyncio.sleep(0.1)
        board.slot.update(running=False, code=6006, error="x")
        woken = await asyncio.wait_for(waiting, 2)
        assert woken["seq"] > current["seq"] and woken["summary"]["state"] == "issues"
        started = time.monotonic()
        assert (await state.wait("another-boot", woken["seq"], 5))["seq"] == woken["seq"] and time.monotonic() - started < 1
        await state.close()
        await registry.client.aclose()
        for item in patches:
            item.stop()
        store.close()
        print("runtime-state-check: OK")


asyncio.run(main())
