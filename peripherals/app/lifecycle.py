from __future__ import annotations

import asyncio
import copy
from typing import Any

from app.registry import Registry


class Lifecycle:
    def __init__(self, registry: Registry):
        self.registry = registry
        self.lock = asyncio.Lock()
        self.state: dict[str, Any] = {
            "transition_id": "",
            "state": "running",
            "revision": "",
            "modules": ["peripherals"],
        }
        self.package: dict[str, Any] = {"active": "", "devices": {}}

    def status(self) -> dict[str, Any]:
        return copy.deepcopy(self.state)

    async def stop(self, body: dict[str, Any]) -> dict[str, Any]:
        token = body.get("transition_id")
        modules = body.get("modules", [])
        if not isinstance(token, str) or not token or len(token) > 128:
            raise ValueError("Invalid transition_id")
        if not isinstance(modules, list) or any(module != "peripherals" for module in modules):
            raise ValueError("Invalid peripherals modules")
        current = self.state["transition_id"]
        if token != current and body.get("previous_transition_id", "") != current:
            raise ValueError("Stale transition control")
        self.state.update(transition_id=token, state="stopping", modules=modules)
        await self.registry.stop()
        self.state["state"] = "stopped"
        return self.status()

    async def apply(self, body: dict[str, Any]) -> dict[str, Any]:
        revision = body.get("revision")
        if not isinstance(revision, str) or not revision:
            raise ValueError("Missing revision")
        if body.get("transition_id", "") != self.state["transition_id"]:
            raise ValueError("Transition mismatch")
        if self.state["state"] not in ("stopped", "running"):
            raise ValueError("Peripherals is not ready to load")
        active = body.get("active", "")
        devices = body.get("devices", {})
        if not isinstance(active, str) or not isinstance(devices, dict):
            raise ValueError("Invalid peripherals package")  # noqa: TRY004 - API возвращает единый HTTP 409
        await self.registry.configure(devices if active == "kgf" else {})
        self.package = {"active": active, "devices": copy.deepcopy(devices)}
        self.state["revision"] = revision
        return self.status()

    async def start(self, body: dict[str, Any]) -> dict[str, Any]:
        if body.get("transition_id") != self.state["transition_id"]:
            raise ValueError("Transition mismatch")
        if body.get("revision") != self.state["revision"]:
            raise ValueError("Revision mismatch")
        if self.state["state"] not in ("stopped", "running"):
            raise ValueError("Peripherals is not ready to start")
        if "peripherals" in self.state["modules"] and self.package["active"] == "kgf":
            await self.registry.start()
        self.state["state"] = "running"
        return self.status()
