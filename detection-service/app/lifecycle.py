import copy
import json
import logging
import os
from pathlib import Path

from app.master import RULES, Master

logger = logging.getLogger(__name__)


class Lifecycle:
    def __init__(self, master: Master, path: Path):
        self.master = master
        self.path = path
        self.state = {"transition_id": "", "state": "running", "revision": "", "modules": ["detection"]}
        self.managed = False

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as target:
            json.dump(self.state, target, ensure_ascii=False)
            target.flush()
            os.fsync(target.fileno())
        tmp.replace(self.path)
        directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def status(self) -> dict:
        return {key: copy.deepcopy(self.state[key]) for key in ("transition_id", "state", "revision", "modules")}

    def restore(self) -> None:
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError):
            self.managed = True
            self.master.pause()
            self.state["state"] = "stopping"
            return
        self.master.outbox.enabled = False
        if not isinstance(saved, dict) or saved.get("state") not in ("running", "starting", "stopped", "stopping") \
                or not isinstance(saved.get("transition_id"), str) or not isinstance(saved.get("revision"), str) \
                or not isinstance(saved.get("modules"), list) or any(module != "detection" for module in saved["modules"]):
            self.managed = True
            self.master.pause()
            self.state["state"] = "stopping"
            return
        self.managed = True
        self.state = saved
        self.master.outbox.runtime_id = saved["transition_id"]
        pending = saved.get("pending") or saved.get("package")
        if pending:
            try:
                self._apply(pending)
            except Exception:
                self.master.pause()
                self.state["state"] = "stopping"
                logger.exception("Detection configuration recovery failed")
                return
        self.master.outbox.enabled = self.state["state"] == "running" and "detection" in self.state["modules"] and bool(self.master.active)

    def stop(self, body: dict) -> None:
        token = body.get("transition_id")
        if not isinstance(token, str) or not token or len(token) > 128:
            raise ValueError("Invalid transition_id")
        modules = body.get("modules", [])
        if not isinstance(modules, list) or any(module != "detection" for module in modules):
            raise ValueError("Invalid detection modules")
        current = self.state["transition_id"]
        if token != current and body.get("previous_transition_id") != current:
            raise ValueError("Stale transition control")
        if token == current and self.managed and self.state["state"] in ("running", "starting"):
            raise ValueError("Transition has already started")
        self.master.pause()
        self.managed = True
        self.state.update(transition_id=token, state="stopping", modules=modules)
        self.master.outbox.runtime_id = token
        self._save()

    def stopped(self) -> dict:
        self.state["state"] = "stopped"
        self._save()
        return self.status()

    def start(self, body: dict) -> dict:
        if body.get("transition_id") != self.state["transition_id"] or body.get("revision") != self.state["revision"]:
            raise ValueError("Transition or revision mismatch")
        if self.state["state"] not in ("stopped", "starting", "running"):
            raise ValueError("Detection is not ready to start")
        if self.state["state"] != "running":
            self.master.pause()
            self.state["state"] = "running"
        self._save()
        self.master.outbox.enabled = "detection" in self.state["modules"] and bool(self.master.active)
        return self.status()

    def apply(self, body: dict) -> dict:
        if not isinstance(body.get("revision"), str) or not body["revision"]:
            raise ValueError("Missing revision")
        if body.get("transition_id", "") != self.state["transition_id"]:
            raise ValueError("Transition mismatch")
        if self.state["state"] not in ("stopped", "running"):
            raise ValueError("Detection is not ready to load")
        active = body.get("active", "")
        if active not in ("", *RULES):
            raise ValueError("Unknown active integration")
        source = body.get("rules")
        if not isinstance(source, dict) or source.keys() - RULES.keys():
            raise ValueError("Unknown detection rules")
        parsed = {key: rules.model.model_validate(source.get(key, {})).model_dump() for key, rules in RULES.items()}
        if self.state["state"] == "running" and self.master.active != active:
            raise ValueError("Integration change requires a profile transition")
        package = {"active": active, "rules": parsed, "revision": body["revision"]}
        self.managed = True
        if self.state.get("package") != package or self.state.get("pending"):
            self.state["pending"] = package
            self._save()
            self._apply(package)
        else:
            self._save()
        return self.status()

    def _apply(self, package: dict) -> None:
        for key, value in package["rules"].items():
            current = self.master.rules_settings(key)["settings"]
            if current != value:
                self.master.save_rules(key, value)
        self.master.set_active(package["active"])
        self.state.update(revision=package["revision"], package=package)
        self.state.pop("pending", None)
        self._save()
