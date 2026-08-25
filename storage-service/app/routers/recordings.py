import logging
import asyncio
import json
import re
from pathlib import Path
from typing import Literal


from fastapi import (
    APIRouter, BackgroundTasks, HTTPException, Query, Request, Response,
    WebSocket, WebSocketDisconnect,
)
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.config import settings
from app.services.jobs import JobStatus, jobs
from app.services.merger import run_merge_job, run_archive_job
from app.services.storage import storage

logger = logging.getLogger(__name__)
router = APIRouter()


class MergeRequest(BaseModel):
    camera: str
    date: str
    start_minutes: float
    end_minutes: float
    # Не указан — берётся поток с самой свежей записью
    stream: str | None = None

class ArchiveRequest(BaseModel):
    camera: str
    date: str
    mode: Literal["day", "range"] = "day"
    stream: str | None = None
    # Для mode="range" обязательны:
    start_minutes: float | None = None
    end_minutes: float | None = None

class PathChangeRequest(BaseModel):
    path: str

@router.get("/recordings")
async def list_all():
    return {"recordings": storage.list_all()}

@router.get("/recordings/disk")
async def disk_state():
    """Текущее состояние диска по пути записей."""
    usage = storage.disk_usage()
    if usage is None:
        raise HTTPException(status_code=500, detail="Cannot read disk usage for records path")

    loop = asyncio.get_running_loop()
    records_bytes = await loop.run_in_executor(None, storage.total_size_bytes)
    used_percent = usage.used / usage.total * 100 if usage.total else 0.0

    return {
        "path": str(storage.root),
        "exists": storage.root.exists(),
        "total_bytes": usage.total,
        "used_bytes": usage.used,
        "free_bytes": usage.free,
        "records_bytes": records_bytes,
        "total_gb": round(usage.total / 1024 ** 3, 2),
        "used_gb": round(usage.used / 1024 ** 3, 2),
        "free_gb": round(usage.free / 1024 ** 3, 2),
        "records_gb": round(records_bytes / 1024 ** 3, 2),
        "used_percent": round(used_percent, 1),
        "max_used_percent": settings.MAX_USED_PERCENT,
    }

@router.post("/recordings/path")
async def change_path(req: PathChangeRequest):
    """Сменить путь просмотра записей в рантайме."""
    new_root = Path(req.path)
    if not new_root.exists():
        raise HTTPException(status_code=400, detail=f"Path does not exist: {req.path}")
    if not new_root.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {req.path}")
    storage.set_root(new_root)
    return {"ok": True, "path": str(storage.root)}

@router.get("/recordings/jobs")
async def list_active_jobs():
    """Список активных джоб (для восстановления после reload)."""
    async with jobs._lock:
        active = [
            {
                "id": j.id,
                "status": j.status.value,
                "progress": j.progress,
                "message": j.message,
                "files_total": j.files_total,
                "files_processed": j.files_processed,
                "bytes_total": j.bytes_total,
            }
            for j in jobs._jobs.values()
            if j.status not in (JobStatus.DOWNLOADED, JobStatus.FAILED, JobStatus.CANCELLED)
        ]
        return {"jobs": active}

@router.post("/recordings/merge")
async def merge_start(req: MergeRequest):
    """
    Запускает асинхронную задачу склейки. Возвращает job_id.
    Прогресс — по WS /api/recordings/jobs/{job_id}/progress
    Результат — GET /api/recordings/jobs/{job_id}/download
    """
    job = await jobs.create()
    asyncio.create_task(run_merge_job(
        job,
        camera=req.camera,
        stream=req.stream,
        date=req.date,
        start_minutes=req.start_minutes,
        end_minutes=req.end_minutes,
    ))
    return {"job_id": job.id}

@router.post("/recordings/archive")
async def archive_start(req: ArchiveRequest):
    if req.mode == "range":
        if req.start_minutes is None or req.end_minutes is None:
            raise HTTPException(
                status_code=400,
                detail="start_minutes and end_minutes required for mode=range",
            )

    job = await jobs.create()
    asyncio.create_task(run_archive_job(
        job,
        camera=req.camera,
        stream=req.stream,
        date=req.date,
        mode=req.mode,
        start_minutes=req.start_minutes,
        end_minutes=req.end_minutes,
    ))
    return {"job_id": job.id}

@router.delete("/recordings/jobs/{job_id}")
async def merge_cancel(job_id: str):
    job = await jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status in (JobStatus.READY, JobStatus.DOWNLOADED, JobStatus.FAILED, JobStatus.CANCELLED):
        # Уже закончилось — просто чистим
        await jobs.cleanup(job)
        return {"ok": True}
    await jobs.cancel(job)
    return {"ok": True}

@router.get("/recordings/jobs/{job_id}/download")
async def merge_download(job_id: str, background_tasks: BackgroundTasks):
    """
    Скачивание результата. После отправки файла job чистится.
    """
    job = await jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != JobStatus.READY or not job.result_path:
        raise HTTPException(
            status_code=400,
            detail=f"Job not ready (status: {job.status.value})",
        )
    if not job.result_path.exists():
        raise HTTPException(status_code=410, detail="Result file expired")

    background_tasks.add_task(_finalize_job, job_id)

    return FileResponse(
        path=job.result_path,
        media_type=job.result_media_type,
        filename=job.result_filename,
    )

@router.websocket("/recordings/jobs/{job_id}/progress")
async def merge_progress(ws: WebSocket, job_id: str):
    """
    WebSocket-стрим прогресса. Шлёт JSON-снапшоты по мере обновления.
    Закрывается, когда status == ready/failed.
    """
    await ws.accept()
    job = await jobs.get(job_id)
    if job is None:
        await ws.send_json({"status": "failed", "error": "Job not found"})
        await ws.close()
        return

    queue = jobs.subscribe(job)
    try:
        while True:
            event = await queue.get()
            await ws.send_json({
                "status": event.status.value,
                "progress": event.progress,
                "message": event.message,
                "error": event.error,
                "files_total": event.files_total,
                "files_processed": event.files_processed,
                "bytes_total": event.bytes_total,
                "duration_seconds": event.duration_seconds,
                "result_filename": event.result_filename,
                "result_media_type": event.result_media_type,
            })
            # Терминальные статусы — закрываем
            if event.status in (JobStatus.READY, JobStatus.FAILED):
                break
    except WebSocketDisconnect:
        pass
    finally:
        jobs.unsubscribe(job, queue)
        try:
            await ws.close()
        except Exception:
            pass

@router.get("/recordings/download/{camera_name}/{filename}")
async def download(camera_name: str, filename: str, stream: str | None = None):
    file_path = storage.resolve_file(camera_name, filename, stream)
    if file_path is None:
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        path=file_path,
        filename=filename,
        media_type="application/octet-stream",
    )


@router.get("/recordings/stream/{camera_name}/{filename}")
async def stream(
    camera_name: str,
    filename: str,
    request: Request,
    stream_key: str | None = Query(None, alias="stream"),
):
    file_path = storage.resolve_file(camera_name, filename, stream_key)
    if file_path is None:
        raise HTTPException(status_code=404, detail="File not found")

    file_size = file_path.stat().st_size
    range_header = request.headers.get("range")

    if range_header is None:
        return FileResponse(
            file_path,
            media_type="video/mp4",
            headers={"Accept-Ranges": "bytes"},
        )

    match = re.match(r"bytes=(\d+)-(\d*)", range_header)
    if not match:
        raise HTTPException(status_code=416, detail="Invalid range header")

    start = int(match.group(1))
    end = int(match.group(2)) if match.group(2) else file_size - 1

    if start >= file_size or end >= file_size or start > end:
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    length = end - start + 1

    def iterate_file():
        chunk_size = settings.STREAM_CHUNK_SIZE
        with open(file_path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                data = f.read(min(chunk_size, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    return StreamingResponse(
        iterate_file(),
        status_code=206,
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(length),
            "Content-Type": "video/mp4",
        },
    )


@router.get("/recordings/{camera_name}")
async def list_camera(camera_name: str, stream: str | None = None):
    # Без stream отдаётся всё; у каждой записи есть поле stream
    files = storage.list_camera(camera_name, stream)
    if files is None:
        raise HTTPException(status_code=404, detail=f"Camera {camera_name} not found")
    return {"files": files, "streams": storage.list_streams(camera_name)}


class MergeRequest(BaseModel):
    camera: str
    date: str
    start_minutes: float
    end_minutes: float


async def _finalize_job(job_id: str):
    """
    Помечаем как скачано. Файл удаляем не сразу, а с задержкой, чтобы клиент
    успел дописать большой архив на диск, иначе он не успевал скачаться,
    а файл на сервере уже удалялся.
    """
    job = await jobs.get(job_id)
    if job is None:
        return
    await jobs.update(job, status=JobStatus.DOWNLOADED)
    asyncio.create_task(_delayed_cleanup(job_id, settings.DOWNLOAD_CLEANUP_DELAY_SEC))


async def _delayed_cleanup(job_id: str, delay: int):
    await asyncio.sleep(delay)
    job = await jobs.get(job_id)
    if job is None:
        return
    await jobs.cleanup(job)