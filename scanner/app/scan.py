"""
app/routers/scan.py

Эндпоинты сканирования сети на ONVIF-камеры.
  GET /scan/cameras                 — discovery всех камер (быстро, без авторизации)
  GET /scan/cameras?enrich=true     — + GetDeviceInformation (медленнее, нужен логин/пароль)
"""

from __future__ import annotations

import asyncio
import logging
from typing import List

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.onvif_discovery import (
    discover_cameras,
    enrich_device_info,
    camera_to_dict,
)

router = APIRouter()
logger = logging.getLogger(__name__)


class ScannedCamera(BaseModel):
    ip: str
    port: int
    xaddr: str
    name: str | None = None
    model: str | None = None
    manufacturer: str | None = None


class ScanResponse(BaseModel):
    count: int
    cameras: List[ScannedCamera]


@router.get("/cameras", response_model=ScanResponse)
async def scan_cameras(
        enrich: bool = Query(False, description="Дополнить инфо через ONVIF GetDeviceInformation"),
        username: str = Query("", description="Логин для enrich (опционально)"),
        password: str = Query("", description="Пароль для enrich (опционально)"),
        timeout: float = Query(4.0, ge=1.0, le=15.0, description="Таймаут discovery, сек"),
):
    """Найти ONVIF-камеры в локальной сети."""
    cameras = await discover_cameras(timeout=timeout)

    if enrich and cameras:
        # Обогащаем параллельно, но не падаем если часть не ответит
        cameras = await asyncio.gather(
            *[enrich_device_info(c, username, password) for c in cameras]
        )

    return ScanResponse(
        count=len(cameras),
        cameras=[ScannedCamera(**camera_to_dict(c)) for c in cameras],
    )