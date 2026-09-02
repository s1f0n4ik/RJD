import asyncio
import logging
import re

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.services.cutter import run_cut_job, run_zip_job
from app.services.jobs import jobs
from app.services.segments import index
from app.services.storage import storage

logger = logging.getLogger(__name__)
router = APIRouter()

DATE_KEY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _check_date(value: str, field: str) -> str:
    if not DATE_KEY.match(value):
        raise HTTPException(status_code=400, detail=f"{field} must be YYYY-MM-DD")
    return value


@router.get("/archive/day")
async def archive_day(date: str = Query(..., description="YYYY-MM-DD")):
    """
    Дорожки за сутки: непрерывные куски записи, пропуски между ними и сами
    сегменты. Куски — для полосы таймлайна, сегменты — чтобы плеер знал, какой
    файл открыть на нужной секунде.
    """
    _check_date(date, "date")
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, index.day, date)


@router.get("/archive/range")
async def archive_range(
    from_ms: int = Query(..., description="начало окна, мс времени изделия"),
    to_ms: int = Query(..., description="конец окна"),
):
    """
    Дорожки за произвольное окно времени — то, что рисует таймлайн. Сутками он
    не ограничен, границы приходят от него.
    """
    if to_ms <= from_ms:
        raise HTTPException(status_code=400, detail="to_ms must be greater than from_ms")

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, index.window, from_ms, to_ms)


@router.get("/archive/days")
async def archive_days(
    date_from: str = Query(..., alias="from", description="YYYY-MM-DD"),
    date_to: str = Query(..., alias="to", description="YYYY-MM-DD"),
):
    """Сутки с записями за период — для подсветки дней в календаре."""
    _check_date(date_from, "from")
    _check_date(date_to, "to")
    if date_from > date_to:
        raise HTTPException(status_code=400, detail="from must not be later than to")

    loop = asyncio.get_running_loop()
    days = await loop.run_in_executor(None, index.days, date_from, date_to)
    return {"days": days}


@router.get("/archive/state")
async def archive_state():
    """Глубина архива, объём и состояние диска — правая панель экрана."""
    loop = asyncio.get_running_loop()
    state = await loop.run_in_executor(None, index.state)

    usage = storage.disk_usage()
    if usage is not None:
        state["disk"] = {
            "path": str(storage.root),
            "total_bytes": usage.total,
            "used_bytes": usage.used,
            "free_bytes": usage.free,
            "used_percent": round(usage.used / usage.total * 100, 1) if usage.total else 0.0,
        }

    return state


@router.post("/archive/reconcile")
async def archive_reconcile():
    """Сверить базу с диском немедленно, не дожидаясь фонового прохода."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, index.reconcile)


class RangeRequest(BaseModel):
    """Диапазон дорожки в настенном времени изделия, миллисекунды."""
    camera: str
    stream: str
    from_ms: int
    to_ms: int


def _check_range(req: RangeRequest) -> None:
    if req.to_ms <= req.from_ms:
        raise HTTPException(status_code=400, detail="to_ms must be greater than from_ms")


@router.post("/archive/cut")
async def archive_cut(req: RangeRequest):
    """
    Склеить диапазон в один MP4 копированием потока. Прогресс — по
    WS /api/recordings/jobs/{id}/progress, результат — GET .../download.
    """
    _check_range(req)

    job = await jobs.create()
    asyncio.create_task(run_cut_job(
        job,
        camera=req.camera,
        stream=req.stream,
        from_ms=req.from_ms,
        to_ms=req.to_ms,
    ))
    return {"job_id": job.id}


@router.post("/archive/zip")
async def archive_zip(req: RangeRequest):
    """Выгрузить исходные сегменты диапазона архивом, без обработки."""
    _check_range(req)

    job = await jobs.create()
    asyncio.create_task(run_zip_job(
        job,
        camera=req.camera,
        stream=req.stream,
        from_ms=req.from_ms,
        to_ms=req.to_ms,
    ))
    return {"job_id": job.id}
