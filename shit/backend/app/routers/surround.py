import copy
import hashlib
import json
import tempfile
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request, UploadFile

from app.config import settings
from app.services.config_store import get_store
from app.services.config_sync import sync
from app.services.devices import registry
from app.services.surround import attach_assets, calibration_entry, entity_id, filename, merge_patch, model_filename, number, object_body, points, preset_entry, same_points, settings_patch

router = APIRouter()


def _context(device: str) -> tuple[str, str, dict]:
    effective = get_store().effective()
    if not effective["profile"]:
        raise HTTPException(409, "No active configuration profile")
    bodies = {kind: {key: e["body"] for key, e in entries.items()} for kind, entries in effective["entities"].items()}
    place = next((key for key, binding in bodies.get("binding", {}).items() if binding.get("device_id") == device), None)
    if not place or "birdview" not in (bodies.get("place", {}).get(place, {}).get("modules") or []):
        raise HTTPException(409, "Device is not bound to a birdview place")
    return effective["profile"]["id"], place, bodies


def _entry(bodies: dict, kind: str, key: str, place: str) -> dict:
    if not isinstance(key, str) or not key:
        raise HTTPException(400, f"Invalid {kind} key")
    entry = bodies.get(kind, {}).get(key)
    if not entry or entry.get("place") != place:
        raise HTTPException(404, f"{kind} <{key}> not found at this place")
    return copy.deepcopy(entry)


def _target(bodies: dict, place: str, payload: dict) -> str:
    key = payload.get("export_id") or bodies.get("surround_output", {}).get(place, {}).get("active")
    entity_id(key)
    _entry(bodies, "projection", key, place)
    return key


def _assets() -> dict[str, str]:
    return {info["name"]: sha for sha, info in get_store().assets().items()}


async def _json(request: Request) -> dict:
    try:
        return object_body(json.loads(await request.body()))
    except (ValueError, TypeError) as error:
        raise HTTPException(400, str(error))


async def _apply(data: dict | None = None) -> dict:
    if error := await sync.push_checked():
        raise HTTPException(502, f"Saved in the profile, but the device did not apply it: {error}")
    return {"data": data or {}}


@router.post("/calibration/configuration")
async def save_calibration(request: Request, device: str):
    profile, place, bodies = _context(device)
    payload = await _json(request)
    try:
        key = entity_id(payload.get("config_key"))
        entry = calibration_entry(payload.get("source"))
        _entry(bodies, "camera", entry["id"], place)
    except ValueError as error:
        raise HTTPException(400, str(error))
    existing = bodies.get("calibration", {}).get(key)
    if existing and existing.get("place") != place:
        raise HTTPException(409, "Calibration id belongs to another place")
    get_store().put(profile, "calibration", key, {**entry, "place": place})
    return await _apply({"config_key": key})


@router.post("/calibration/links")
async def save_links(request: Request, device: str):
    profile, place, bodies = _context(device)
    payload = await _json(request)
    try:
        links = object_body(payload.get("links"))
        for camera, link in links.items():
            _entry(bodies, "camera", camera, place)
            object_body(link)
            _entry(bodies, "calibration", link.get("config"), place)
            fps = number(link.get("fps", 15), "correction fps", 1, 60)
            if int(fps) != fps:
                raise ValueError("Correction fps must be an integer")
    except (ValueError, TypeError) as error:
        raise HTTPException(400, str(error))
    store = get_store()
    with store._tx():
        for camera, entry in bodies.get("correction_link", {}).items():
            if entry.get("place") == place and camera not in links:
                store.remove(profile, "correction_link", camera)
        for camera, link in links.items():
            store.put(profile, "correction_link", camera, {**link, "place": place})
    return await _apply()


