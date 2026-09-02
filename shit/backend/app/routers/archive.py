"""
Архив со всех устройств одним списком.

Записи лежат на том устройстве, чья камера их писала, и индекс сегментов —
тоже. Мастер опрашивает storage-service каждого устройства параллельно и
склеивает дорожки. Устройство не ответило — его дорожки не исчезают, а
приходят с пометкой offline: «не дотянулись» и «записи нет» — разные вещи.
"""

import asyncio
import logging
import re

import httpx
from fastapi import APIRouter, HTTPException, Query

from app.config import settings
from app.services.devices import registry

logger = logging.getLogger(__name__)
router = APIRouter()

DATE_KEY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _check_date(value: str, field: str) -> str:
    if not DATE_KEY.match(value):
        raise HTTPException(status_code=400, detail=f"{field} must be YYYY-MM-DD")
    return value


async def _fetch(device: dict, path: str, params: dict | None = None):
    url = f"http://{device['ip']}:{settings.DEVICE_STORAGE_PORT}/api{path}"
    try:
        response = await registry.client.get(url, params=params)
        response.raise_for_status()
        return device, response.json()
    except (httpx.HTTPError, ValueError) as e:
        logger.debug(f"Archive fetch {path} from {device['id']} failed: {e}")
        return device, None


async def _fan_out(path: str, params: dict | None = None):
    devices = registry.snapshot()
    return await asyncio.gather(*(_fetch(d, path, params) for d in devices))


@router.get("/archive/day")
async def archive_day(date: str = Query(..., description="YYYY-MM-DD")):
    """Дорожки всех устройств за сутки, у каждой сказано, чья она."""
    _check_date(date, "date")

    results = await _fan_out("/archive/day", {"date": date})

    tracks: list[dict] = []
    offline: list[str] = []

    for device, data in results:
        if data is None:
            offline.append(device["id"])
            continue

        for track in data.get("tracks") or []:
            track["device_id"] = device["id"]
            track["device_name"] = device.get("name") or device["id"]
            tracks.append(track)

    tracks.sort(key=lambda t: (t.get("camera_id", ""), t.get("stream_key", "")))

    return {"date": date, "tracks": tracks, "offline_devices": offline}


@router.get("/archive/days")
async def archive_days(
    date_from: str = Query(..., alias="from"),
    date_to: str = Query(..., alias="to"),
):
    """Сутки с записями по всем устройствам сразу — для календаря."""
    _check_date(date_from, "from")
    _check_date(date_to, "to")

    results = await _fan_out("/archive/days", {"from": date_from, "to": date_to})

    merged: dict[str, dict] = {}
    offline: list[str] = []

    for device, data in results:
        if data is None:
            offline.append(device["id"])
            continue

        for day in data.get("days") or []:
            key = day["date"]
            target = merged.setdefault(key, {
                "date": key,
                "recorded_ms": 0,
                "bytes": 0,
                "segment_count": 0,
                "track_count": 0,
                "trusted": True,
            })
            target["recorded_ms"] += day.get("recorded_ms", 0)
            target["bytes"] += day.get("bytes", 0)
            target["segment_count"] += day.get("segment_count", 0)
            target["track_count"] += day.get("track_count", 0)
            if not day.get("trusted", True):
                target["trusted"] = False

    return {
        "days": [merged[key] for key in sorted(merged)],
        "offline_devices": offline,
    }


@router.get("/archive/state")
async def archive_state():
    """Глубина архива и место на дисках — суммарно и по устройствам."""
    results = await _fan_out("/archive/state")

    devices: list[dict] = []
    offline: list[str] = []

    first_ms: int | None = None
    last_ms: int | None = None
    total_bytes = 0
    total_segments = 0
    untrusted_sessions = 0

    for device, data in results:
        if data is None:
            offline.append(device["id"])
            continue

        devices.append({
            "device_id": device["id"],
            "device_name": device.get("name") or device["id"],
            **data,
        })

        if not data.get("available"):
            continue

        total_bytes += data.get("bytes", 0)
        total_segments += data.get("segment_count", 0)
        untrusted_sessions += data.get("untrusted_sessions", 0)

        if data.get("first_ms") is not None:
            first_ms = data["first_ms"] if first_ms is None else min(first_ms, data["first_ms"])
        if data.get("last_ms") is not None:
            last_ms = data["last_ms"] if last_ms is None else max(last_ms, data["last_ms"])

    return {
        "first_ms": first_ms,
        "last_ms": last_ms,
        "bytes": total_bytes,
        "segment_count": total_segments,
        "untrusted_sessions": untrusted_sessions,
        "devices": devices,
        "offline_devices": offline,
    }
