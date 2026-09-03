"""Устройства: discovery, реестр, таблица маршрутизации, агрегация камер."""

import asyncio
import logging
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException
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
    return {"device": passport}


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
    virtual_streams: list[dict] = []
    for device, data in results:
        offline = data is None
        if offline:
            data = registry.cached_camera_data(device["id"])

        device_cameras = data.get("cameras") or {}
        if isinstance(device_cameras, dict):
            for camera_id, camera in device_cameras.items():
                if camera_id in cameras:
                    logger.warning(f"Duplicate camera id={camera_id} on {device['id']}")
                cameras[camera_id] = _tag(camera, device, offline)

        for stream in data.get("virtual") or []:
            virtual_streams.append(_tag(stream, device, offline))

    return {"data": {"cameras": cameras or None, "virtual": virtual_streams}}


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
