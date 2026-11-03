import asyncio
import logging
import ipaddress
import math
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from app.services.config_bundle import export_profile, load_profile
from app.services.config_import import import_backups
from app.services.config_neural import zones_error
from app.services.config_store import KINDS, PASSPORT_ONLY, ConfigError, digest, get_store, nest
from app.services.config_sync import sync
from app.services.lifecycle import lifecycle
from app.routers.configurations import _master

router = APIRouter()
logger = logging.getLogger(__name__)

PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class EntityRef(BaseModel):
    kind: str
    key: str


class SelectVersion(BaseModel):
    version_id: int


class SetActive(BaseModel):
    profile_id: str


class RecoverTransition(BaseModel):
    transition_id: str
    profile_id: Optional[str] = None


class PassportChange(EntityRef):
    body: Optional[dict] = None
    reset: bool = False


class SavePassport(BaseModel):
    context: str
    revision: str
    changes: list[PassportChange]


def _library_snapshot(profile_id: str) -> dict:
    store = get_store()
    with store.transaction():
        effective = store.effective(profile_id)
        profile = store.profile(profile_id)
        base = nest(store.version_entities(profile["version_id"]))
        return {
            **effective, "base": base, "version": store.version(profile["version_id"]),
            "context": store.context(), "revision": digest({"base": base, "effective": effective}),
            "assets": store.assets(),
        }


def _fail(e: Exception) -> HTTPException:
    message = str(e)
    return HTTPException(status_code=404 if "not found" in message else 409, detail=message)


def _profile_or_active(profile_id: Optional[str]) -> str:
    profile_id = profile_id or get_store().active_profile()
    if not profile_id:
        raise HTTPException(status_code=409, detail="no active profile")
    return profile_id


def _check_kind(kind: str) -> None:
    if kind not in KINDS:
        raise HTTPException(status_code=400, detail=f"unknown kind {kind!r}")


def _spool(upload: UploadFile, folder: str) -> Path:
    path = Path(folder) / Path(upload.filename or "upload").name
    with open(path, "wb") as dst:
        shutil.copyfileobj(upload.file, dst, 1 << 20)
    return path


@router.get("/config/profiles")
def list_profiles():
    return {"active": get_store().active_profile(), "profiles": get_store().profiles()}


@router.get("/config/profiles/{profile_id}/workspace")
async def profile_workspace(profile_id: str):
    try:
        result = _library_snapshot(profile_id)
    except ConfigError as error:
        raise _fail(error)
    integrations = {
        result["entities"].get("machine", {}).get("settings", {}).get("body", {}).get("active_integration"),
        result["base"].get("machine", {}).get("settings", {}).get("active_integration"),
    } - {None, ""}

    async def defaults(integration):
        try:
            return integration, (await _master("GET", f"/rules/{integration}"))["defaults"]
        except HTTPException:
            return integration, None

    result["rules_defaults"] = {key: value for key, value in await asyncio.gather(*(defaults(key) for key in integrations)) if value is not None}
    return result


