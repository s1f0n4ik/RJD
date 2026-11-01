import asyncio
import copy
import logging
import time
import uuid
from typing import Callable

import httpx

from app.config import settings
from app.services.config_store import ConfigError, ConfigStore, get_store
from app.services.config_sync import build_packages, build_service_packages, executor_error, sync
from app.services.devices import registry

logger = logging.getLogger(__name__)
BOARD_MODULES = {"cameras": "/camera", "neural": "/neural", "surround": "/linker"}


class ProfileLifecycle:
    def __init__(self, store: Callable[[], ConfigStore] = get_store):
        self._store = store
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._client: httpx.AsyncClient | None = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(180, connect=3))
        return self._client

    def status(self) -> dict | None:
        state = self._store().profile_transition()
        if not state:
            return None
        return {key: state.get(key) for key in ("id", "profile_id", "previous_profile_id", "previous_profile_name", "phase", "mode", "error", "updated")} | {
            "participants": [{key: item.get(key) for key in ("id", "stopped", "loaded", "started", "error")} for item in state["participants"]],
        }

    def _save(self, state: dict) -> None:
        state["updated"] = time.time()
        self._store().save_profile_transition(state)

    def _participants(self, profile_id: str, previous: dict) -> list[dict]:
        store = self._store()
        target = build_packages(store, profile_id)
        result = []
        for device_id in sorted(previous.keys() | target.keys()):
            device = registry.get(device_id)
            if not device:
                raise ConfigError(f"Device {device_id} is not registered")
            entry = target.get(device_id)
            package = entry["package"] if entry else None
            modules = ["cameras"] if entry else []
            if package:
                modules += [name for name in ("neural", "surround") if name in package["parts"]]
            result.append({"id": device_id, "base": f"http://{device['ip']}:{settings.DEVICE_MC_PORT}",
                           "package": package, "modules": modules})
        for name, package in build_service_packages(store, profile_id).items():
            if package["active"] and package["active"] not in store.effective(profile_id)["entities"].get("integration", {}):
                raise ConfigError(f"Active integration {package['active']} is missing")
            base = settings.GATEWAY_URL if name == "gateway" else settings.DETECTION_URL
            result.append({"id": name, "base": base.rstrip("/"), "package": package,
                           "modules": [name] if package["active"] else []})
        return result

    async def switch(self, profile_id: str, integration_id: str | None = None, edit: Callable[[], None] | None = None,
                     expected_transition_id: str | None = None) -> dict:
        async with self._lock:
            store = self._store()
            current = store.profile_transition()
            recovering = bool(current and current["phase"] != "complete" and (current["phase"] == "repairing" or current.get("error")))
            if expected_transition_id and (not current or current["id"] != expected_transition_id or not recovering):
                raise ConfigError("The failed profile transition has changed")
            if current and current["phase"] != "complete" and not recovering:
                if current["profile_id"] != profile_id or edit or integration_id is not None:
                    raise ConfigError("Another profile transition is in progress")
                return self.status()
            if recovering and (edit or integration_id is not None) and not store.is_repairing(profile_id):
                raise ConfigError("Stop modules for passport repair before editing the failed target")
            if sync._inflight:
                raise ConfigError("Configuration delivery is still in progress")
            store.profile(profile_id)
            with store.transaction():
                previous = build_packages(store) if store.active_profile() and not recovering else {}
                previous_profile_id = current.get("previous_profile_id") if recovering else store.active_profile()
                previous_profile_name = current.get("previous_profile_name") if recovering else (
                    store.profile(previous_profile_id)["name"] if previous_profile_id else None)
                if edit:
                    edit()
                if integration_id is not None:
                    entities = store.effective(profile_id)["entities"]
                    if integration_id not in entities.get("integration", {}):
                        raise ConfigError(f"Unknown integration {integration_id}")
                    machine = copy.deepcopy(entities.get("machine", {}).get("settings", {}).get("body") or {})
                    machine["active_integration"] = integration_id
                    store.put(profile_id, "machine", "settings", machine)
                try:
                    participants = self._participants(profile_id, previous)
                except (AttributeError, KeyError, TypeError, ValueError) as error:
                    raise ConfigError(f"Cannot build configuration packages: {error}") from error
                if recovering:
                    included = {item["id"] for item in participants}
                    participants.extend({"id": item["id"], "base": item["base"], "package": None, "modules": []}
                                        for item in current["participants"] if item["id"] not in included)
                state = {"id": uuid.uuid4().hex, "profile_id": profile_id, "phase": "stopping", "mode": "switch", "error": None,
                         "previous_profile_id": previous_profile_id, "previous_profile_name": previous_profile_name,
                         "participants": [{**item, "stopped": False, "loaded": False, "started": False, "error": None}
                                          for item in participants]}
                self._save(state)
        self._wake.set()
        return self.status()

    async def repair(self, transition_id: str) -> dict:
        async with self._lock:
            current = self._store().profile_transition()
            if not current or current["id"] != transition_id or current["phase"] == "complete":
                raise ConfigError("The failed profile transition has changed")
            if current.get("mode") == "repair":
                return self.status()
            if not current.get("error"):
                raise ConfigError("The profile transition has not failed")
            state = copy.deepcopy(current)
            state.update(id=uuid.uuid4().hex, phase="stopping", mode="repair", error=None)
            for item in state["participants"]:
                item.update(stopped=False, loaded=False, started=False, error=None)
            self._save(state)
        self._wake.set()
        return self.status()

    async def retry(self, transition_id: str, profile_id: str | None = None) -> dict:
        current = self._store().profile_transition()
        if not current:
            raise ConfigError("No profile transition to recover")
        return await self.switch(profile_id or current["profile_id"], expected_transition_id=transition_id)

    async def _command(self, state: dict, item: dict, action: str) -> None:
        if item["id"] not in ("gateway", "detection"):
            await self._board_command(state, item, action)
            return
        body = {"transition_id": state["id"], "action": action, "modules": item["modules"],
                "revision": (item["package"] or {}).get("revision", "")}
        if action == "stop":
            current = await self.client.get(item["base"] + "/runtime")
            current.raise_for_status()
            current = current.json().get("data", current.json())
            body["previous_transition_id"] = current.get("transition_id", "")
        response = await self.client.put(item["base"] + "/runtime", json=body)
        if response.is_error:
            raise RuntimeError(f"{item['id']} {action}: {executor_error(response)}")
        result = response.json().get("data", response.json())
        expected = "stopped" if action == "stop" else "running"
        if result.get("transition_id") != state["id"] or result.get("state") != expected:
            raise RuntimeError(f"{item['id']} did not confirm {expected}")
        if action == "start" and item["package"] and result.get("revision") != item["package"]["revision"]:
            raise RuntimeError(f"{item['id']} started with an unexpected revision")

    async def _board_command(self, state: dict, item: dict, action: str) -> None:
        response = await self.client.get(item["base"] + "/config/hold")
        response.raise_for_status()
        current = response.json()["data"]
        revision = (item["package"] or {}).get("revision", "")
        body = {"transition_id": state["id"], "revision": revision}
        errors = []
        if action == "stop":
            try:
                response = await self.client.put(item["base"] + "/config/hold", json={
                    **body, "held": True, "previous_transition_id": current["transition_id"]})
                if response.is_error:
                    raise RuntimeError(executor_error(response))
                if response.json()["data"].get("transition_id") != state["id"] or response.json()["data"].get("held") is not True:
                    raise RuntimeError("Configuration hold was not confirmed")
            except Exception as error:
                errors.append(f"hold: {error}")
            modules = current["available"]
        else:
            if current["transition_id"] != state["id"] or current["revision"] != revision:
                raise RuntimeError(f"{item['id']} start belongs to another configuration")
            if not current["held"]:
                if current["modules"] != item["modules"]:
                    raise RuntimeError(f"{item['id']} started with unexpected modules")
                return
            modules = item["modules"]
        if any(module not in BOARD_MODULES for module in modules) or (action == "stop" and "cameras" not in modules):
            if action == "start":
                raise RuntimeError(f"{item['id']} reports unsupported modules")
            errors.append("Unsupported or missing board modules")
        order = list(BOARD_MODULES) if action == "start" else list(reversed(BOARD_MODULES))
        for module in order:
            if module not in modules:
                continue
            try:
                response = await self.client.post(item["base"] + BOARD_MODULES[module] + "/" + action, json=body)
                if response.is_error:
                    raise RuntimeError(executor_error(response))
                result = response.json()["data"]
                expected = "running" if action == "start" else "stopped"
                if result.get("transition_id") != state["id"] or result.get("state") != expected:
                    raise RuntimeError(f"Did not confirm {expected}")
                if action == "start" and result.get("revision") != revision:
                    raise RuntimeError("Started with an unexpected revision")
            except Exception as error:
                errors.append(f"{module}: {error}")
                if action == "start":
                    break
        if errors:
            raise RuntimeError(f"{item['id']} {action}: " + "; ".join(errors))
        if action == "start":
            response = await self.client.put(item["base"] + "/config/hold", json={**body, "held": False, "modules": modules})
            if response.is_error:
                raise RuntimeError(f"{item['id']} release: {executor_error(response)}")
            result = response.json()["data"]
            if result.get("transition_id") != state["id"] or result.get("held") is not False or result.get("revision") != revision:
                raise RuntimeError(f"{item['id']} did not confirm release")

    async def _load(self, state: dict, item: dict) -> None:
        if not item["package"]:
            return
        body = {**item["package"], "transition_id": state["id"]}
        response = await self.client.put(item["base"] + "/config", json=body)
        if response.status_code == 409:
            for sha in response.json().get("missing_assets", []):
                with self._store().asset_path(sha).open("rb") as source:
                    uploaded = await self.client.put(item["base"] + "/config/assets", params={"sha256": sha}, content=source.read())
                uploaded.raise_for_status()
            response = await self.client.put(item["base"] + "/config", json=body)
        if response.is_error:
            raise RuntimeError(f"{item['id']} loading: {executor_error(response)}")
        service = item["id"] in ("gateway", "detection")
        confirmed = await self.client.get(item["base"] + ("/runtime" if service else "/config/hold"))
        confirmed.raise_for_status()
        result = confirmed.json().get("data", confirmed.json())
        stopped = result.get("state") == "stopped" if service else result.get("held") is True
        if not stopped or result.get("transition_id") != state["id"] or result.get("revision") != body["revision"]:
            raise RuntimeError(f"{item['id']} did not confirm loading while stopped")

    async def advance(self) -> None:
        async with self._lock:
            state = self._store().profile_transition()
            if not state or state["phase"] in ("complete", "repairing"):
                return
            try:
                if state["phase"] == "stopping":
                    async def stop(item):
                        if item["stopped"]:
                            return
                        try:
                            await self._command(state, item, "stop")
                            item.update(stopped=True, error=None)
                        except Exception as error:
                            item["error"] = str(error)
                    await asyncio.gather(*(stop(item) for item in state["participants"]))
                    if not all(item["stopped"] for item in state["participants"]):
                        raise RuntimeError("Not all participants have stopped")
                    if state.get("mode") == "repair":
                        with self._store().transaction():
                            self._store().set_active(state["profile_id"])
                            state.update(phase="repairing", error=None)
                            self._save(state)
                        return
                    state["phase"] = "loading"
                    self._save(state)
                if state["phase"] == "loading":
                    self._store().set_active(state["profile_id"])
                    for item in state["participants"]:
                        if not item["loaded"]:
                            await self._load(state, item)
                            item.update(loaded=True, error=None)
                            self._save(state)
                    state["phase"] = "starting"
                    self._save(state)
                if state["phase"] == "starting":
                    order = {"gateway": 0, "detection": 1}
                    for item in sorted(state["participants"], key=lambda item: order.get(item["id"], 2)):
                        if not item["started"]:
                            if item["modules"]:
                                await self._command(state, item, "start")
                            item.update(started=True, error=None)
                            self._save(state)
                    state["phase"] = "complete"
                state["error"] = None
            except Exception as error:
                state["error"] = str(error)
                logger.error("Profile transition %s failed in %s: %s", state["id"], state["phase"], error)
            self._save(state)

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while True:
            try:
                await self.advance()
            except Exception:
                logger.exception("Profile transition recovery failed")
            try:
                await asyncio.wait_for(self._wake.wait(), 5)
            except asyncio.TimeoutError:
                pass
            self._wake.clear()

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._client:
            await self._client.aclose()


lifecycle = ProfileLifecycle()
