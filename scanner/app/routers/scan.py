"""
app/routers/scan.py

Эндпоинты сканирования сети на камеры.

  GET /scan/cameras
      Быстрый ONVIF WS-Discovery (JSON, как было). Совместимость.

  GET /scan/stream?subnet=192.168.1&from=11&to=39
      SSE-поток: сначала ONVIF, потом порт-скан батчами по 25 адресов.
      Каждое событие — JSON с типом этапа и накопленными результатами.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import List

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.services.onvif_discovery import (
    discover_cameras,
    enrich_device_info,
    camera_to_dict,
)
from app.services.port_scan import scan_ports_batched, detect_local_subnet

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Старый JSON-эндпоинт (только ONVIF) ──────────────────────

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
        enrich: bool = Query(False),
        username: str = Query(""),
        password: str = Query(""),
        timeout: float = Query(4.0, ge=1.0, le=15.0),
):
    """Найти ONVIF-камеры в локальной сети (быстро, без порт-скана)."""
    cameras = await discover_cameras(timeout=timeout)
    if enrich and cameras:
        cameras = await asyncio.gather(
            *[enrich_device_info(c, username, password) for c in cameras]
        )
    return ScanResponse(
        count=len(cameras),
        cameras=[ScannedCamera(**camera_to_dict(c)) for c in cameras],
    )


# ── SSE-поток: ONVIF + порт-скан ─────────────────────────────

def _sse(data: dict) -> str:
    """Форматирует dict как SSE-событие."""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.get("/stream")
async def scan_stream(
        subnet: str = Query("", description="Префикс подсети (пусто = автоопределение)"),
        from_: int = Query(1, alias="from", ge=1, le=254),
        to: int = Query(254, ge=1, le=254),
        onvif_timeout: float = Query(4.0, ge=1.0, le=15.0),
):
    """
    SSE-поток сканирования всей подсети (по умолчанию 1–254) батчами по 25.

    subnet пустой → сервер определяет свою подсеть сам.

    Последовательность событий:
      1. { "stage": "onvif_start" }
      2. { "stage": "onvif_done", "cameras": [...] }
      3. { "stage": "ports_start", "total": N, "subnet": "192.168.1." }
      4. { "stage": "ports_progress", "scanned": k, "total": N, "found": [...] }  (многократно)
      5. { "stage": "done", "onvif_count": x, "extra_count": y }
    """
    # Определяем подсеть: из параметра или автоматически
    if subnet:
        subnet_prefix = subnet if subnet.endswith(".") else subnet + "."
    else:
        subnet_prefix = detect_local_subnet()
        if not subnet_prefix:
            # Не смогли определить — отдаём ошибку через SSE
            async def err_gen():
                yield _sse({"stage": "error", "message": "Не удалось определить подсеть"})
            return StreamingResponse(err_gen(), media_type="text/event-stream")

    lo, hi = min(from_, to), max(from_, to)

    async def event_generator():
        # ── Этап 1: ONVIF ──
        yield _sse({"stage": "onvif_start"})

        onvif_cams = await discover_cameras(timeout=onvif_timeout)
        onvif_dicts = [camera_to_dict(c) for c in onvif_cams]
        onvif_ips = {c["ip"] for c in onvif_dicts}

        yield _sse({"stage": "onvif_done", "cameras": onvif_dicts})

        # ── Этап 2: порт-скан (исключаем уже найденные ONVIF) ──
        total = (hi - lo + 1)
        yield _sse({"stage": "ports_start", "total": total, "subnet": subnet_prefix})

        extra_count = 0
        async for update in scan_ports_batched(subnet_prefix, lo, hi, exclude_ips=onvif_ips):
            extra_count += len(update["found"])
            yield _sse({
                "stage": "ports_progress",
                "scanned": update["scanned"],
                "total": update["total"],
                "found": update["found"],
            })
            await asyncio.sleep(0)

        # ── Финал ──
        yield _sse({
            "stage": "done",
            "onvif_count": len(onvif_dicts),
            "extra_count": extra_count,
        })

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )