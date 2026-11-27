from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.registry import Registry

logger = logging.getLogger(__name__)


class Lifecycle:
    def __init__(self, registry: Registry, state_file: str | None = None):
        self.registry = registry
        self.state_file = Path(state_file) if state_file else None
        self.lock = asyncio.Lock()
        self.state: dict[str, Any] = {
            "transition_id": "",
            "state": "running",
            "revision": "",
            "modules": ["peripherals"],
            "restored": False,
            "updated_at": None,
        }
        self.package: dict[str, Any] = {"active": "", "devices": {}}

    def status(self) -> dict[str, Any]:
        return copy.deepcopy(self.state)

    def _persist(self) -> None:
        if self.state_file is None:
            return
        self.state["updated_at"] = datetime.now(UTC).isoformat()
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_file.with_suffix(self.state_file.suffix + ".tmp")
        temporary.write_text(json.dumps({"state": self.state, "package": self.package}, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, self.state_file)

    async def restore(self) -> bool:
        if self.state_file is None or not self.state_file.exists():
            return False
        try:
            saved = json.loads(self.state_file.read_text(encoding="utf-8"))
            state = saved["state"]
            package = saved["package"]
            if not isinstance(state, dict) or not isinstance(package, dict):
                raise ValueError("invalid persisted peripherals state")
            devices = package.get("devices", {}) if package.get("active") == "kgf" else {}
            if not isinstance(devices, dict):
                raise ValueError("invalid persisted peripherals devices")
            await self.registry.configure(devices)
            self.package = copy.deepcopy(package)
            self.state.update({
                "transition_id": str(state.get("transition_id", "")),
                "state": str(state.get("state", "stopped")),
                "revision": str(state.get("revision", "")),
                "modules": list(state.get("modules", ["peripherals"])),
                "restored": True,
                "updated_at": state.get("updated_at"),
            })
            if self.state["state"] == "running" and self.package.get("active") == "kgf":
                await self.registry.start()
            logger.info("Restored peripherals revision %s with %s devices", self.state["revision"], len(devices))
            return True
        except Exception:  # noqa: BLE001 - повреждённое состояние не должно мешать запуску API
            logger.exception("Cannot restore peripherals state from %s", self.state_file)
            self.state.update(state="running", restored=False)
            return False

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
        self._persist()
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
        self._persist()
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
        self._persist()
        return self.status()
