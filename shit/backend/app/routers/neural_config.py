import json
import logging
import tempfile
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request

from app.config import settings
from app.services.config_neural import config_entry, model_name, slot_entries, stream_entry
from app.services.config_store import get_store
from app.services.config_sync import sync as config_sync
from app.services.devices import registry

router = APIRouter()
logger = logging.getLogger(__name__)


# Профиль, место устройства и тела действующей конфигурации
def _context(device: str) -> tuple[str, str, dict[str, dict[str, Any]]]:
    eff = get_store().effective()
    if not eff["profile"]:
        raise HTTPException(status_code=409, detail="No active configuration profile")
    bodies = {kind: {key: e["body"] for key, e in items.items()} for kind, items in eff["entities"].items()}
    place = next((p for p, b in bodies.get("binding", {}).items() if b.get("device_id") == device), None)
    if not place:
        raise HTTPException(status_code=409, detail="Device is not bound to a place of the active profile")
    if "neural" not in ((bodies.get("place", {}).get(place) or {}).get("modules") or []):
        raise HTTPException(status_code=409, detail=f"Place {place} has no neural module")
    return eff["profile"]["id"], place, bodies


# Модели библиотеки по имени файла; при совпадении имён — самая свежая
def _models() -> dict[str, str]:
    return {a["name"]: sha for sha, a in get_store().assets().items() if a["name"].endswith(".rknn")}


def _size_of(bodies: dict[str, dict[str, Any]]):
    infos = get_store().assets()

    def size_of(config_id: Optional[str]) -> Optional[tuple[int, int]]:
        cfg = bodies.get("neural_config", {}).get(config_id) if config_id else None
        if not cfg:
            return None
        sha = (cfg.get("_assets") or {}).get(cfg.get("model_file"))
        info = (infos.get(sha) or {}).get("info") or {}
        width, height = info.get("input_width"), info.get("input_height")
        if isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0:
            return width, height
        return None

    return size_of


# Каталог моделей на устройстве: корень varan из его /system/info
def _models_dir(device: str) -> str:
    disks = ((registry.snapshot_one(device) or {}).get("telemetry") or {}).get("disks") or []
    root = next((d.get("path") for d in disks if d.get("label") == "varan_root"), "/var/lib/varan")
    return f"{root}/neural/models"


async def _json(request: Request) -> Any:
    try:
        return json.loads(await request.body())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid JSON body")


async def _apply(data: Any) -> dict:
    if error := await config_sync.push_checked():
        raise HTTPException(status_code=502, detail=f"Saved in the profile, but the device did not apply it: {error}")
    return {"data": data}


@router.get("/neural/models")
def list_models(device: str):
    base = _models_dir(device)
    assets = get_store().assets()
    return {"data": sorted(
        ({"filename": name, "size": assets[sha]["size"], "path": f"{base}/{name}"} for name, sha in _models().items()),
        key=lambda m: m["filename"],
    )}


@router.post("/neural/models")
async def upload_model(request: Request, filename: str, device: str):
    name = model_name(filename)
    if not name.endswith(".rknn"):
        raise HTTPException(status_code=400, detail="model file must be *.rknn")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / name
        with open(path, "wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
        sha = get_store().put_asset_file(path, name)
    logger.info(f"Model {name} stored as {sha}")
    return {"data": {"filename": name, "size": get_store().assets([sha])[sha]["size"], "path": f"{_models_dir(device)}/{name}"}}


@router.post("/neural/configurations")
async def import_configurations(request: Request, device: str):
    profile_id, _, bodies = _context(device)
    payload = await _json(request)
    mode = payload.get("mode", "merge") if isinstance(payload, dict) else None
    data = payload.get("data") if isinstance(payload, dict) else None
    if mode not in ("merge", "replace") or not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="body must be {mode: merge|replace, data: {<id>: config}}")
    models = _models()
    try:
        entries = {config_id: config_entry(config_id, cfg, models) for config_id, cfg in data.items()}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    store = get_store()
    with store.transaction():
        if mode == "replace":
            for config_id in bodies.get("neural_config", {}):
                if config_id not in entries:
                    store.remove(profile_id, "neural_config", config_id)
        for config_id, body in entries.items():
            store.put(profile_id, "neural_config", config_id, body)
    return await _apply({"ok": True})