def _validate_passport_change(change: PassportChange, current: dict) -> None:
    body = change.body
    if change.reset:
        return
    if body is None:
        raise HTTPException(422, "Entity body must be an object")

    def number(value, low, high, integer=False):
        return type(value) in (int, float) and math.isfinite(value) and low <= value <= high and (not integer or type(value) is int)

    def object_field(source, key):
        value = source.get(key, {})
        if not isinstance(value, dict):
            raise HTTPException(422, f"{key} must be an object")
        return value

    if change.kind == "machine":
        if change.key == "settings":
            if body.get("active_integration") != current.get("active_integration"):
                raise HTTPException(409, "Use the profile lifecycle to change integration")
            if not number(body.get("tz_offset_min", 180), -720, 840, True):
                raise HTTPException(422, "tz_offset_min must be an integer in -720..840")
        elif change.key == "identity":
            if any(not isinstance(value, str) or len(value) > 256 for value in body.values()):
                raise HTTPException(422, "Machine identity fields must be strings up to 256 characters")
        else:
            raise HTTPException(422, "Unknown machine entity")
    elif change.kind == "camera":
        camera = object_field(body, "camera")
        object_field(body, "streams")
        try:
            ipaddress.IPv4Address(camera.get("ip_adress", ""))
        except ipaddress.AddressValueError:
            raise HTTPException(422, "Camera address must be IPv4")
        port = camera.get("port")
        if isinstance(port, str) and port.isascii() and port.isdigit():
            port = int(port)
        if not number(port, 1, 65535, True):
            raise HTTPException(422, "Camera port must be an integer in 1..65535")
    elif change.kind in ("video_stream", "neural_slot"):
        for key in ("width", "height") if change.kind == "video_stream" else ("fps",):
            if not number(body.get(key), 1, 16384 if key != "fps" else 240, key != "fps"):
                raise HTTPException(422, f"Invalid {change.kind}.{key}")
    elif change.kind == "neural_config":
        for key, value in object_field(body, "thresholds").items():
            if key in ("confidence", "nms") and not number(value, 0, 1):
                raise HTTPException(422, f"Invalid threshold {key}")
        tracker = body.get("tracker")
        current_tracker = current.get("tracker")
        supported = {"iou", "kalman_iou", current_tracker.get("type") if isinstance(current_tracker, dict) else None}
        if tracker is not None and (not isinstance(tracker, dict) or tracker.get("type") not in supported):
            raise HTTPException(422, "Unknown tracker type")
        if error := zones_error(body):
            raise HTTPException(422, error)
    elif change.kind == "surround_output":
        for config in object_field(body, "configs").values():
            if not isinstance(config, dict):
                raise HTTPException(422, "Output configuration must be an object")
            for key in ("fps", "width", "height"):
                if key in config and not number(config[key], 1, 240 if key == "fps" else 16384, key != "fps"):
                    raise HTTPException(422, f"Invalid surround output {key}")
    elif change.kind == "projection":
        for mode in ("top", "surround"):
            resolution = object_field(object_field(body, mode), "resolution")
            if any(not number(value, 1, 16384, True) for key, value in resolution.items() if key in ("width", "height")):
                raise HTTPException(422, "Invalid render resolution")
    elif change.kind == "binding":
        if not isinstance(body.get("device_id"), str):
            raise HTTPException(422, "Binding requires device_id")
    elif change.kind != "rules":
        raise HTTPException(422, "Entity is edited in its module")


@router.put("/config/profiles/{profile_id}/passport")
async def save_passport(profile_id: str, request: SavePassport):
    store = get_store()
    try:
        snapshot = _library_snapshot(profile_id)
        if request.context != snapshot["context"] or request.revision != snapshot["revision"]:
            raise HTTPException(409, "Profile or passport changed; reload before saving")
        seen = set()
        for change in request.changes:
            _check_kind(change.kind)
            ref = (change.kind, change.key)
            if ref in seen:
                raise HTTPException(422, "Duplicate entity change")
            seen.add(ref)
            current = snapshot["entities"].get(change.kind, {}).get(change.key, {}).get("body", {})
            _validate_passport_change(change, current)
            if change.kind == "rules" and not change.reset:
                if change.key not in snapshot["entities"].get("integration", {}):
                    raise HTTPException(422, "Unknown integration")
                change.body = await _master("POST", f"/rules/{change.key}/validate", change.body)
        with store.transaction():
            latest = _library_snapshot(profile_id)
            if request.context != latest["context"] or request.revision != latest["revision"]:
                raise HTTPException(409, "Profile or passport changed during validation; reload before saving")
            before = {(item["kind"], item["key"], item.get("field"), item.get("ref")) for item in latest["broken"]}
            for change in request.changes:
                if change.reset:
                    if change.kind == "machine" and change.key == "settings":
                        target = latest["base"].get("machine", {}).get("settings", {})
                        current = latest["entities"].get("machine", {}).get("settings", {}).get("body", {})
                        if target.get("active_integration") != current.get("active_integration"):
                            raise HTTPException(409, "Use the profile lifecycle to reset integration")
                    store.reset(profile_id, change.kind, change.key)
                else:
                    store.put(profile_id, change.kind, change.key, change.body)
            result = _library_snapshot(profile_id)
            for item in result["broken"]:
                ref = (item["kind"], item["key"], item.get("field"), item.get("ref"))
                if ref not in before:
                    raise HTTPException(422, f"New broken reference: {item}")
        error = await sync.push_checked() if profile_id == store.active_profile() and request.changes else None
        return {"snapshot": result, "application_error": error}
    except ConfigError as error:
        raise _fail(error)


