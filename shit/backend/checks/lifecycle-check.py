import asyncio
import atexit
import copy
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
temporary = tempfile.TemporaryDirectory(prefix="profile-lifecycle-check-")
os.environ["CONFIG_DB"] = str(Path(temporary.name) / "unused.db")
os.environ["CONFIG_ASSETS_DIR"] = str(Path(temporary.name) / "assets")
os.environ["DEBUG"] = "false"

import httpx

from app.services.config_store import ConfigError, ConfigStore
from app.services.lifecycle import ProfileLifecycle


async def main():
    store = ConfigStore(str(Path(temporary.name) / "config.db"), str(Path(temporary.name) / "assets"))
    atexit.register(store.close)
    for name in ("old", "new"):
        store.create_version(name, name, {("place", "board"): {"modules": []}})
        store.put(name, "binding", "board", {"device_id": name + "-board"})
    store.set_active("old")
    participants = [{"id": name, "base": "http://" + name, "modules": [name] if name != "board" else ["cameras", "neural", "surround"],
                     "package": {"revision": name + "-revision", "parts": {}}}
                    for name in ("board", "detection", "gateway")]
    live = {item["id"]: {"state": "running", "revision": "old-revision"} for item in participants}
    calls = []
    fail_stop, fail_load = {"board"}, {"detection"}
    board = {"transition_id": "", "held": False, "modules": [], "available": ["cameras", "neural", "surround"]}
    module_states = {name: "running" for name in board["available"]}
    bad_ack, fail_start = {}, set()
    faults = {"hold": False, "release": False}

    def handle(request):
        name = request.url.host
        body = json.loads(request.content) if request.content else None
        path = request.url.path
        recorded = copy.deepcopy(body)
        if path.endswith(("/start", "/stop")):
            recorded["action"] = path.rsplit("/", 1)[1]
        calls.append((name, request.method, path, recorded))
        if path == "/config/hold":
            if request.method == "PUT":
                if body["held"]:
                    assert body["previous_transition_id"] == board["transition_id"]
                    board.update(held=True, transition_id=body["transition_id"])
                    if faults["hold"]:
                        return httpx.Response(503, json={"error": "hold persistence failed"})
                else:
                    assert all(module_states[module] == "running" for module in body["modules"])
                    board.update(held=False, modules=body["modules"])
                    if faults["release"]:
                        faults["release"] = False
                        raise httpx.ReadTimeout("release response lost", request=request)
            return httpx.Response(200, json={"data": {**board, "revision": live[name]["revision"]}})
        if path.endswith(("/start", "/stop")):
            module = {"camera": "cameras", "neural": "neural", "linker": "surround"}[path.split("/")[1]]
            assert board["held"] and board["transition_id"] == body["transition_id"]
            if path in fail_start:
                return httpx.Response(503, json={"error": "module start failed"})
            if path.endswith("/stop"):
                if name in fail_stop and module == "surround":
                    return httpx.Response(503, json={"error": "stop failed"})
                module_states[module] = "stopped"
                if all(state == "stopped" for state in module_states.values()):
                    live[name]["state"] = "stopped"
            else:
                assert all(item["revision"] == key + "-revision" for key, item in live.items())
                module_states[module] = "running"
                live[name]["state"] = "running"
            result = {"state": module_states[module], "transition_id": board["transition_id"], "revision": live[name]["revision"]}
            if path in bad_ack:
                result[bad_ack[path]] = "wrong"
            return httpx.Response(200, json={"data": result})
        if request.url.path == "/runtime":
            if request.method == "GET":
                return httpx.Response(200, json={"data": live[name]})
            if body["action"] == "stop":
                if name in fail_stop:
                    return httpx.Response(503, json={"error": "stop failed"})
                live[name].update(state="stopped", transition_id=body["transition_id"])
            else:
                assert all(item["revision"] == key + "-revision" for key, item in live.items())
                live[name].update(state="running")
            return httpx.Response(200, json={"data": live[name]})
        assert request.url.path == "/config" and request.method == "PUT"
        assert all(item["state"] == "stopped" for item in live.values())
        if name in fail_load:
            return httpx.Response(500, json={"error": "load failed"})
        live[name]["revision"] = body["revision"]
        return httpx.Response(200, json={"ok": True})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    lifecycle = ProfileLifecycle(lambda: store)
    lifecycle._client = client
    lifecycle._participants = lambda *_: copy.deepcopy(participants)
    result = await lifecycle.switch("new")
    assert result["phase"] == "stopping" and not calls
    await lifecycle.advance()
    result = lifecycle.status()
    assert result["phase"] == "stopping" and result["error"]
    assert store.active_profile() == "old"
    assert not any(path == "/config" for _, _, path, _ in calls)
    assert all(any(name == item["id"] and body is not None and body.get("action") == "stop" for name, _, _, body in calls)
               for item in participants)
    assert module_states == {"cameras": "stopped", "neural": "stopped", "surround": "running"}
    assert [path for name, _, path, _ in calls if name == "board" and path.endswith("/stop")] == ["/linker/stop", "/neural/stop", "/camera/stop"]
    try:
        store.put("new", "place", "board", {"modules": ["neural"]})
        raise AssertionError("A profile changed during transition")
    except ConfigError:
        pass
    fail_stop.clear()
    resumed = ProfileLifecycle(lambda: store)
    resumed._client = client
    await resumed.advance()
    assert resumed.status()["phase"] == "loading" and resumed.status()["error"]
    assert store.active_profile() == "new"
    assert all(item["state"] == "stopped" for item in live.values())
    assert not any(body and body.get("action") == "start" for _, _, _, body in calls)
    assert sum(name == "board" and path == "/camera/stop" for name, _, path, _ in calls) == 2
    assert sum(name == "gateway" and body is not None and body.get("action") == "stop" for name, _, _, body in calls) == 1
    fail_load.clear()
    resumed_again = ProfileLifecycle(lambda: store)
    resumed_again._client = client
    await resumed_again.advance()
    assert resumed_again.status()["phase"] == "complete"
    assert resumed_again.status()["error"] is None
    assert all(item["state"] == "running" for item in live.values())
    starts = [name for name, _, _, body in calls if body and body.get("action") == "start"]
    assert starts == ["gateway", "detection", "board", "board", "board"]
    assert [path for name, _, path, _ in calls if name == "board" and path.endswith("/start")] == ["/camera/start", "/neural/start", "/linker/start"]
    assert not any(name == "board" and path == "/runtime" for name, _, path, _ in calls)
    assert sum(name == "board" and path == "/config" for name, _, path, _ in calls) == 1
    count = len(calls)
    await resumed_again.advance()
    assert len(calls) == count
    store.put("new", "place", "board", {"modules": []})
    version = store.create_version("new", "new", {("place", "board"): {"modules": []}, ("machine", "settings"): {}}, select=False)
    assert store.profile("new")["version_id"] != version["id"]
    seen_previous = []

    def changed_participants(profile, previous):
        seen_previous.extend(previous)
        return copy.deepcopy(participants)

    resumed_again._participants = changed_participants
    await resumed_again.switch("new", edit=lambda: store.put("new", "binding", "board", {"device_id": "replacement-board"}))
    assert seen_previous == ["new-board"]
    await resumed_again.advance()
    assert resumed_again.status()["phase"] == "complete"
    bad_ack["/linker/stop"] = "state"
    await resumed_again.switch("new")
    load_count = sum(path == "/config" for _, _, path, _ in calls)
    await resumed_again.advance()
    assert resumed_again.status()["phase"] == "stopping" and resumed_again.status()["error"]
    assert sum(path == "/config" for _, _, path, _ in calls) == load_count
    bad_ack.clear()
    await resumed_again.advance()
    assert resumed_again.status()["phase"] == "complete"
    faults["hold"] = True
    await resumed_again.switch("new")
    await resumed_again.advance()
    assert resumed_again.status()["phase"] == "stopping"
    assert all(value == "stopped" for value in module_states.values())
    faults["hold"] = False
    await resumed_again.advance()
    assert resumed_again.status()["phase"] == "complete"
    bad_ack["/camera/start"] = "revision"
    await resumed_again.switch("new")
    await resumed_again.advance()
    assert resumed_again.status()["phase"] == "starting" and board["held"]
    assert module_states == {"cameras": "running", "neural": "stopped", "surround": "stopped"}
    bad_ack.clear()
    await resumed_again.advance()
    assert resumed_again.status()["phase"] == "complete"
    fail_start.add("/neural/start")
    await resumed_again.switch("new")
    await resumed_again.advance()
    assert resumed_again.status()["phase"] == "starting" and board["held"]
    assert module_states == {"cameras": "running", "neural": "stopped", "surround": "stopped"}
    fail_start.clear()
    resumed_after_start = ProfileLifecycle(lambda: store)
    resumed_after_start._client = client
    faults["release"] = True
    await resumed_after_start.advance()
    assert resumed_after_start.status()["phase"] == "starting" and not board["held"]
    start_count = sum(path.endswith("/start") for _, _, path, _ in calls)
    await resumed_after_start.advance()
    assert resumed_after_start.status()["phase"] == "complete"
    assert sum(path.endswith("/start") for _, _, path, _ in calls) == start_count
    await client.aclose()
    store.close()
    print("lifecycle-check: OK")


asyncio.run(main())
