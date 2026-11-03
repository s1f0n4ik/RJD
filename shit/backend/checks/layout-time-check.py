import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["DEBUG"] = "false"

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.routers import configurations, layouts, machine_config
from app.routers import time as time_router
from app.services.config_bundle import export_profile, load_profile
from app.services.config_store import ConfigStore
from app.services.config_sync import build_service_packages


class Sync:
    error = None

    def __init__(self, store):
        self.store = store
        self.packages = []
        self.pending = False

    def status(self):
        if not self.packages or self.pending:
            return []
        return [{"device_id": "gateway", "state": "ok", "applied": self.packages[-1]["revision"]}]

    async def push_checked(self):
        if not self.store.is_repairing(self.store.active_profile()):
            self.packages.append(build_service_packages(self.store)["gateway"])
        return self.error


with tempfile.TemporaryDirectory(prefix="layout-time-check-") as folder:
    root = Path(folder)
    store = ConfigStore(str(root / "config.db"), str(root / "assets"))
    sync = Sync(store)
    body = {"name": "Обзор", "gridSize": 4, "activeCells": {"cell-1": "camera_1"}, "timestamp": 1,
            "streams": {"camera_1": "stream_2"}, "corrections": {"camera_1": True},
            "detections": {"camera_1": True}, "overlays": {"time": True},
            "surround": {"viewMode": "top", "manual": True}}
    base = {("layout", body["name"]): body,
            ("integration", "rsm-2000"): {"modules": {}},
            ("machine", "settings"): {"active_integration": "rsm-2000", "tz_offset_min": 300}}
    store.create_version("a", "Машина A", base)
    store.create_version("b", "Машина Б", {("machine", "settings"): {"active_integration": "rsm-2000"}})
    store.set_active("a")
    legacy = root / "layouts.json"
    legacy.write_text("legacy sentinel", encoding="utf-8")
    app = FastAPI()
    for router in (layouts.router, machine_config.router, time_router.router, configurations.router):
        app.include_router(router, prefix="/api")
    try:
        with patch.object(layouts, "get_store", lambda: store), patch.object(time_router, "get_store", lambda: store), \
             patch.object(machine_config, "get_store", lambda: store), patch.object(time_router, "sync", sync), \
             patch.object(machine_config, "sync", sync), TestClient(app) as client:
            response = client.get("/api/layouts")
            context = response.headers["X-Layout-Context"]
            assert response.headers["X-Profile-Id"] == "a" and response.json()[0]["streams"] == body["streams"]
            changed = {**body, "activeCells": {"cell-1": "camera_2"}, "timestamp": 2}
            assert client.post("/api/layouts", params={"context": context}, json=changed).status_code == 200
            assert store.passport("a")[("layout", body["name"])]["body"]["activeCells"] == changed["activeCells"]
            store.set_active("b")
            assert client.get("/api/layouts").json() == []
            assert client.post("/api/layouts", params={"context": context}, json=changed).status_code == 409
            assert client.delete("/api/layouts/Обзор", params={"context": context}).status_code == 409
            assert store.passport("b") == {}
            assert build_service_packages(store)["gateway"]["time"]["tz_offset_min"] == 180
            store.set_active("a")
            assert client.get("/api/layouts").json()[0]["activeCells"] == changed["activeCells"]
            assert client.delete("/api/layouts/Обзор", params={"context": context}).status_code == 204
            assert client.get("/api/layouts").json() == []
            assert store.passport("a")[("layout", body["name"])]["op"] == "remove"
            assert client.post("/api/config/passport/reset", json={"kind": "layout", "key": body["name"]}).status_code == 200
            assert client.get("/api/layouts").json()[0]["activeCells"] == body["activeCells"]
            before = build_service_packages(store)
            response = client.put("/api/time/config", json={"profile_id": "a", "tz_offset_min": 420})
            assert response.status_code == 200 and response.json()["applied"] is True
            after = build_service_packages(store)
            assert after["gateway"]["time"]["tz_offset_min"] == 420
            assert before["gateway"]["revision"] != after["gateway"]["revision"]
            assert before["detection"] == after["detection"]
            sync.pending = True
            pending = client.put("/api/time/config", json={"profile_id": "a", "tz_offset_min": 420})
            assert pending.status_code == 200 and pending.json()["applied"] is False
            sync.pending = False
            assert store.effective()["entities"]["machine"]["settings"]["body"]["active_integration"] == "rsm-2000"
            for value in (-721, 841, True, 3.5, "180"):
                assert client.put("/api/time/config", json={"profile_id": "a", "tz_offset_min": value}).status_code == 422
            assert client.put("/api/time/config", json={"profile_id": "b", "tz_offset_min": 180}).status_code == 409
            sync.error = "gateway unavailable"
            assert client.put("/api/time/config", json={"profile_id": "a", "tz_offset_min": 480}).status_code == 502
            assert build_service_packages(store)["gateway"]["time"]["tz_offset_min"] == 480
            sync.error = None
            assert client.post("/api/config/passport/reset", json={"kind": "machine", "key": "settings"}).status_code == 200
            assert sync.packages[-1]["time"]["tz_offset_min"] == 300
            store.save_profile_transition({"id": "switch", "profile_id": "a", "phase": "loading"})
            assert client.get("/api/layouts").headers["X-Profile-Phase"] == "loading"
            assert client.post("/api/layouts", json=changed).status_code == 409
            assert client.put("/api/time/config", json={"profile_id": "a", "tz_offset_min": 180}).status_code == 409
            store.save_profile_transition({"id": "switch", "profile_id": "a", "phase": "repairing"})
            count = len(sync.packages)
            response = client.put("/api/time/config", json={"profile_id": "a", "tz_offset_min": 540})
            assert response.status_code == 200 and response.json()["applied"] is False
            assert len(sync.packages) == count
            store.save_profile_transition({"id": "switch", "profile_id": "a", "phase": "complete"})
            assert client.post("/api/layouts", params={"context": context}, json=changed).status_code == 409
            assert legacy.read_text(encoding="utf-8") == "legacy sentinel"
            bundle, _ = export_profile(store, "a")
            other = ConfigStore(str(root / "other.db"), str(root / "other-assets"))
            try:
                load_profile(other, bundle)
                imported = other.effective("a")["entities"]
                assert imported["layout"][body["name"]]["body"] == body
                assert imported["machine"]["settings"]["body"]["tz_offset_min"] == 300
            finally:
                other.close()
                bundle.unlink()
            store.set_active("b")
            assert build_service_packages(store)["gateway"]["time"]["tz_offset_min"] == 180
            assert client.get("/api/layouts").json() == []
            store.set_active("a")
            race = False

            async def master(method, path, value=None):
                if method == "GET":
                    return {"defaults": {"stitch": {"gap_s": 2}}, "settings": {}}
                if race:
                    store.set_active("b")
                return value

            with patch.object(configurations, "get_store", lambda: store), patch.object(configurations, "sync", sync), \
                 patch.object(configurations, "_master", master):
                rules = client.get("/api/configurations/rsm-2000/rules")
                assert rules.status_code == 200 and rules.json()["context"] == store.context()
                expected = store.context()
                route = "/api/configurations/rsm-2000/rules"
                assert client.put(route, params={"context": "stale"}, json={}).status_code == 409
                assert client.put(route, params={"context": expected}, json={"stitch": {"gap_s": 3}}).status_code == 200
                original = store.passport("a")[("rules", "rsm-2000")]["body"]
                race = True
                assert client.put(route, params={"context": expected}, json={"stitch": {"gap_s": 4}}).status_code == 409
                assert store.passport("a")[("rules", "rsm-2000")]["body"] == original
                assert ("rules", "rsm-2000") not in store.passport("b")
    finally:
        store.close()
print("layout-time-check: OK")
