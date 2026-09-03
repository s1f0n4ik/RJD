import asyncio
import logging
import re

from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.services.cutter import run_cut_job, zip_entries
from app.services.frames import frame_at
from app.services.jobs import jobs
from app.services.segments import index
from app.services.storage import storage
from app.services.zipstream import stream_zip

logger = logging.getLogger(__name__)
router = APIRouter()

DATE_KEY = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Кадров для лупы просят по движению мыши, а ffmpeg на плате не бесплатный
_frame_gate = asyncio.Semaphore(2)


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


@router.get("/archive/shape")
async def archive_shape():
    """
    Форма архива целиком: куски и разрывы всех дорожек без списков сегментов.
    Таймлайн берёт её один раз, дальше сдвиг и зум — чистая арифметика.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, index.shape)


@router.get("/archive/segments")
async def archive_segments(
    camera: str = Query(..., description="идентификатор камеры"),
    stream: str = Query(..., description="ключ потока"),
    from_ms: int = Query(..., description="начало, мс времени изделия"),
    to_ms: int = Query(..., description="конец"),
):
    """Сегменты одной дорожки — по ним плеер знает, какой файл открыть."""
    if to_ms <= from_ms:
        raise HTTPException(status_code=400, detail="to_ms must be greater than from_ms")

    loop = asyncio.get_running_loop()
    segments = await loop.run_in_executor(
        None, index.range_segments, camera, stream, from_ms, to_ms
    )
    return {"segments": segments}


@router.get("/archive/frame")
async def archive_frame(
    camera: str = Query(..., description="идентификатор камеры"),
    stream: str = Query(..., description="ключ потока"),
    ms: int = Query(..., description="момент времени изделия, мс"),
):
    """Кадр под курсором таймлайна: JPEG из сегмента, покрывающего момент."""
    loop = asyncio.get_running_loop()

    async with _frame_gate:
        data = await loop.run_in_executor(None, frame_at, camera, stream, ms)

    if data is None:
        raise HTTPException(status_code=404, detail="No frame at this moment")

    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


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


class TrackRef(BaseModel):
    camera: str
    stream: str


class ExportRequest(BaseModel):
    # Диапазон в настенном времени изделия, миллисекунды
    tracks: list[TrackRef]
    from_ms: int
    to_ms: int
    # Что показывать в списке выгрузок, в том числе после перезагрузки страницы
    title: str = ""
    subtitle: str = ""


def _check_export(req: ExportRequest) -> list[dict]:
    if req.to_ms <= req.from_ms:
        raise HTTPException(status_code=400, detail="to_ms must be greater than from_ms")
    if not req.tracks:
        raise HTTPException(status_code=400, detail="tracks must not be empty")
    return [{"camera": t.camera, "stream": t.stream} for t in req.tracks]


@router.post("/archive/cut")
async def archive_cut(req: ExportRequest):
    """
    Склеить диапазон копированием потока: по файлу на дорожку, несколько дорожек
    уходят архивом. Прогресс — по WS /api/recordings/jobs/{id}/progress,
    результат — GET .../download.
    """
    tracks = _check_export(req)

    job = await jobs.create(title=req.title, subtitle=req.subtitle)
    asyncio.create_task(run_cut_job(job, tracks=tracks, from_ms=req.from_ms, to_ms=req.to_ms))
    return {"job_id": job.id}


@router.get("/archive/zip")
async def archive_zip(
    track: list[str] = Query(..., description="camera:stream, повторяется"),
    from_ms: int = Query(...),
    to_ms: int = Query(...),
):
    """
    Исходные сегменты диапазона архивом, папка на камеру. Zip без сжатия
    формируется прямо в ответ: на диске ничего не создаётся, задачи нет,
    ход скачивания показывает браузер.
    """
    if to_ms <= from_ms:
        raise HTTPException(status_code=400, detail="to_ms must be greater than from_ms")

    tracks = []
    for item in track:
        camera, _, stream = item.partition(":")
        if not camera or not stream:
            raise HTTPException(status_code=400, detail="track must be camera:stream")
        tracks.append({"camera": camera, "stream": stream})

    loop = asyncio.get_running_loop()
    entries, name = await loop.run_in_executor(None, zip_entries, tracks, from_ms, to_ms)
    if not entries:
        raise HTTPException(status_code=404, detail="No recordings in the selected range")

    logger.info("Streaming zip %s: %d files", name, len(entries))
    return StreamingResponse(
        stream_zip(entries),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )
