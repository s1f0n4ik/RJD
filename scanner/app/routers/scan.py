"""
app/routers/scan.py

Эндпоинты сканирования сети на камеры.

  GET /scan/cameras
      Быстрый ONVIF WS-Discovery (JSON, как было). Совместимость.

  GET /scan/subnets
      Локальные подсети /24, доступные с этой машины.

  GET /scan/stream?subnet=192.168.1&from=11&to=39
      SSE-поток: сначала ONVIF, потом порт-скан батчами по 25 адресов.
      Каждое событие — JSON с типом этапа и накопленными результатами.
      Без subnet сканируются все локальные подсети со сквозным счётчиком.
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
from app.services.port_scan import scan_subnets_batched, enumerate_local_subnets

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


# ── Локальные подсети ────────────────────────────────────────

class LocalSubnetResponse(BaseModel):
    prefix: str
    address: str
    iface: str


@router.get("/subnets", response_model=List[LocalSubnetResponse])
async def list_subnets():
    """
    Подсети /24, доступные с этой машины — для выбора области сканирования.
    Loopback, link-local и погашенные интерфейсы не попадают.
    """
    return [LocalSubnetResponse(**vars(s)) for s in enumerate_local_subnets()]


# ── SSE-поток: ONVIF + порт-скан ─────────────────────────────

def _sse(data: dict) -> str:
    """Форматирует dict как SSE-событие."""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.get("/stream")
async def scan_stream(
        subnet: str = Query("", description="Префикс подсети (пусто = все локальные)"),
        from_: int = Query(1, alias="from", ge=1, le=254),
        to: int = Query(254, ge=1, le=254),
        onvif_timeout: float = Query(4.0, ge=1.0, le=15.0),
):
    """
    SSE-поток сканирования (по умолчанию 1–254) батчами по 25.

    subnet пустой → сканируются все локальные подсети со сквозным счётчиком.
    Раньше здесь угадывалась одна подсеть по дефолтному маршруту — на машине
    с несколькими сетями это всегда давала внешнюю, а не камерную.

    Последовательность событий:
      1. { "stage": "onvif_start" }
      2. { "stage": "onvif_done", "cameras": [...] }
      3. { "stage": "ports_start", "total": N, "subnets": ["192.168.1.", ...] }
      4. { "stage": "ports_progress", "scanned": k, "total": N,
           "subnet": "192.168.1.", "found": [...] }   (многократно)
      5. { "stage": "done", "onvif_count": x, "extra_count": y }
    """
    local = enumerate_local_subnets()

    if subnet:
        prefixes = [subnet if subnet.endswith(".") else subnet + "."]
    else:
        prefixes = [s.prefix for s in local]

    if not prefixes:
        async def err_gen():
            yield _sse({"stage": "error", "message": "Не удалось определить ни одной локальной подсети"})
        return StreamingResponse(err_gen(), media_type="text/event-stream")

    # Probe рассылаем со всех адресов, но показываем только выбранные подсети
    local_addrs = [s.address for s in local]
    lo, hi = min(from_, to), max(from_, to)

    async def event_generator():
        # ── Этап 1: ONVIF ──
        yield _sse({"stage": "onvif_start"})

        onvif_cams = await discover_cameras(timeout=onvif_timeout, local_addrs=local_addrs)
        onvif_dicts = [
            camera_to_dict(c) for c in onvif_cams
            if any(c.ip.startswith(p) for p in prefixes)
        ]
        onvif_ips = {c["ip"] for c in onvif_dicts}

        yield _sse({"stage": "onvif_done", "cameras": onvif_dicts})

        # ── Этап 2: порт-скан (исключаем уже найденные ONVIF) ──
        extra_count = 0
        async for update in scan_subnets_batched(prefixes, lo, hi, exclude_ips=onvif_ips):
            if update["type"] == "start":
                yield _sse({
                    "stage": "ports_start",
                    "total": update["total"],
                    "subnets": update["subnets"],
                })
                await asyncio.sleep(0)
                continue

            extra_count += len(update["found"])
            yield _sse({
                "stage": "ports_progress",
                "scanned": update["scanned"],
                "total": update["total"],
                "subnet": update["subnet"],
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