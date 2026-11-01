import asyncio
import copy
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
temporary = tempfile.TemporaryDirectory(prefix="profile-recovery-check-")
os.environ["CONFIG_DB"] = str(Path(temporary.name) / "unused.db")
os.environ["CONFIG_ASSETS_DIR"] = str(Path(temporary.name) / "assets")
os.environ["DEBUG"] = "false"

import httpx
from app.services import config_sync
from app.services.config_store import ConfigError, ConfigStore
from app.services.config_sync import ConfigSync
from app.services.lifecycle import ProfileLifecycle


def blocked(fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except ConfigError:
        return
    raise AssertionError("Unsafe edit accepted")


async def main():
    store = ConfigStore(str(Path(temporary.name) / "config.db"), str(Path(temporary.name) / "assets"))
    for name in ("old", "new"):
        store.create_version(name, name, {("place", "board"): {"modules": []}, ("machine", "settings"): {}})
    store.set_active("old")
    live = {name: {"transition_id": "", "state": "running", "revision": "old"} for name in ("old-board", "new-board", "gateway", "detection")}
    calls, fault = [], {"stop": set(), "load": {"detection"}, "start": set()}

    def participants(profile, previous):
        entities = store.effective(profile)["entities"]
        board = entities.get("binding", {}).get("board", {}).get("body", {}).get("device_id", profile + "-board")
        return [{"id": name, "base": "http://" + name, "modules": [name] if name in ("gateway", "detection") else ["cameras", "neural", "surround"],
                 "package": {"revision": profile + ":" + name + ":" + entities.get("layout", {}).get("fix", {}).get("body", {}).get("value", "original")}}
                for name in (board, "gateway", "detection")]

    def handle(request):
        name, path = request.url.host, request.url.path
        body = json.loads(request.content) if request.content else {}
        recorded = copy.deepcopy(body)
        if path.endswith(("/start", "/stop")):
            recorded["action"] = path.rsplit("/", 1)[1]
        calls.append((name, path, recorded))
        state = live[name]
        if name not in ("gateway", "detection"):
            state.setdefault("held", False)
            state.setdefault("modules", [])
            state.setdefault("module_states", {module: state["state"] for module in ("cameras", "neural", "surround")})
            if path == "/config/hold":
                if request.method == "PUT":
                    if body["held"]:
                        assert body["previous_transition_id"] == state["transition_id"]
                        state.update(held=True, transition_id=body["transition_id"])
                    else:
                        assert all(state["module_states"][module] == "running" for module in body["modules"])
                        state.update(held=False, modules=body["modules"])
                return httpx.Response(200, json={"data": {**state, "available": list(state["module_states"])}})
            if path.endswith(("/start", "/stop")):
                module = {"camera": "cameras", "neural": "neural", "linker": "surround"}[path.split("/")[1]]
                action = path.rsplit("/", 1)[1]
                if name in fault[action]:
                    return httpx.Response(503, json={"error": "injected " + action + " failure"})
                assert state["held"] and body["transition_id"] == state["transition_id"]
                if action == "start":
                    assert body["revision"] == state["revision"]
                value = "stopped" if action == "stop" else "running"
                state["module_states"][module] = value
                state["state"] = "stopped" if all(value == "stopped" for value in state["module_states"].values()) else "running"
                return httpx.Response(200, json={"data": {"state": value, "transition_id": state["transition_id"], "revision": state["revision"]}})
        if request.method == "GET":
            return httpx.Response(200, json={"data": state})
        action = body.get("action", "load")
        if name in fault[action]:
            return httpx.Response(503, json={"error": "injected " + action + " failure"})
        if action == "stop":
            assert body["previous_transition_id"] == state["transition_id"]
            assert body["transition_id"] != state["transition_id"] or state["state"] == "stopped"
            state.update(transition_id=body["transition_id"], state="stopped")
        elif action == "load":
            assert state["state"] == "stopped" and body["transition_id"] == state["transition_id"]
            assert all(value["state"] == "stopped" for value in live.values())
            state["revision"] = body["revision"]
        else:
            assert body["revision"] == state["revision"] and body["transition_id"] == state["transition_id"]
            state["state"] = "running"
        return httpx.Response(200, json={"data": state})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handle))

    def controller():
        result = ProfileLifecycle(lambda: store)
        result._client = client
        result._participants = participants
        return result

    lifecycle = controller()
    lifecycle._participants = lambda profile, previous: participants(profile, previous) + [
        {"id": "old-board", "base": "http://old-board", "modules": [], "package": None}]
    first = await lifecycle.switch("new")
    await lifecycle.advance()
    assert lifecycle.status()["phase"] == "loading" and lifecycle.status()["error"]
    assert lifecycle.status()["previous_profile_id"] == "old"
    assert all(value["state"] == "stopped" for value in live.values())
    blocked(store.put, "new", "layout", "fix", {"value": "fixed"})
    lifecycle = controller()
    repair = await lifecycle.repair(first["id"])
    assert repair["id"] != first["id"] and repair["phase"] == "stopping"
    fault["stop"].add("new-board")
    await lifecycle.advance()
    blocked(store.put, "new", "layout", "fix", {"value": "fixed"})
    assert lifecycle.status()["phase"] == "stopping"
    fault["stop"].clear()
    await lifecycle.advance()
    assert lifecycle.status()["phase"] == "repairing" and store.active_profile() == "new"
    count = len(calls)
    store.put("new", "layout", "fix", {"value": "fixed"})
    store.put("new", "binding", "board", {"device_id": "replacement-board"})
    live["replacement-board"] = {"transition_id": "", "state": "running", "revision": "unrelated"}
    store.remove("new", "layout", "fix")
    store.put("new", "layout", "fix", {"value": "fixed"})
    blocked(store.put, "old", "layout", "fix", {"value": "wrong-profile"})
    blocked(store.select_version, "new", store.profile("new")["version_id"])
    blocked(store.create_version, "new", "new", {})
    with patch.object(config_sync, "get_store", lambda: store):
        sync = ConfigSync()
        assert await sync.push_checked() is None
    lifecycle = controller()
    await lifecycle.advance()
    assert lifecycle.status()["phase"] == "repairing" and len(calls) == count
    try:
        await lifecycle.retry(first["id"])
        raise AssertionError("Stale recovery accepted")
    except ConfigError:
        pass
    retry = await lifecycle.retry(repair["id"])
    assert retry["id"] not in (first["id"], repair["id"])
    assert {item["id"] for item in retry["participants"]} == set(live)
    blocked(store.put, "new", "layout", "fix", {"value": "racing"})
    fault["load"].clear()
    await lifecycle.advance()
    assert lifecycle.status()["phase"] == "complete"
    assert live["old-board"]["state"] == "stopped"
    assert all(live[name]["revision"].endswith(":fixed") for name in ("replacement-board", "gateway", "detection"))
    assert live["new-board"]["state"] == "stopped"
    for name in live:
        stops = [body for who, _, body in calls if who == name and body.get("action") == "stop"]
        assert any(body["transition_id"] == retry["id"] for body in stops)
    fault["start"].add("detection")
    attempt = await lifecycle.switch("new")
    await lifecycle.advance()
    assert lifecycle.status()["phase"] == "starting" and live["gateway"]["state"] == "running"
    fault["start"].clear()
    repair = await lifecycle.repair(attempt["id"])
    await lifecycle.advance()
    store.put("new", "layout", "fix", None)
    try:
        await lifecycle.retry(repair["id"])
        raise AssertionError("Malformed target accepted")
    except ConfigError:
        pass
    assert lifecycle.status()["phase"] == "repairing"
    restored = await lifecycle.retry(repair["id"], "old")
    await lifecycle.advance()
    assert lifecycle.status()["phase"] == "complete" and store.active_profile() == "old"
    assert live["new-board"]["state"] == "stopped"
    assert all(live[name]["state"] == "running" for name in ("old-board", "gateway", "detection"))
    assert live["replacement-board"]["state"] == "stopped"
    assert all(any(who == name and body.get("action") == "stop" and body["transition_id"] == restored["id"]
                   for who, _, body in calls) for name in ("old-board", "replacement-board", "gateway", "detection"))
    try:
        await lifecycle.retry(restored["id"])
        raise AssertionError("Completed transition retried by stale control")
    except ConfigError:
        pass
    await client.aclose()
    store.close()
    print("recovery-check: OK")


asyncio.run(main())
