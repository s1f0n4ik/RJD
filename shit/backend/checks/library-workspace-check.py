import copy
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

os.environ["DEBUG"] = "false"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from app.routers import machine_config
from app.services.config_store import ConfigStore

root = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("library_detection_rules", root / "detection-service/app/rules.py")
protocol = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = protocol
spec.loader.exec_module(protocol)


class Sync:
    pushes = 0
    error = None

    async def push_checked(self):
        self.pushes += 1
        return self.error

    def status(self):
        return [{"device_id": "fixture-device", "state": "ok"}]


with tempfile.TemporaryDirectory(prefix="library-workspace-check-") as folder, ExitStack() as cleanup:
    store = ConfigStore(str(Path(folder) / "config.db"), str(Path(folder) / "assets"))
    cleanup.callback(store.close)
    sync = Sync()
    camera = {"place": "main", "camera": {"id": "camera_1", "display_name": "Камера, вперёд", "ip_adress": "192.0.2.41", "port": "554", "user": "operator", "password": "fixture-only", "production": 2},
              "streams": {"stream_1": {"channel": 1, "substream": 1, "purposes": ["view", "neural", "record", "birdview"], "latency": 0, "use_udp": False, "reconnect": 10, "record_path": "/storage/internal", "segment": 600}}}
    neural = {"name": "Объекты пути", "model_file": "fixture.rknn", "classes": {"0": {"name": "Предмет", "superclass": "obstacle"}}, "superclasses": {"obstacle": {"name": "Препятствие", "color": "#9f93f5"}}, "thresholds": {"confidence": .45, "nms": .5}, "tracker": {"type": "iou", "min_hits": 3}, "zones": [{"id": 1, "name": "На пути", "color": "#68a5ff", "threshold": .2}]}
    cells = [{"id": "0", "row": 0, "col": 0, "rowSpan": 2, "colSpan": 2}, *[{"id": str(index + 1), "row": row, "col": col, "rowSpan": 1, "colSpan": 1} for index, (row, col) in enumerate([(0, 2), (1, 2), (2, 0), (2, 1), (2, 2)])]]
    projection = {"place": "main", "name": "Схема двух камер", "width": 1200, "height": 600, "machine": {"rect": [400, 220, 400, 160]},
                  "cameras": {"front": {"name": "Впереди", "region": [100, 40, 600, 340], "camera_id": "camera_1"}, "rear": {"name": "Сзади", "region": [500, 220, 600, 340], "camera_id": "camera_2"}},
                  "top": {"resolution": {"width": 1280, "height": 640}}, "surround": {"resolution": {"width": 1920, "height": 1080}}}
    base = {
        ("place", "main"): {"name": "Основной модуль", "modules": ["neural", "birdview"]},
        ("camera", "camera_1"): camera,
        ("camera", "camera_2"): {**copy.deepcopy(camera), "camera": {**camera["camera"], "id": "camera_2", "display_name": "Камера, назад", "ip_adress": "192.0.2.42"}},
        ("neural_config", "path-a"): neural,
        ("neural_config", "path-b"): {**copy.deepcopy(neural), "name": "Повторное имя класса, другая конфигурация"},
        ("video_stream", "stream-a"): {"id": "stream-a", "name": "Путь перед машиной", "place": "main", "width": 640, "height": 640, "rows": 1, "cols": 1, "tiles": [{"camera": "camera_1", "row": 0, "col": 0, "row_span": 1, "col_span": 1}]},
        ("neural_slot", "stream-a|path-a"): {"place": "main", "stream_id": "stream-a", "config_id": "path-a", "fps": 15, "depth": 2},
        ("projection", "scheme"): projection,
        ("surround_output", "main"): {"active": "scheme", "configs": {"scheme": {"cameras": {"front": "camera_1", "rear": "camera_2"}, "fps": 20, "dual_output": True, "stream_id": "birdview_linker", "stream_name": "Круговой обзор"}}},
        ("layout", "Рабочее место"): {"name": "Рабочее место", "gridSize": "custom", "customCells": cells, "customGridRows": 3, "customGridCols": 3, "activeCells": {"0": "birdview_linker", "1": "camera_1", "2": "camera_2"}, "timestamp": 1},
        ("machine", "settings"): {"active_integration": "rsm-2000", "tz_offset_min": 180},
        ("integration", "rsm-2000"): {"modules": {"can": {"enabled": True, "iface": "can0", "bitrate": 250000}}},
        ("rules", "rsm-2000"): protocol.RsmSettings().model_dump(),
    }
    store.create_version("profile-a", "Профиль А", base)
    other = {**copy.deepcopy(base), ("machine", "settings"): {"active_integration": "iskra"}, ("integration", "iskra"): {"modules": {"modbus": {"device": "/dev/ttyS0", "baud": 115200}}}, ("rules", "iskra"): protocol.IskraSettings().model_dump()}
    store.create_version("profile-b", "Профиль Б", other)
    store.set_active("profile-a")
    for profile in ("profile-a", "profile-b"):
        store.put(profile, "binding", "main", {"device_id": "fixture-device"})
    changed_camera = copy.deepcopy(camera)
    changed_camera["camera"]["ip_adress"] = "192.0.2.99"
    store.put("profile-a", "camera", "camera_1", changed_camera)

    async def master(method, path, body=None):
        model = protocol.IskraSettings if "/iskra" in path else protocol.RsmSettings
        if method == "GET":
            return {"defaults": model().model_dump()}
        try:
            return model.model_validate(body).model_dump()
        except ValidationError as error:
            raise HTTPException(422, str(error))

    app = FastAPI()
    app.include_router(machine_config.router, prefix="/api")
    with patch.object(machine_config, "get_store", lambda: store), patch.object(machine_config, "sync", sync), patch.object(machine_config, "_master", master), patch.object(machine_config.lifecycle, "status", store.profile_transition), TestClient(app) as client:
        def workspace(profile="profile-a"):
            response = client.get(f"/api/config/profiles/{profile}/workspace")
            assert response.status_code == 200, response.text
            return response.json()

        def save(changes, profile="profile-a", snapshot=None):
            snapshot = snapshot or workspace(profile)
            return client.put(f"/api/config/profiles/{profile}/passport", json={"context": snapshot["context"], "revision": snapshot["revision"], "changes": changes})

        current = workspace()
        assert current["base"]["camera"]["camera_1"]["camera"]["ip_adress"] == "192.0.2.41"
        assert current["entities"]["camera"]["camera_1"]["body"]["camera"]["ip_adress"] == "192.0.2.99"
        assert current["entities"]["camera"]["camera_1"]["state"] == "replaced"
        assert current["base"]["projection"]["scheme"]["cameras"]["rear"]["region"] == [500, 220, 600, 340]
        if destination := os.environ.get("RJD_LIBRARY_FIXTURES"):
            Path(destination).write_text(json.dumps({"profiles": client.get("/api/config/profiles").json(), "status": client.get("/api/config/status").json(), "workspaces": {"profile-a": current, "profile-b": workspace("profile-b")}}, ensure_ascii=False), encoding="utf-8")
        assert client.get("/api/config/profiles/missing/workspace").status_code == 404
        assert save([{"kind": "machine", "key": "identity", "body": {"name": "Машина Б", "serial": "42"}}], "profile-b").status_code == 200
        assert sync.pushes == 0 and store.active_profile() == "profile-a"
        assert save([{"kind": "machine", "key": "identity", "body": {"name": "Машина А"}}]).status_code == 200
        assert sync.pushes == 1
        assert save([{"kind": "machine", "key": "identity", "body": {"name": "Устаревший черновик"}}], snapshot=current).status_code == 409
        before = copy.deepcopy(store.passport("profile-a"))
        broken = {**changed_camera, "place": "missing"}
        assert save([{"kind": "machine", "key": "identity", "body": {"name": "Не сохранять"}}, {"kind": "camera", "key": "camera_1", "body": broken}]).status_code == 422
        assert store.passport("profile-a") == before
        assert save([{"kind": "camera", "key": "camera_1", "body": {**changed_camera, "camera": {**camera["camera"], "port": "70000"}}}]).status_code == 422
        assert save([{"kind": "machine", "key": "settings", "body": {"active_integration": "iskra"}}]).status_code == 409
        store.put("profile-a", "machine", "settings", {"active_integration": "iskra", "tz_offset_min": 180})
        defaults = workspace()["rules_defaults"]
        assert "rsm-2000" in defaults and "iskra" in defaults
        assert isinstance(defaults["rsm-2000"]["table"]["cameras"], dict)
        assert isinstance(defaults["iskra"]["table"]["cameras"], list)
        assert save([{"kind": "machine", "key": "settings", "reset": True}]).status_code == 409
        store.reset("profile-a", "machine", "settings")
        assert save([{"kind": "camera", "key": "camera_1", "reset": True}]).status_code == 200
        assert ("camera", "camera_1") not in store.passport("profile-a")
        assert save([{"kind": "neural_slot", "key": "stream-a|path-a", "body": {**base[("neural_slot", "stream-a|path-a")], "fps": 0}}]).status_code == 422
        rules = protocol.RsmSettings().model_dump()
        rules["table"]["models"] = {"path-a": {"classes": {"0": 2}, "superclasses": {}}, "path-b": {"classes": {"0": 3}, "superclasses": {}}}
        rules["table"]["danger_override"] = {"path-a": {"0": 0}}
        rules["dictionaries"]["type"] = [{"number": 2, "name": "Тип два"}]
        assert save([{"kind": "rules", "key": "rsm-2000", "body": rules}]).status_code == 200
        stored = store.effective()["entities"]["rules"]["rsm-2000"]["body"]
        assert stored["table"]["models"]["path-b"]["classes"]["0"] == 3
        assert protocol.RsmSettings.model_validate(stored).resolve("path-a", 0, "obstacle", 0) == (2, 0)
        assert protocol.RsmSettings.model_validate(stored).resolve("path-b", 0, "obstacle", 0)[0] == 0
        rules["dictionaries"]["type"].append({"number": 2, "name": "Дубликат"})
        assert save([{"kind": "rules", "key": "rsm-2000", "body": rules}]).status_code == 422
        async def unavailable(method, path, body=None):
            raise HTTPException(503, "Fixture service offline")

        with patch.object(machine_config, "_master", unavailable):
            offline = workspace()
            assert offline["rules_defaults"] == {} and offline["entities"]["rules"]
        async def concurrent_switch(method, path, body=None):
            result = await master(method, path, body)
            if method == "POST":
                store.set_active("profile-b")
            return result

        valid_rules = protocol.RsmSettings().model_dump()
        before = copy.deepcopy(store.passport("profile-a"))
        with patch.object(machine_config, "_master", concurrent_switch):
            assert save([{"kind": "rules", "key": "rsm-2000", "body": valid_rules}]).status_code == 409
        assert store.passport("profile-a") == before
        store.set_active("profile-a")
        snapshot = workspace("profile-b")
        store.create_version("profile-b", "Профиль Б", {**other, ("machine", "identity"): {"name": "Новая версия"}})
        assert save([{"kind": "machine", "key": "identity", "body": {"name": "Старая версия"}}], "profile-b", snapshot).status_code == 409
        snapshot = workspace()
        store.save_profile_transition({"id": "transition-check", "profile_id": "profile-b", "phase": "loading"})
        assert save([{"kind": "machine", "key": "identity", "body": {"name": "Переход"}}], snapshot=snapshot).status_code == 409
        assert save([{"kind": "machine", "key": "identity", "body": {"name": "Переход"}}], "profile-b").status_code == 409
        store.save_profile_transition({"id": "transition-check", "profile_id": "profile-b", "phase": "repairing"})
        assert save([{"kind": "machine", "key": "identity", "body": {"name": "Исправлено"}}], "profile-b").status_code == 200
        assert save([{"kind": "machine", "key": "identity", "body": {"name": "Чужой паспорт"}}]).status_code == 409
        store.save_profile_transition({"id": "transition-check", "profile_id": "profile-b", "phase": "complete"})
        sync.error = "fixture delivery failure"
        response = save([{"kind": "machine", "key": "identity", "body": {"name": "Сохранено, ожидает применения"}}])
        assert response.status_code == 200 and response.json()["application_error"] == sync.error
        assert store.effective()["entities"]["machine"]["identity"]["body"]["name"] == "Сохранено, ожидает применения"
print("library-workspace-check: OK")