@router.post("/linker/state")
async def save_state(request: Request, device: str):
    profile, place, bodies = _context(device)
    payload = await _json(request)
    try:
        key = entity_id(payload.get("export_id"))
        projection = _entry(bodies, "projection", key, place)
        cameras = object_body(payload.get("cameras"))
        for slot, camera in cameras.items():
            entity_id(slot)
            if slot not in (projection.get("cameras") or {}):
                raise ValueError("Camera place is not in the projection")
            if camera is not None and not isinstance(camera, str):
                raise ValueError("Camera binding must be a string or null")
            if camera:
                _entry(bodies, "camera", camera, place)
        if "fps" in payload:
            fps = number(payload["fps"], "fps", 1, 60)
            if int(fps) != fps:
                raise ValueError("fps must be an integer")
        if "rotation" in payload and (isinstance(payload["rotation"], bool) or payload["rotation"] not in (0, 90, 180, 270)):
            raise ValueError("Invalid rotation")
        if "dual_output" in payload and not isinstance(payload["dual_output"], bool):
            raise ValueError("dual_output must be a bool")
        for field in ("stream_id", "stream_name"):
            if field in payload and not isinstance(payload[field], str):
                raise ValueError(f"{field} must be a string")
    except (ValueError, TypeError) as error:
        raise HTTPException(400, str(error))
    output = copy.deepcopy(bodies.get("surround_output", {}).get(place) or {"active": None, "configs": {}})
    entry = output["configs"].setdefault(key, {})
    entry.update({field: value for field, value in payload.items() if field in ("cameras", "fps", "rotation", "dual_output", "stream_id", "stream_name")})
    output["active"] = key
    get_store().put(profile, "surround_output", place, output)
    return await _apply()


@router.post("/linker/rotation")
@router.post("/linker/dual-output")
async def output_option(request: Request, device: str):
    profile, place, bodies = _context(device)
    payload = await _json(request)
    try:
        key = _target(bodies, place, payload)
        field = "rotation" if request.url.path.endswith("rotation") else "dual_output"
        value = payload.get(field)
        if (field == "rotation" and (isinstance(value, bool) or value not in (0, 90, 180, 270))) or (field == "dual_output" and not isinstance(value, bool)):
            raise ValueError(f"Invalid {field}")
    except ValueError as error:
        raise HTTPException(400, str(error))
    output = copy.deepcopy(bodies.get("surround_output", {}).get(place) or {"active": None, "configs": {}})
    output["configs"].setdefault(key, {})[field] = value
    get_store().put(profile, "surround_output", place, output)
    return await _apply({"export_id": key, field: value})


@router.post("/linker/surround")
@router.post("/linker/top")
async def save_settings(request: Request, device: str):
    profile, place, bodies = _context(device)
    payload = await _json(request)
    mode = request.url.path.rsplit("/", 1)[-1]
    try:
        key = _target(bodies, place, payload)
        patch = settings_patch(payload, mode)
        for camera, calibration in (patch.get("calibration") or {}).items():
            _entry(bodies, "camera", camera, place)
            _entry(bodies, "calibration", calibration, place)
        entry = _entry(bodies, "projection", key, place)
        entry[mode] = merge_patch(entry.get(mode) or {}, patch)
        attach_assets(entry, _assets())
    except (ValueError, TypeError) as error:
        raise HTTPException(400, str(error))
    get_store().put(profile, "projection", key, entry)
    return await _apply({"export_id": key})


@router.post("/linker/surround-camera")
async def save_pose(request: Request, device: str):
    profile, place, bodies = _context(device)
    payload = await _json(request)
    try:
        key = _target(bodies, place, payload)
        slot = entity_id(payload.get("place_key"))
        entry = _entry(bodies, "projection", key, place)
        if slot not in (entry.get("cameras") or {}):
            raise ValueError("Camera place is not in the projection")
        poses = entry.setdefault("surround", {}).setdefault("extrinsics", {})
        if payload.get("reset") is True:
            poses.pop(slot, None)
        else:
            position = payload.get("position")
            if not isinstance(position, list) or len(position) != 3:
                raise ValueError("Position needs three coordinates")
            for coordinate in position:
                number(coordinate, "position")
            pose = {"position": position}
            for field in ("yaw", "pitch", "roll"):
                pose[field] = number(payload.get(field, 0), field)
            poses[slot] = pose
    except (ValueError, TypeError) as error:
        raise HTTPException(400, str(error))
    get_store().put(profile, "projection", key, entry)
    return await _apply({"export_id": key, "place_key": slot})