@router.delete("/neural/configurations")
async def delete_configuration(id: str, device: str):
    profile_id, _, bodies = _context(device)
    if id not in bodies.get("neural_config", {}):
        raise HTTPException(status_code=404, detail=f"configuration '{id}' not found")
    if any(slot.get("config_id") == id for slot in bodies.get("neural_slot", {}).values()):
        raise HTTPException(status_code=409, detail=f"configuration '{id}' is used by a slot")
    get_store().remove(profile_id, "neural_config", id)
    return await _apply({"ok": True})


@router.post("/neural/streams")
async def save_stream(request: Request, device: str):
    profile_id, place, bodies = _context(device)
    size_of = _size_of(bodies)
    try:
        body = stream_entry(await _json(request), place, bodies.get("neural_config", {}), size_of)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    existing = bodies.get("video_stream", {}).get(body["id"])
    if existing and existing.get("place") != place:
        raise HTTPException(status_code=409, detail=f"stream id '{body['id']}' is taken by another place")
    for slot in bodies.get("neural_slot", {}).values():
        size = size_of(slot.get("config_id")) if slot.get("stream_id") == body["id"] else None
        if size and size != (body["width"], body["height"]):
            raise HTTPException(status_code=409, detail=f"stream is used by a slot of '{slot.get('config_id')}' with model input {size[0]}x{size[1]}")
    get_store().put(profile_id, "video_stream", body["id"], body)
    return await _apply({k: v for k, v in body.items() if k != "place"})


@router.delete("/neural/streams")
async def delete_stream(id: str, device: str):
    profile_id, place, bodies = _context(device)
    stream = bodies.get("video_stream", {}).get(id)
    if not stream or stream.get("place") != place:
        raise HTTPException(status_code=404, detail=f"stream '{id}' not found")
    if any(slot.get("stream_id") == id for slot in bodies.get("neural_slot", {}).values()):
        raise HTTPException(status_code=409, detail=f"stream '{id}' is used by a slot")
    get_store().remove(profile_id, "video_stream", id)
    return await _apply({"ok": True})


@router.post("/neural/state")
async def set_state(request: Request, device: str):
    profile_id, place, bodies = _context(device)
    try:
        entries = slot_entries(
            await _json(request), place, bodies.get("video_stream", {}), bodies.get("neural_config", {}), _size_of(bodies),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    store = get_store()
    with store.transaction():
        for key, slot in bodies.get("neural_slot", {}).items():
            if slot.get("place") == place and key not in entries:
                store.remove(profile_id, "neural_slot", key)
        for key, body in entries.items():
            store.put(profile_id, "neural_slot", key, body)
    return await _apply({"ok": True})


# Типы трекеров с устройства, умолчания — из профиля поверх кода
@router.get("/neural/tracker-types")
async def tracker_types(device: str):
    target = registry.get(device)
    if not target:
        raise HTTPException(status_code=404, detail="Device not found")
    try:
        response = await registry.client.get(f"http://{target['ip']}:{settings.DEVICE_MC_PORT}/neural/tracker-types")
        response.raise_for_status()
        types = (response.json().get("data") or {}).get("types") or []
    except (httpx.HTTPError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"Device unreachable: {e}")
    eff = get_store().effective()
    defaults = {key: e["body"] for key, e in eff["entities"].get("tracker_defaults", {}).items()}
    for item in types:
        if isinstance(defaults.get(item.get("type")), dict):
            item["defaults"] = {**(item.get("defaults") or {}), **defaults[item["type"]]}
    return {"data": {"types": types}}
