"""
app/routers/time.py

Единое время изделия. Время приходит по шине от источника (Садко) в
message-gateway, тот держит его непрерывным по монотонным часам и отдаёт
снимок уже сдвинутым на настроенный пояс. Здесь — тонкий прокси: бэкенд
крутится с network_mode: host на том же мастере, что и шлюз.

Маршрут:
  GET /api/time — снимок времени и GPS шлюза как есть
"""

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, HTTPException, status

from app.config import settings

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/time")
async def get_time() -> dict:
    """Снимок шлюза: unix_ms (в поясе), tz_offset_min, gps, source."""
    url = f"{settings.GATEWAY_URL.rstrip('/')}/time"
    try:
        async with httpx.AsyncClient(timeout=settings.GATEWAY_TIMEOUT) as client:
            response = await client.get(url)
            response.raise_for_status()
            return response.json()
    except (httpx.HTTPError, ValueError) as e:
        # Своё время не подставляем: пусть интерфейс покажет прочерк,
        # а не выдумает время состава
        logger.warning(f"time: gateway {url} unavailable: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Time gateway is unavailable",
        )
