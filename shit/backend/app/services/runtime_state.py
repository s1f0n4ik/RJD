import asyncio
import logging
import time
import uuid

from app.config import settings
from app.services.config_store import ConfigStore, digest, get_store
from app.services.config_sync import build_packages, sync
from app.services.devices import registry
from app.services.lifecycle import lifecycle

logger = logging.getLogger(__name__)
POLL_S = 2.0
TRANSITION_POLL_S = 1.0
# Сколько снимок собирается без запросов от клиентов
IDLE_S = 60.0
READ_TIMEOUT_S = 3.0
# После перехода профиля или возвращения платы незапущенное ещё считается запускающимся
STARTING_GRACE_S = 30.0
STREAM_RUNNING = 3
# Код ошибки потока из media-center (signaling_definers.h, 3xxx) → код и пояснение вердикта
STREAM_FAULTS = {
    3001: ("rtsp_timeout", "Camera did not answer in time"),
    3002: ("rtsp_not_found", "Camera has no such stream"),
    3003: ("rtsp_auth", "Camera rejected the login or password"),
    3004: ("rtsp_disconnected", "Connection to the camera was lost"),
    3005: ("rtsp_error", "Stream pipeline error"),
    3006: ("rtsp_error", "Stream ended"),
    3007: ("rtsp_unreachable", "Camera does not answer at this address"),
}
# Камера ответила отказом: ждать запуска нечего, льгота не нужна
STREAM_FAULTS_FINAL = {"rtsp_auth", "rtsp_not_found"}


# Что должно работать по действующему профилю: устройство → камеры с потоками, слоты, выход 360
def expected_plan(store: ConfigStore) -> dict[str, dict]:
    effective = store.effective()
    if not effective["profile"]:
        return {}
    bodies = {kind: {key: item["body"] for key, item in items.items()} for kind, items in effective["entities"].items()}
    plan: dict[str, dict] = {}
    for place, binding in bodies.get("binding", {}).items():
        device_id = (binding or {}).get("device_id")
        if not device_id or place not in bodies.get("place", {}):
            continue
        modules = bodies["place"][place].get("modules") or []
        cameras = {
            key: [stream for stream, body in (camera.get("streams") or {}).items() if body.get("purposes")]
            for key, camera in bodies.get("camera", {}).items() if camera.get("place") == place
        }
        slots = [
            f"{slot.get('stream_id')}|{slot.get('config_id')}"
            for slot in bodies.get("neural_slot", {}).values() if slot.get("place") == place
        ] if "neural" in modules else []
        output = bodies.get("surround_output", {}).get(place) or {}
        plan[device_id] = {"place": place, "cameras": cameras, "slots": slots,
                           "surround": (output.get("active") or None) if "birdview" in modules else None}
    return plan


async def _read(device: dict, path: str):
    response = await registry.client.get(f"http://{device['ip']}:{settings.DEVICE_MC_PORT}{path}", timeout=READ_TIMEOUT_S)
    if response.status_code == 404:
        return None
    response.raise_for_status()
    body = response.json()
    return body.get("data", body) if isinstance(body, dict) else body


def _item(kind: str, item_id: str, ok: bool, grace: bool, code: str, detail: str = "", stream: str | None = None) -> dict:
    state = "running" if ok else "starting" if grace else "failed"
    return {"kind": kind, "id": item_id, "stream": stream, "state": state, "code": None if ok else code, "detail": "" if ok else detail}


