import asyncio
import atexit
import copy
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
temporary = tempfile.TemporaryDirectory(prefix="integration-check-")
os.environ["CONFIG_DB"] = str(Path(temporary.name) / "unused.db")
os.environ["CONFIG_ASSETS_DIR"] = str(Path(temporary.name) / "assets")
os.environ["DEBUG"] = "false"

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from app.routers import configurations, machine_config
from app.services import config_sync
from app.services import lifecycle as lifecycle_service
from app.services.config_store import ConfigError, ConfigStore, check_refs
from app.services.config_sync import ConfigSync, build_service_packages, executor_error
from app.services.lifecycle import ProfileLifecycle


async def main():
    message = executor_error(httpx.Response(422, json={"detail": [{"loc": ["rules", "stitch", "gap_s"], "msg": "Must be nonnegative", "input": "secret-sentinel"}]}))
    assert "rules.stitch.gap_s" in message and "secret-sentinel" not in message
    store = ConfigStore(str(Path(temporary.name) / "config.db"), str(Path(temporary.name) / "assets"))
    atexit.register(store.close)
    entities = {("machine", "settings"): {"active_integration": "rsm-2000"},
                ("integration", "rsm-2000"): {"modules": {"can": {"enabled": False, "tx_detections": {"pgn": 10, "addr": 20}}}},
                ("integration", "iskra"): {"modules": {"modbus": {"enabled": False}}}}
    store.create_version("stand", "stand", entities)
    store.set_active("stand")
    broken = check_refs({"integration": {"rsm-2000": {}}, "rules": {"rsm-2000": {
        "table": {"models": {"missing-model": {}}, "cameras": {"missing-camera": 1}}}}})
    assert {entry["ref"] for entry in broken} == {"camera/missing-camera", "neural_config/missing-model"}
    live = {name: {"transition_id": "", "state": "running", "revision": ""} for name in ("gateway", "detection")}
    received, calls = {}, []
    failures = set()
    defaults = {"rsm-2000": {"modules": {"websocket": {"enabled": False, "host": "localhost", "port": "80", "target": "/", "heartbeat_sec": 5, "heartbeat_enabled": True},
                                        "can": {"enabled": False, "bitrate": 250000, "tx_detections": {"priority": 0, "pgn": 0xEF00, "addr": 0x71, "dst_addr": 0}}}},
                "iskra": {"modules": {"modbus": {"enabled": False, "slave": 20}}}}
    gateway_view = {"id": "rsm-2000", "modules": [{"id": "websocket", "connection": {"connected": False}},
                                                   {"id": "can", "connection": {"connected": False}, "tx": {},
                                                    "messages": [{"key": "tx_detections"}]}]}

    def handler(request):
        name = "gateway" if request.url.port == 9090 else "detection"
        body = json.loads(request.content) if request.content else {}
        path = request.url.path
        calls.append((name, request.method, path))
        if path == "/runtime":
            if request.method == "PUT":
                live[name].update(transition_id=body["transition_id"], state="stopped" if body["action"] == "stop" else "running")
            return httpx.Response(200, json={"data": live[name]})
        if path == "/config":
            if name in failures:
                return httpx.Response(500, json={"error": "injected application failure"})
            assert body.get("transition_id", "") == live[name]["transition_id"]
            received[name] = copy.deepcopy(body)
            live[name]["revision"] = body["revision"]
            return httpx.Response(200, json={"data": {"revision": body["revision"]}})
        if path == "/config/validate":
            if not body["integrations"]:
                return httpx.Response(200, json={"integrations": defaults})
            if body["integrations"]["rsm-2000"]["modules"]["can"].get("bad"):
                return httpx.Response(422, json={"error": "invalid CAN source"})
            return httpx.Response(200, json=body)
        if path.endswith("/validate"):
            if body.get("bad"):
                return httpx.Response(422, json={"detail": "invalid rules"})
            return httpx.Response(200, json={"stitch": {"gap_s": 2}, **body})
        if path.startswith("/rules/"):
            return httpx.Response(200, json={"defaults": {"stitch": {"gap_s": 2}}, "settings": {"obsolete": True}})
        if path in ("/status", "/integrations/rsm-2000/status"):
            return httpx.Response(200, json=copy.deepcopy(gateway_view))
        if path == "/integrations":
            return httpx.Response(200, json={"active": "rsm-2000", "items": [{"id": key, "modules": []} for key in ("rsm-2000", "iskra")]})
        if path == "/rules":
            return httpx.Response(200, json={"active": "rsm-2000"})
        raise AssertionError((name, path))

    client_type = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    sync = ConfigSync()
    sync._client = client_type(transport=transport)
    lifecycle = ProfileLifecycle(lambda: store)
    lifecycle._client = client_type(transport=transport)
    with patch.object(config_sync, "get_store", lambda: store), patch.object(configurations, "get_store", lambda: store), \
         patch.object(configurations, "sync", sync), patch.object(configurations, "lifecycle", lifecycle), \
         patch.object(lifecycle_service, "sync", sync), \
         patch.object(machine_config, "get_store", lambda: store), patch.object(machine_config, "lifecycle", lifecycle), \
         patch.object(configurations.httpx, "AsyncClient", lambda **kwargs: client_type(transport=transport)):
        await sync.push_services()
        assert len([x for x in calls if x[2] == "/config"]) == 2
        await sync.push_services()
        assert len([x for x in calls if x[2] == "/config"]) == 2
        before = store.passport("stand")
        for fn, args in ((configurations.put_gateway_module, ("can", {"bad": True})),
                         (configurations.put_configuration_rules, ("rsm-2000", {"bad": True}))):
            try:
                await fn(*args)
                raise AssertionError("Invalid source saved")
            except HTTPException as error:
                assert error.status_code == 422
            assert store.passport("stand") == before
        await configurations.put_gateway_module("can", {"tx_detections": {"pgn": 30}})
        can = received["gateway"]["integrations"]["rsm-2000"]["modules"]["can"]
        assert can == {"enabled": False, "tx_detections": {"pgn": 30, "addr": 20}}
        failures.add("detection")
        try:
            await configurations.put_configuration_rules("rsm-2000", {"stitch": {"gap_s": 4}})
            raise AssertionError("Application error concealed")
        except HTTPException as error:
            assert error.status_code == 502 and "Source saved" in error.detail
        source = await configurations.get_configuration_rules("rsm-2000")
        assert source["settings"] == {"stitch": {"gap_s": 4}} and source["saved_at"]
        failures.clear()
        await sync.push_services()
        assert received["detection"]["rules"]["rsm-2000"]["stitch"]["gap_s"] == 4
        result = await configurations.select_configuration(configurations.SelectRequest(id="iskra"))
        assert result["transition"]["phase"] == "stopping"
        await lifecycle.advance()
        result = await configurations.list_configurations()
        assert result["transition"]["phase"] == "complete" and result["active"] == "iskra"
        assert all(item["active"] == "iskra" for item in received.values())
        assert received["gateway"]["transition_id"] == received["detection"]["transition_id"]
        assert all(state["state"] == "running" for state in live.values())
        package = build_service_packages(store)["gateway"]
        assert received["gateway"]["revision"] == package["revision"]
        polling, release = asyncio.Event(), asyncio.Event()

        async def delayed(request):
            if request.method == "GET" and request.url.path == "/runtime":
                polling.set()
                await release.wait()
            return handler(request)

        await sync._client.aclose()
        sync._client = client_type(transport=httpx.MockTransport(delayed))
        pending_poll = asyncio.create_task(sync.push_services())
        await polling.wait()
        before = len([call for call in calls if call[2] == "/config"])
        await lifecycle.switch("stand")
        release.set()
        await pending_poll
        assert len([call for call in calls if call[2] == "/config"]) == before
        await lifecycle.advance()
        assert lifecycle.status()["phase"] == "complete"
        failures.add("detection")
        await configurations.select_configuration(configurations.SelectRequest(id="rsm-2000"))
        await lifecycle.advance()
        failed_id = lifecycle.status()["id"]
        assert lifecycle.status()["error"]
        app = FastAPI()
        app.include_router(machine_config.router, prefix="/api")
        app.include_router(configurations.router, prefix="/api")
        app.add_exception_handler(ConfigError, lambda request, error: JSONResponse({"detail": str(error)}, status_code=409))
        api = TestClient(app)
        response = api.post("/api/config/transition/repair", json={"transition_id": failed_id})
        assert response.status_code == 200, response.text
        repair_id = response.json()["transition"]["id"]
        await lifecycle.advance()
        assert lifecycle.status()["phase"] == "repairing"
        count = len([call for call in calls if call[2] == "/config"])
        response = api.put("/api/config/entities/machine/settings", json={"active_integration": "rsm-2000", "repair_note": "saved"})
        assert response.status_code == 200 and lifecycle.status()["phase"] == "repairing", response.text
        response = api.put("/api/configurations/gateway/can", json={"bitrate": 0, "tx_detections": {"pgn": 0xFF00, "priority": 6}})
        assert response.status_code == 200, response.text
        can = response.json()["modules"][1]
        assert can["connection"]["bitrate"] == 0 and can["messages"][0]["id"] == "0x18FF0014", can
        assert api.get("/api/configurations/gateway/status").json()["repairing"]
        response = api.put("/api/configurations/gateway/can", json={"bitrate": 250000})
        assert response.status_code == 200, response.text
        response = api.put("/api/configurations/rsm-2000/rules", json={"stitch": {"gap_s": 7}})
        assert response.status_code == 200 and response.json()["settings"]["stitch"]["gap_s"] == 7, response.text
        assert len([call for call in calls if call[2] == "/config"]) == count
        assert api.post("/api/config/transition/retry", json={"transition_id": failed_id}).status_code == 409
        response = api.post("/api/config/transition/retry", json={"transition_id": repair_id})
        assert response.status_code == 200 and response.json()["transition"]["phase"] == "stopping", response.text
        failures.clear()
        await lifecycle.advance()
        assert lifecycle.status()["phase"] == "complete"
        assert received["detection"]["rules"]["rsm-2000"]["stitch"]["gap_s"] == 7
    await sync.close()
    await lifecycle.close()
    store.close()
    print("integration-check: OK")


asyncio.run(main())