@router.post("/linker/exports")
async def save_presets(request: Request, device: str):
    profile, place, bodies = _context(device)
    uploads = []
    try:
        if request.headers.get("content-type", "").startswith("multipart/form-data"):
            form = await request.form()
            payload = object_body(json.loads(form.get("config") or "null"))
            uploads = form.getlist("images")
        else:
            payload = await _json(request)
        if not payload:
            raise ValueError("Empty presets")
        entries = {}
        for key, value in payload.items():
            if not isinstance(key, str) or not key:
                raise ValueError("Invalid preset key")
            old = bodies.get("preset", {}).get(key)
            if old and old.get("place") != place:
                raise ValueError("Preset key belongs to another place")
            entries[key] = preset_entry(value, old)
            for camera in entries[key]["cameras"].values():
                for field, kind in (("camera_id", "camera"), ("calibration", "calibration")):
                    if camera.get(field):
                        _entry(bodies, kind, camera[field], place)
        renamed = {}
        for upload in uploads:
            name, _ = await _upload(upload)
            renamed[upload.filename] = name
        for entry in entries.values():
            images = entry.get("images") or []
            if not isinstance(images, list):
                raise ValueError("Images must be an array")
            for image in images:
                object_body(image)
                image["name"] = renamed.get(image.get("name"), image.get("name"))
        available = _assets()
        for key, entry in entries.items():
            attach_assets(entry, available, bodies.get("preset", {}).get(key))
    except (ValueError, TypeError) as error:
        raise HTTPException(400, str(error))
    store = get_store()
    with store._tx():
        for key, entry in entries.items():
            store.put(profile, "preset", key, {**entry, "place": place})
    return await _apply()


@router.delete("/linker/preset")
async def delete_preset(key: str, device: str):
    profile, place, bodies = _context(device)
    _entry(bodies, "preset", key, place)
    if any(entry.get("preset") == key for entry in bodies.get("projection", {}).values()):
        raise HTTPException(409, "Preset is used by a projection")
    get_store().remove(profile, "preset", key)
    return await _apply()


@router.delete("/linker/export")
async def delete_projection(id: str, device: str):
    profile, place, bodies = _context(device)
    _entry(bodies, "projection", id, place)
    output = copy.deepcopy(bodies.get("surround_output", {}).get(place) or {"active": None, "configs": {}})
    if output.get("active") == id:
        raise HTTPException(409, "Active projection cannot be deleted")
    output["configs"].pop(id, None)
    store = get_store()
    with store._tx():
        store.remove(profile, "projection", id)
        store.put(profile, "surround_output", place, output)
    return await _apply()


@router.post("/linker/projection")
async def save_projection_source(request: Request, device: str):
    profile, place, bodies = _context(device)
    payload = await _json(request)
    try:
        key = entity_id(payload.get("id"))
        name = payload.get("name")
        if not isinstance(name, str):
            raise ValueError("Projection name must be a string")
        source = object_body(payload.get("source"))
        preset_key = source.get("preset_key")
        preset = _entry(bodies, "preset", preset_key, place)
        cameras = object_body(source.get("cameras"))
        if not cameras:
            raise ValueError("Projection needs at least one camera")
        if preset.get("canvas") != source.get("canvas") or set(preset.get("cameras") or {}) != set(cameras):
            raise HTTPException(409, "Preset changed during editing; reload the projection")
        existing = bodies.get("projection", {}).get(key)
        if existing and existing.get("place") != place:
            raise HTTPException(409, "Projection id belongs to another place")
        projection = copy.deepcopy(existing or {})
        projection.update({"name": name, "preset": preset_key, "place": place})
        calibrations, calibration_keys, bindings, projection_cameras = {}, {}, {}, {}
        for slot, patch in cameras.items():
            entity_id(slot)
            object_body(patch)
            camera = preset["cameras"][slot]
            if not same_points(camera.get("dst_points"), patch.get("dst_points")):
                raise HTTPException(409, "Preset points changed during editing; reload the projection")
            src = points(patch.get("src_points"), "source points")
            if any(not 0 <= coordinate <= 1 for point in src for coordinate in point):
                raise ValueError("Source points must be normalized")
            if len(src) != len(camera.get("dst_points") or []):
                raise ValueError("Source and destination point counts differ")
            camera_id = entity_id(patch.get("camera_id"))
            _entry(bodies, "camera", camera_id, place)
            calibration = calibration_entry(patch.get("calibration_source"))
            if calibration["id"] != camera_id:
                raise ValueError("Calibration does not belong to the marked camera")
            calibration_key = f"projection_{key}_{slot}"
            old = bodies.get("calibration", {}).get(calibration_key)
            if old and (old.get("place") != place or old.get("projection_id") != key):
                raise HTTPException(409, "Projection calibration key is already used")
            calibrations[calibration_key] = {**calibration, "place": place, "projection_id": key}
            camera.update({"src_points": src, "camera_id": camera_id, "calibration": calibration_key})
            bindings[slot] = camera_id
            calibration_keys[camera_id] = calibration_key
            projection_cameras[slot] = {"name": camera.get("name") or slot, "camera_id": camera_id}
        projection["cameras"] = projection_cameras
        for field in ("machine", "images"):
            if field in preset:
                projection[field] = copy.deepcopy(preset[field])
            else:
                projection.pop(field, None)
        surround = projection.setdefault("surround", {})
        surround["preset"] = preset_key
        surround["calibration"] = calibration_keys
        attach_assets(projection, _assets(), preset)
        output = copy.deepcopy(bodies.get("surround_output", {}).get(place) or {"active": None, "configs": {}})
        output["configs"].setdefault(key, {})["cameras"] = bindings
    except (ValueError, TypeError) as error:
        raise HTTPException(400, str(error))
    store = get_store()
    with store._tx():
        for calibration_key, calibration in calibrations.items():
            store.put(profile, "calibration", calibration_key, calibration)
        store.put(profile, "preset", preset_key, preset)
        store.put(profile, "projection", key, projection)
        store.put(profile, "surround_output", place, output)
    return await _apply({"id": key, "name": name})


