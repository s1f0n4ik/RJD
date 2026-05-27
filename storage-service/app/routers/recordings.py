import logging
import asyncio
import json
import re

from fastapi import (
    APIRouter, BackgroundTasks, HTTPException, Request, Response,
    WebSocket, WebSocketDisconnect,
)
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.config import settings
from app.services.jobs import JobStatus, jobs
from app.services.merger import run_merge_job
from app.services.storage import storage

logger = logging.getLogger(__name__)
router = APIRouter()


class MergeRequest(BaseModel):
    camera: str
    date: str
    start_minutes: float
    end_minutes: float


@router.get("/recordings")
async def list_all():
    return {"recordings": storage.list_all()}

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
        date=req.date,
        start_minutes=req.start_minutes,
        end_minutes=req.end_minutes,
        archive=req.archive,
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
async def download(camera_name: str, filename: str):
    file_path = storage.resolve_file(camera_name, filename)
    if file_path is None:
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        path=file_path,
        filename=filename,
        media_type="application/octet-stream",
    )


@router.get("/recordings/stream/{camera_name}/{filename}")
async def stream(camera_name: str, filename: str, request: Request):
    file_path = storage.resolve_file(camera_name, filename)
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
async def list_camera(camera_name: str):
    files = storage.list_camera(camera_name)
    if files is None:
        raise HTTPException(status_code=404, detail=f"Camera {camera_name} not found")
    return {"files": files}


class MergeRequest(BaseModel):
    camera: str
    date: str
    start_minutes: float
    end_minutes: float
    archive: bool = False  # упаковать результат в zip


async def _finalize_job(job_id: str):
    """Помечаем как скачано и чистим временные файлы."""
    job = await jobs.get(job_id)
    if job is None:
        return
    await jobs.update(job, status=JobStatus.DOWNLOADED)
    await jobs.cleanup(job)