class RuntimeState:
    def __init__(self):
        self._boot = uuid.uuid4().hex
        self._seq = 0
        self._digest = ""
        self._snapshot: dict | None = None
        self._changed = asyncio.Event()
        self._poke = asyncio.Event()
        self._build_lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._asked = 0.0
        self._online_at: dict[str, float | None] = {}

    async def wait(self, boot: str | None, since: int | None, timeout: float) -> dict:
        self._asked = time.monotonic()
        if not self._task:
            self._task = asyncio.create_task(self._run())
        if self._snapshot is None:
            await self.refresh()
        if timeout > 0 and boot == self._boot and since == self._seq:
            changed = self._changed
            try:
                await asyncio.wait_for(changed.wait(), timeout)
            except asyncio.TimeoutError:
                pass
        return self._snapshot

    async def _run(self) -> None:
        try:
            while time.monotonic() - self._asked < IDLE_S:
                try:
                    await self.refresh()
                except Exception:
                    logger.exception("Runtime state refresh failed")
                busy = bool(self._snapshot and self._snapshot["transition"] and self._snapshot["transition"]["phase"] != "complete")
                try:
                    await asyncio.wait_for(self._poke.wait(), TRANSITION_POLL_S if busy else POLL_S)
                except asyncio.TimeoutError:
                    pass
                self._poke.clear()
        finally:
            self._task = None

    async def refresh(self) -> None:
        async with self._build_lock:
            snapshot = await self._build()
            content = digest({**snapshot, "observed_at": None, "seq": None,
                              "devices": [{**device, "observed_at": None} for device in snapshot["devices"]]})
            if content != self._digest:
                self._digest = content
                self._seq += 1
                previous, self._changed = self._changed, asyncio.Event()
                snapshot["seq"] = self._seq
                self._snapshot = snapshot
                previous.set()
            else:
                self._snapshot = {**snapshot, "seq": self._seq}

    async def _build(self) -> dict:
        store = get_store()
        now = time.time()
        transition = lifecycle.status()
        snapshot = {"boot": self._boot, "seq": self._seq, "observed_at": now, "context": store.context(),
                    "transition": transition, "deliveries": sync.status(), "devices": [], "summary": None}
        if transition and transition["phase"] != "complete":
            snapshot["summary"] = {"state": "transition", "problems": []}
            return snapshot
        plan = expected_plan(store)
        packages = build_packages(store)
        settled = (transition or {}).get("updated") or 0.0
        snapshot["devices"] = list(await asyncio.gather(*(
            self._observe(device_id, item, (packages.get(device_id) or {}).get("package", {}).get("revision"), settled, now)
            for device_id, item in sorted(plan.items())
        )))
        snapshot["summary"] = self._summarize(snapshot["devices"])
        return snapshot

    async def _observe(self, device_id: str, plan: dict, revision: str | None, settled: float, now: float) -> dict:
        entry = {"id": device_id, "place": plan["place"], "online": False, "observed_at": now, "error": None,
                 "revision": None, "expected_revision": revision, "held": None, "items": []}
        device = registry.get(device_id)
        info = registry.snapshot_one(device_id)
        if not device or not info or info["status"] != "online":
            self._online_at[device_id] = None
            entry["error"] = "offline"
            return entry
        if device_id not in self._online_at:
            self._online_at[device_id] = 0.0
        elif self._online_at[device_id] is None:
            self._online_at[device_id] = now
        grace = now - max(settled, self._online_at[device_id] or 0.0) < STARTING_GRACE_S
        paths = ["/system/info", "/config/hold", "/camera"] + (["/neural/status"] if plan["slots"] else []) + (["/linker/status"] if plan["surround"] else [])
        results = dict(zip(paths, await asyncio.gather(*(_read(device, path) for path in paths), return_exceptions=True)))
        failed = {path: result for path, result in results.items() if isinstance(result, Exception)}
        if "/config/hold" in failed or "/system/info" in failed:
            entry["error"] = "unreachable"
            return entry
        entry["online"] = True
        entry["revision"] = (results["/system/info"] or {}).get("config_revision")
        entry["held"] = bool((results["/config/hold"] or {}).get("held"))
        boards = ((results["/camera"] if "/camera" not in failed else None) or {}).get("cameras") or {}
        for camera_id, streams in plan["cameras"].items():
            if "/camera" in failed:
                entry["items"].append(_item("camera", camera_id, False, False, "unreadable", "Cannot read cameras from the board"))
                continue
            board = (boards.get(camera_id) or {}).get("streams") or {}
            for stream in streams:
                if stream not in board:
                    entry["items"].append(_item("camera", camera_id, False, grace, "missing", "Not on the board", stream))
                else:
                    ok = board[stream].get("status") == STREAM_RUNNING
                    code, detail = "not_running", f"Stream status {board[stream].get('status')}"
                    # Старая плата поля error не присылает: тогда остаётся общий not_running
                    fault = STREAM_FAULTS.get((board[stream].get("error") or {}).get("code"))
                    if fault:
                        code, detail = fault
                    entry["items"].append(_item("camera", camera_id, ok, grace and code not in STREAM_FAULTS_FINAL, code, detail, stream))
        if plan["slots"]:
            slots = results.get("/neural/status")
            by_id = {f"{slot.get('stream_id')}|{slot.get('config_id')}": slot for slot in slots or []}
            for slot_id in plan["slots"]:
                slot = by_id.get(slot_id)
                if "/neural/status" in failed or slots is None:
                    entry["items"].append(_item("slot", slot_id, False, False, "unreadable", "Cannot read neural status from the board"))
                elif not slot:
                    entry["items"].append(_item("slot", slot_id, False, grace, "missing", "Not on the board"))
                elif slot.get("running"):
                    entry["items"].append(_item("slot", slot_id, True, grace, ""))
                elif slot.get("code"):
                    entry["items"].append(_item("slot", slot_id, False, False, "slot_error", str(slot.get("error") or slot.get("code"))))
                else:
                    entry["items"].append(_item("slot", slot_id, False, grace, "not_running", "Slot is not running"))
        if plan["surround"]:
            status = results.get("/linker/status")
            ok = isinstance(status, dict) and bool(status.get("running")) and status.get("export_id") == plan["surround"]
            entry["items"].append(_item("surround", plan["surround"], ok, grace and "/linker/status" not in failed, "not_running", "360 output is not running"))
        return entry

    @staticmethod
    def _summarize(devices: list[dict]) -> dict:
        problems = []
        applying = False
        for device in devices:
            if device["error"]:
                problems.append({"device": device["id"], "kind": "device", "id": device["id"], "state": "unknown", "code": device["error"], "detail": ""})
                continue
            if device["held"]:
                problems.append({"device": device["id"], "kind": "device", "id": device["id"], "state": "failed", "code": "held", "detail": ""})
            if device["expected_revision"] and device["revision"] != device["expected_revision"]:
                applying = True
                problems.append({"device": device["id"], "kind": "device", "id": device["id"], "state": "starting", "code": "revision", "detail": ""})
            problems.extend({"device": device["id"], **item} for item in device["items"] if item["state"] != "running")
        states = {problem["state"] for problem in problems}
        state = ("unknown" if "unknown" in states else "issues" if "failed" in states
                 else "starting" if applying or "starting" in states else "ok" if devices else "empty")
        return {"state": state, "problems": problems}

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass


runtime_state = RuntimeState()
