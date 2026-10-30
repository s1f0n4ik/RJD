import logging
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
from app.services.config_store import KINDS, PASSPORT_ONLY, ConfigError, get_store
from app.services.config_sync import sync

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


@router.post("/config/import")
def import_backup(
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
        version = store.create_version(profile_id, name, result["entities"], label="резервная копия")
        for place, binding in result["bindings"].items():
            store.put(profile_id, "binding", place, binding)
        if activate or not store.active_profile():
            store.set_active(profile_id)
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
def load(file: UploadFile = File(...), activate: bool = Form(False)):
    store = get_store()
    with tempfile.TemporaryDirectory() as tmp:
        try:
            result = load_profile(store, _spool(file, tmp))
        except (ConfigError, ValueError, KeyError, OSError) as e:
            raise HTTPException(status_code=400, detail=f"profile load failed: {e}")
    if activate or not store.active_profile():
        store.set_active(result["profile"]["id"])
    return {**result, "broken": store.effective(result["profile"]["id"])["broken"]}


@router.post("/config/profiles/{profile_id}/select")
def select_version(profile_id: str, body: SelectVersion):
    try:
        get_store().select_version(profile_id, body.version_id)
    except ConfigError as e:
        raise _fail(e)
    return {"ok": True}


@router.post("/config/active")
def set_active(body: SetActive):
    try:
        get_store().set_active(body.profile_id)
    except ConfigError as e:
        raise _fail(e)
    return {"ok": True}


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
    return {"devices": sync.status()}


@router.get("/config/effective")
def effective(profile_id: Optional[str] = Query(None)):
    try:
        return get_store().effective(profile_id)
    except ConfigError as e:
        raise _fail(e)


@router.put("/config/entities/{kind}/{key:path}")
def put_entity(kind: str, key: str, body: Any = Body(...), profile_id: Optional[str] = Query(None)):
    _check_kind(kind)
    try:
        return {"state": get_store().put(_profile_or_active(profile_id), kind, key, body)}
    except ConfigError as e:
        raise _fail(e)


@router.delete("/config/entities/{kind}/{key:path}")
def remove_entity(kind: str, key: str, profile_id: Optional[str] = Query(None)):
    _check_kind(kind)
    try:
        return {"state": get_store().remove(_profile_or_active(profile_id), kind, key)}
    except ConfigError as e:
        raise _fail(e)


@router.post("/config/passport/reset")
def reset_entity(ref: EntityRef, profile_id: Optional[str] = Query(None)):
    _check_kind(ref.kind)
    get_store().reset(_profile_or_active(profile_id), ref.kind, ref.key)
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
