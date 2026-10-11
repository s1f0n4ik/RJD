"""Устройства: discovery, реестр, таблица маршрутизации, агрегация камер."""

import asyncio
import json
import logging
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from app.config import settings
from app.services.devices import registry

router = APIRouter()
logger = logging.getLogger(__name__)


class DeviceAddRequest(BaseModel):
    id: str
    ip: str
    name: str
    modules: list[str] = []


class DeviceRenameRequest(BaseModel):
    name: str


class RoutingTable(BaseModel):
    birdview: Optional[str] = None
    neural: Optional[str] = None
    krsps: Optional[str] = None
    cameras: Optional[str] = None


class DeviceProbeRequest(BaseModel):
    ip: str


@router.get("/devices")
async def list_devices():
    """Реестр с телеметрией и статусами из кэша поллера."""
    return {"devices": registry.snapshot(), "routing": registry.get_routing()}


@router.post("/devices/scan")
async def scan_devices():
    """Обход подсетей мастера по порту media-center."""
    found = await registry.scan()
    return {"found": found}


@router.post("/devices/probe")
async def probe_device(body: DeviceProbeRequest):
    """Паспорт устройства по адресу: id, имя, версия, модули."""
    passport = await registry.probe_address(body.ip.strip())
    if not passport:
        raise HTTPException(status_code=502, detail="No media-center answered at this address")
    conflicts, duplicates = await _probe_conflicts(passport)
    return {"device": passport, "conflicts": conflicts, "duplicates": duplicates}


@router.post("/devices")
async def add_device(body: DeviceAddRequest):
    device = await registry.add(body.id, body.ip, body.name, body.modules)
    return {"device": device, "routing": registry.get_routing()}


@router.patch("/devices/{device_id}")
async def rename_device(device_id: str, body: DeviceRenameRequest):
    device = await registry.rename(device_id, body.name)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return {"device": device}


@router.delete("/devices/{device_id}")
async def remove_device(device_id: str):
    if not await registry.remove(device_id):
        raise HTTPException(status_code=404, detail="Device not found")
    return {"result": "success", "routing": registry.get_routing()}


@router.post("/devices/{device_id}/poll")
async def poll_device(device_id: str):
    """Внеочередной опрос устройства вне цикла поллера."""
    device = await registry.poll_now(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return {"device": device}


@router.get("/devices/routing")
async def get_routing():
    return {"routing": registry.get_routing()}


@router.put("/devices/routing")
async def put_routing(body: RoutingTable):
    routing = await registry.set_routing(body.model_dump())
    return {"routing": routing}


async def _fetch_data(device: dict, path: str) -> tuple[dict, Optional[Any]]:
    """Живой запрос к устройству, возвращает поле data; None — не ответило."""
    url = f"http://{device['ip']}:{settings.DEVICE_MC_PORT}{path}"
    try:
        response = await registry.client.get(url)
        response.raise_for_status()
        return device, response.json().get("data")
    except (httpx.HTTPError, ValueError) as e:
        logger.debug(f"Fetch {path} from {device['id']} failed: {e}")
        return device, None


def _tag(item: dict, device: dict, offline: bool = False) -> dict:
    """Запись получает устройство-владельца — фронт по нему строит /d/-пути."""
    tagged = {**item, "device_id": device["id"], "device_name": device["name"]}
    if offline:
        tagged["offline"] = True
    return tagged


@router.get("/cameras")
async def aggregate_cameras():
    """Камеры со всех устройств в форме GET /camera media-center'а.

    Offline-устройства отдаются из кэша поллера с пометкой offline.
    """
    devices = registry.snapshot()
    results = await asyncio.gather(*(_fetch_data(d, "/camera") for d in devices))

    cameras: dict[str, dict] = {}
    owners: dict[str, list[str]] = {}
    virtual_streams: list[dict] = []
    for device, data in results:
        offline = data is None
        if offline:
            data = registry.cached_camera_data(device["id"])

        device_cameras = data.get("cameras") or {}
        if isinstance(device_cameras, dict):
            for camera_id, camera in device_cameras.items():
                owners.setdefault(camera_id, []).append(device["id"])
                # При совпадении id остаётся камера устройства, которое раньше в реестре
                if camera_id in cameras:
                    logger.warning(f"Duplicate camera id={camera_id} on {device['id']}")
                    continue
                cameras[camera_id] = _tag(camera, device, offline)

        for stream in data.get("virtual") or []:
            virtual_streams.append(_tag(stream, device, offline))

    conflicts = {camera_id: ids for camera_id, ids in owners.items() if len(ids) > 1}
    return {"data": {"cameras": cameras or None, "virtual": virtual_streams, "conflicts": conflicts}}


PROBE_PREFIX = "__probe_"


# Камеры всех устройств по кэшу поллера без пробных: (устройство, id, камера)
def _cached_cameras() -> list[tuple[str, str, dict]]:
    result = []
    for device in registry.snapshot():
        for camera_id, camera in (registry.cached_camera_data(device["id"]).get("cameras") or {}).items():
            if not camera_id.startswith(PROBE_PREFIX):
                result.append((device["id"], camera_id, camera))
    return result


# Адрес камеры: IP и порт
def _address(camera: dict) -> tuple[str, str]:
    return str(camera.get("ip_adress") or "").strip(), str(camera.get("port") or "").strip()


def _device_name(device_id: str) -> str:
    device = registry.get(device_id)
    return device["name"] if device else device_id


def _conflict(message: str, details: str) -> JSONResponse:
    return JSONResponse(status_code=409, content={
        "data": None,
        "meta": None,
        "error": {"code": 409, "message": message, "details": details},
    })


# Камеры проверяемого устройства: с занятым id и с адресом, уже добавленным на других устройствах
async def _probe_conflicts(passport: dict) -> tuple[list[str], list[str]]:
    _, data = await _fetch_data(passport, "/camera")
    cameras = {
        camera_id: camera for camera_id, camera in ((data or {}).get("cameras") or {}).items()
        if not camera_id.startswith(PROBE_PREFIX)
    }
    others = [c for c in _cached_cameras() if c[0] != passport["id"]]
    taken_ids = {camera_id for _, camera_id, _ in others}
    taken_addresses = {_address(camera) for _, _, camera in others}
    conflicts = sorted(camera_id for camera_id in cameras if camera_id in taken_ids)
    duplicates = sorted(camera_id for camera_id, camera in cameras.items() if _address(camera) in taken_addresses)
    return conflicts, duplicates


@router.post("/cameras")
async def create_camera(request: Request, device: str, replaces: Optional[str] = None):
    """Новая камера на устройстве; её id и адрес не должны быть заняты."""
    target = registry.get(device)
    if not target:
        raise HTTPException(status_code=404, detail="Device not found")

    body = await request.body()
    try:
        camera = json.loads(body)
        camera_id = str(camera.get("id") or "")
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="Invalid camera payload")

    # Заменяемая камера (перенос или смена id) в проверках не участвует
    replaced = tuple(replaces.split(":", 1)) if replaces else None
    others = [c for c in _cached_cameras() if (c[0], c[1]) != replaced]

    taken = [owner for owner, other_id, _ in others if other_id == camera_id and owner != device]
    if taken:
        logger.warning(f"Camera id={camera_id} rejected for {device}: taken on {taken[0]}")
        return _conflict("Camera id is taken on another device", _device_name(taken[0]))

    same = [(owner, other_id) for owner, other_id, other in others if _address(other) == _address(camera)]
    if same:
        owner, other_id = same[0]
        logger.warning(f"Camera {':'.join(_address(camera))} rejected for {device}: added as {other_id} on {owner}")
        return _conflict("Camera is already added", f"{other_id} · {_device_name(owner)}")

    url = f"http://{target['ip']}:{settings.DEVICE_MC_PORT}/camera"
    try:
        upstream = await registry.client.post(
            url, content=body, headers={"Content-Type": "application/json"}, timeout=60.0
        )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Device unreachable: {e}")
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
    )


@router.get("/recordings")
async def aggregate_recordings():
    """Записи со всех устройств; device_map говорит, чей storage у камеры."""

    async def fetch_recordings(device: dict) -> tuple[dict, dict]:
        url = f"http://{device['ip']}:{settings.DEVICE_STORAGE_PORT}/api/recordings"
        try:
            response = await registry.client.get(url)
            response.raise_for_status()
            return device, response.json().get("recordings", {})
        except (httpx.HTTPError, ValueError) as e:
            logger.debug(f"Recordings fetch from {device['id']} failed: {e}")
            return device, {}

    devices = registry.snapshot()
    results = await asyncio.gather(*(fetch_recordings(d) for d in devices))

    recordings: dict[str, list] = {}
    device_map: dict[str, str] = {}
    for device, items in results:
        for camera_name, files in items.items():
            if camera_name in recordings:
                logger.warning(f"Duplicate recordings for camera={camera_name} on {device['id']}")
                continue
            recordings[camera_name] = files
            device_map[camera_name] = device["id"]

    return {"recordings": recordings, "device_map": device_map}


@router.get("/streams")
async def aggregate_streams():
    """Виртуальные потоки (birdview, neural) со всех устройств."""
    devices = registry.snapshot()
    results = await asyncio.gather(*(_fetch_data(d, "/streams") for d in devices))

    streams: list[dict] = []
    for device, data in results:
        if isinstance(data, list):
            streams.extend(_tag(item, device) for item in data)

    return {"data": streams}


async def _neural_status(device: dict) -> dict:
    """Слоты техзрения устройства: ok — ответило, no_module — 404, offline — нет ответа."""
    entry = {"device_id": device["id"], "device_name": device["name"], "state": "offline", "slots": None}
    # Поллер уже видел устройство не в сети — тайм-аут не ждём
    if device["status"] == "offline":
        return entry
    url = f"http://{device['ip']}:{settings.DEVICE_MC_PORT}/neural/status"
    try:
        response = await registry.client.get(url)
        if response.status_code == 404:
            return {**entry, "state": "no_module"}
        response.raise_for_status()
        return {**entry, "state": "ok", "slots": response.json().get("data") or []}
    except (httpx.HTTPError, ValueError) as e:
        logger.debug(f"Fetch /neural/status from {device['id']} failed: {e}")
        return entry


@router.get("/neural/status")
async def aggregate_neural_status():
    """Статус слотов со всех устройств с модулем neural по последнему известному списку модулей."""
    devices = [d for d in registry.snapshot() if "neural" in (d.get("modules") or [])]
    return {"data": {"devices": list(await asyncio.gather(*(_neural_status(d) for d in devices)))}}