async def _upload(upload: UploadFile) -> tuple[str, str]:
    if not hasattr(upload, "filename") or not hasattr(upload, "read"):
        raise ValueError("Expected an uploaded file")
    name = filename(upload.filename)
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / name
        with path.open("wb") as target:
            while chunk := await upload.read(1 << 20):
                target.write(chunk)
        if name.endswith(".glb"):
            with path.open("rb") as source:
                header = source.read(12)
            if len(header) != 12 or header[:4] != b"glTF":
                raise ValueError("File is not a binary glTF model")
        with path.open("rb") as source:
            sha = hashlib.file_digest(source, "sha256").hexdigest()
        if existing := get_store().assets().get(sha):
            return existing["name"], sha
        previous = _assets().get(name)
        if previous and previous != sha:
            file = Path(name)
            name = f"{file.stem}-{sha[:12]}{file.suffix}"
            if name in _assets() and _assets()[name] != sha:
                name = f"{file.stem}-{sha}{file.suffix}"
        return name, get_store().put_asset_file(path, name)


@router.post("/linker/upload-model")
async def upload_model(request: Request, device: str):
    _context(device)
    form = await request.form()
    upload = form.get("model")
    try:
        if not upload or not hasattr(upload, "filename"):
            raise ValueError("Model must be a .glb file")
        model_filename(upload.filename)
        name, _ = await _upload(upload)
    except ValueError as error:
        raise HTTPException(400, str(error))
    return {"data": {"filename": name}}


@router.get("/linker/models")
def list_models(device: str):
    _context(device)
    models = {info["name"]: info["size"] for info in get_store().assets().values() if info["name"].endswith(".glb")}
    return {"data": {"models": [{"name": name, "size": size} for name, size in sorted(models.items())]}}


@router.post("/linker/recalc")
@router.post("/linker/top-version")
async def derived_operation(request: Request, device: str):
    _, place, bodies = _context(device)
    payload = await _json(request)
    try:
        payload["export_id"] = _target(bodies, place, payload)
    except ValueError as error:
        raise HTTPException(400, str(error))
    board = registry.get(device)
    if not board:
        raise HTTPException(404, "Device not found")
    operation = request.url.path.rsplit("/", 1)[-1]
    await _apply()
    state = next((state for state in sync.status() if state["device_id"] == device), {})
    if state.get("state") != "ok" or state.get("expected") != state.get("applied"):
        raise HTTPException(409, "Device has not applied the current configuration revision")
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(f"http://{board['ip']}:{settings.DEVICE_MC_PORT}/linker/{operation}", json=payload)
        result = response.json()
        if response.status_code != 200:
            raise HTTPException(response.status_code, result.get("error") or "Derived operation failed")
        return result
    except httpx.HTTPError:
        raise HTTPException(502, "Device is unavailable")
    except ValueError:
        raise HTTPException(502, "Device returned an invalid response")
