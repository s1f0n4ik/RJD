# Единое время изделия и часовой пояс активного профиля.

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, HTTPException, status

from app.config import settings
from app.services.config_store import ConfigError, get_store
from app.services.config_sync import build_service_packages, sync
from pydantic import BaseModel, Field, StrictInt

router = APIRouter()
logger = logging.getLogger(__name__)


class TimeZone(BaseModel):
    tz_offset_min: StrictInt = Field(ge=-720, le=840)
    profile_id: str


@router.put("/time/config")
async def set_time_zone(body: TimeZone) -> dict:
    store = get_store()
    try:
        with store.transaction():
            if body.profile_id != store.active_profile():
                raise HTTPException(409, "Machine profile changed; reload before saving")
            source = dict(store.effective()["entities"].get("machine", {}).get("settings", {}).get("body", {}))
            source["tz_offset_min"] = body.tz_offset_min
            store.put(body.profile_id, "machine", "settings", source)
            expected = build_service_packages(store)["gateway"]["revision"]
    except ConfigError as error:
        raise HTTPException(409, str(error))
    error = await sync.push_checked()
    if error:
        raise HTTPException(502, f"Source saved; application failed: {error}")
    gateway = next((entry for entry in sync.status() if entry["device_id"] == "gateway"), {})
    applied = (store.active_profile() == body.profile_id
               and (store.profile_transition() or {}).get("phase", "complete") == "complete"
               and gateway.get("state") == "ok" and gateway.get("applied") == expected
               and build_service_packages(store)["gateway"]["revision"] == expected)
    return {"saved": True, "applied": applied, "tz_offset_min": body.tz_offset_min}


@router.get("/time")
async def get_time() -> dict:
    """Снимок шлюза: unix_ms (в поясе), tz_offset_min, gps, source."""
    url = f"{settings.GATEWAY_URL.rstrip('/')}/time"
    try:
        async with httpx.AsyncClient(timeout=settings.GATEWAY_TIMEOUT) as client:
            response = await client.get(url)
            response.raise_for_status()
            snapshot = response.json()
            store = get_store()
            source = store.effective()["entities"].get("machine", {}).get("settings", {}).get("body", {})
            return {**snapshot, "profile_id": store.active_profile(),
                    "profile_phase": (store.profile_transition() or {}).get("phase", "complete"),
                    "configured_tz_offset_min": source.get("tz_offset_min", 180)}
    except (httpx.HTTPError, ValueError) as e:
        # Своё время не подставляем: пусть интерфейс покажет прочерк,
        # а не выдумает время состава
        logger.warning(f"time: gateway {url} unavailable: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Time gateway is unavailable",
        )