@router.post("/config/import")
async def import_backup(
    files: list[UploadFile] = File(...),
    profile_id: str = Form(...),
    name: str = Form(...),
    activate: bool = Form(False),
):
    if not PROFILE_ID_RE.match(profile_id):
        raise HTTPException(status_code=400, detail="profile_id must match [a-z0-9][a-z0-9_-]{0,63}")
    store = get_store()
    with tempfile.TemporaryDirectory() as tmp:
        try:
            result = import_backups(store, [_spool(f, tmp) for f in files])
        except (ValueError, OSError) as e:
            raise HTTPException(status_code=400, detail=f"backup import failed: {e}")
    try:
        version = store.create_version(profile_id, name, result["entities"], label="резервная копия", select=False)

        def select_imported():
            store.select_version(profile_id, version["id"])
            for place, binding in result["bindings"].items():
                store.put(profile_id, "binding", place, binding)

        if activate or not store.active_profile() or store.active_profile() == profile_id:
            await lifecycle.switch(profile_id, edit=select_imported)
        else:
            with store.transaction():
                select_imported()
    except ConfigError as e:
        raise _fail(e)
    logger.info(f"Imported {len(result['entities'])} entities into {profile_id} v{version['number']}")
    return {
        "profile_id": profile_id, "version": version, "places": result["places"],
        "collisions": result["collisions"], "warnings": result["warnings"],
        "broken": store.effective(profile_id)["broken"],
    }


@router.get("/config/profiles/{profile_id}/export")
def export(profile_id: str, version_id: Optional[int] = Query(None)):
    try:
        path, filename = export_profile(get_store(), profile_id, version_id)
    except ConfigError as e:
        raise _fail(e)
    return FileResponse(
        path, filename=filename, media_type="application/zip",
        background=BackgroundTask(path.unlink, missing_ok=True),
    )


@router.post("/config/load")
async def load(file: UploadFile = File(...), activate: bool = Form(False)):
    store = get_store()
    with tempfile.TemporaryDirectory() as tmp:
        try:
            result = load_profile(store, _spool(file, tmp), select=False)
        except (ConfigError, ValueError, KeyError, OSError) as e:
            raise HTTPException(status_code=400, detail=f"profile load failed: {e}")
    profile_id = result["profile"]["id"]
    if activate or not store.active_profile() or store.active_profile() == profile_id:
        await lifecycle.switch(profile_id, edit=lambda: store.select_version(profile_id, result["version"]["id"]))
    else:
        store.select_version(profile_id, result["version"]["id"])
    return {**result, "broken": store.effective(result["profile"]["id"])["broken"]}


@router.post("/config/profiles/{profile_id}/select")
async def select_version(profile_id: str, body: SelectVersion):
    try:
        store = get_store()
        if store.active_profile() == profile_id:
            transition = await lifecycle.switch(profile_id, edit=lambda: store.select_version(profile_id, body.version_id))
            return {"ok": transition["phase"] == "complete", "transition": transition}
        store.select_version(profile_id, body.version_id)
    except ConfigError as e:
        raise _fail(e)
    return {"ok": True}


@router.post("/config/active")
async def set_active(body: SetActive):
    try:
        transition = await lifecycle.switch(body.profile_id)
    except ConfigError as e:
        raise _fail(e)
    return {"ok": transition["phase"] == "complete", "transition": transition}


@router.delete("/config/profiles/{profile_id}")
def delete_profile(profile_id: str):
    try:
        get_store().delete_profile(profile_id)
    except ConfigError as e:
        raise _fail(e)
    return {"ok": True}


@router.delete("/config/profiles/{profile_id}/versions/{version_id}")
def delete_version(profile_id: str, version_id: int):
    try:
        get_store().delete_version(profile_id, version_id)
    except ConfigError as e:
        raise _fail(e)
    return {"ok": True}


@router.get("/config/status")
def config_status():
    return {"devices": sync.status(), "transition": lifecycle.status(), "context": get_store().context()}


@router.post("/config/transition/repair")
async def repair_transition(body: RecoverTransition):
    try:
        return {"transition": await lifecycle.repair(body.transition_id)}
    except ConfigError as error:
        raise _fail(error)


