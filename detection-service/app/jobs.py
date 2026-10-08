import asyncio
import logging
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from app.config import settings

logger = logging.getLogger(__name__)

FINISHED = ("ready", "downloaded", "failed", "cancelled")


@dataclass
class Job:
    id: str
    title: str = ""
    subtitle: str = ""
    # pending, queued, parsing, archiving, ready, downloaded, failed, cancelled
    status: str = "pending"
    progress: float = 0.0
    message: str = ""
    error: Optional[str] = None
    files_total: int = 0
    files_processed: int = 0
    bytes_total: int = 0
    result_path: Optional[Path] = None
    result_media_type: str = "application/zip"
    work_dir: Optional[Path] = None
    finished_at: Optional[float] = None
    cancelled: bool = False
    subscribers: list = field(default_factory=list)

    # Поля как у задач storage-service
    def snapshot(self) -> dict:
        return {
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "error": self.error,
            "files_total": self.files_total,
            "files_processed": self.files_processed,
            "bytes_total": self.bytes_total,
            "duration_seconds": 0.0,
            "result_filename": self.result_path.name if self.result_path else None,
            "result_media_type": self.result_media_type,
        }


class Jobs:
    def __init__(self):
        self.items: dict[str, Job] = {}
        # Тяжёлая часть выгрузок идёт по одной
        self.lock = asyncio.Lock()
        self._sweeper: Optional[asyncio.Task] = None

    async def start(self) -> None:
        self._sweeper = asyncio.create_task(self._sweep())

    async def stop(self) -> None:
        if self._sweeper:
            self._sweeper.cancel()
        for job in list(self.items.values()):
            self.cleanup(job)

    def create(self, title: str, subtitle: str) -> Job:
        job = Job(id=uuid.uuid4().hex, title=title, subtitle=subtitle)
        self.items[job.id] = job
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self.items.get(job_id)

    def update(self, job: Job, **fields) -> None:
        for key, value in fields.items():
            setattr(job, key, value)
        if job.status in FINISHED and job.finished_at is None:
            job.finished_at = time.monotonic()
        event = job.snapshot()
        for queue in job.subscribers:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def subscribe(self, job: Job) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=64)
        job.subscribers.append(queue)
        queue.put_nowait(job.snapshot())
        return queue

    def unsubscribe(self, job: Job, queue: asyncio.Queue) -> None:
        if queue in job.subscribers:
            job.subscribers.remove(queue)

    def cleanup(self, job: Job) -> None:
        if job.work_dir:
            shutil.rmtree(job.work_dir, ignore_errors=True)
        self.items.pop(job.id, None)

    def cancel(self, job: Job) -> None:
        job.cancelled = True
        self.update(job, status="cancelled", message="Отменено пользователем")
        self.cleanup(job)

    def active(self) -> list[dict]:
        return [
            {"id": job.id, "title": job.title, "subtitle": job.subtitle, **job.snapshot()}
            for job in self.items.values()
            if job.status not in ("downloaded", "failed", "cancelled")
        ]

    async def _sweep(self) -> None:
        while True:
            await asyncio.sleep(60)
            now = time.monotonic()
            for job in list(self.items.values()):
                if job.finished_at is None:
                    continue
                ttl = settings.EXPORT_TTL_SEC if job.status in ("ready", "downloaded") else 3600
                if now - job.finished_at > ttl:
                    logger.info("export %s expired (%s)", job.id, job.status)
                    self.cleanup(job)


jobs = Jobs()