@router.post("/config/transition/retry")
async def retry_transition(body: RecoverTransition):
    try:
        return {"transition": await lifecycle.retry(body.transition_id, body.profile_id)}
    except ConfigError as error:
        raise _fail(error)


@router.get("/config/effective")
def effective(profile_id: Optional[str] = Query(None)):
    try:
        return get_store().effective(profile_id)
    except ConfigError as e:
        raise _fail(e)


@router.put("/config/entities/{kind}/{key:path}")
async def put_entity(kind: str, key: str, body: Any = Body(...), profile_id: Optional[str] = Query(None)):
    _check_kind(kind)
    try:
        store = get_store()
        profile_id = _profile_or_active(profile_id)
        if kind == "machine" and key == "settings" and profile_id == store.active_profile() and not store.is_repairing(profile_id):
            current = store.effective()["entities"].get("machine", {}).get("settings", {}).get("body", {})
            if isinstance(body, dict) and current.get("active_integration") != body.get("active_integration"):
                transition = await lifecycle.switch(profile_id, edit=lambda: store.put(profile_id, kind, key, body))
                return {"state": "transition", "transition": transition}
        result = {"state": store.put(profile_id, kind, key, body)}
        if kind == "machine" and key == "settings" and profile_id == store.active_profile():
            error = await sync.push_checked()
            if error:
                raise HTTPException(502, f"Source saved; application failed: {error}")
        return result
    except ConfigError as e:
        raise _fail(e)


@router.delete("/config/entities/{kind}/{key:path}")
async def remove_entity(kind: str, key: str, profile_id: Optional[str] = Query(None)):
    _check_kind(kind)
    try:
        store = get_store()
        profile_id = _profile_or_active(profile_id)
        machine = store.effective(profile_id)["entities"].get("machine", {}).get("settings", {}).get("body", {})
        if kind == "integration" and key == machine.get("active_integration"):
            raise ConfigError("Select another integration before removing the active integration")
        if kind == "machine" and key == "settings" and profile_id == store.active_profile() and machine.get("active_integration") and not store.is_repairing(profile_id):
            transition = await lifecycle.switch(profile_id, edit=lambda: store.remove(profile_id, kind, key))
            return {"state": "transition", "transition": transition}
        return {"state": store.remove(profile_id, kind, key)}
    except ConfigError as e:
        raise _fail(e)


@router.post("/config/passport/reset")
async def reset_entity(ref: EntityRef, profile_id: Optional[str] = Query(None)):
    _check_kind(ref.kind)
    store = get_store()
    profile_id = _profile_or_active(profile_id)
    if ref.kind == "machine" and ref.key == "settings" and profile_id == store.active_profile() and not store.is_repairing(profile_id):
        current = store.effective()["entities"].get("machine", {}).get("settings", {}).get("body", {})
        target = store.version_entities(store.profile(profile_id)["version_id"]).get(("machine", "settings"), {})
        if current.get("active_integration") != target.get("active_integration"):
            transition = await lifecycle.switch(profile_id, edit=lambda: store.reset(profile_id, ref.kind, ref.key))
            return {"ok": transition["phase"] == "complete", "transition": transition}
    store.reset(profile_id, ref.kind, ref.key)
    if ref.kind == "machine" and ref.key == "settings" and profile_id == store.active_profile():
        error = await sync.push_checked()
        if error:
            raise HTTPException(502, f"Source saved; application failed: {error}")
    return {"ok": True}


@router.post("/config/passport/promote")
def promote_entity(ref: EntityRef, profile_id: Optional[str] = Query(None)):
    _check_kind(ref.kind)
    if ref.kind in PASSPORT_ONLY:
        raise HTTPException(status_code=400, detail=f"{ref.kind!r} lives only in the passport")
    try:
        return {"version": get_store().promote(_profile_or_active(profile_id), ref.kind, ref.key)}
    except ConfigError as e:
        raise _fail(e)


@router.post("/config/passport/fold")
def fold_passport(profile_id: Optional[str] = Query(None)):
    try:
        return {"version": get_store().fold(_profile_or_active(profile_id), label="машина")}
    except ConfigError as e:
        raise _fail(e)
