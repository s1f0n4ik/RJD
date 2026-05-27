import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class JobStatus(str, Enum):
    PENDING = "pending"
    PARSING = "parsing"        # ищем файлы в диапазоне
    MERGING = "merging"        # ffmpeg склейка
    ARCHIVING = "archiving"    # упаковка в zip
    READY = "ready"            # готово к скачиванию
    DOWNLOADED = "downloaded"  # клиент уже забрал
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class JobEvent:
    status: JobStatus
    progress: float = 0.0
    message: str = ""
    error: Optional[str] = None
    files_total: int = 0
    files_processed: int = 0
    bytes_total: int = 0
    duration_seconds: float = 0.0
    result_filename: Optional[str] = None
    result_media_type: Optional[str] = None


@dataclass
class Job:
    id: str
    status: JobStatus = JobStatus.PENDING
    progress: float = 0.0
    message: str = ""
    error: Optional[str] = None
    result_path: Optional[Path] = None
    result_filename: Optional[str] = None
    result_media_type: str = "video/mp4"
    # Новые поля метрик
    files_total: int = 0
    files_processed: int = 0
    bytes_total: int = 0
    duration_seconds: float = 0.0
    cancelled: bool = False              # ← флаг отмены
    process: Optional[asyncio.subprocess.Process] = None  # ← чтобы убить ffmpeg
    temp_files: list[Path] = field(default_factory=list)
    _subscribers: list[asyncio.Queue] = field(default_factory=list)

    def snapshot(self) -> "JobEvent":
        return JobEvent(
            status=self.status,
            progress=self.progress,
            message=self.message,
            error=self.error,
            files_total=self.files_total,
            files_processed=self.files_processed,
            bytes_total=self.bytes_total,
            duration_seconds=self.duration_seconds,
            result_filename=self.result_filename,
            result_media_type=self.result_media_type,
        )


class JobManager:
    """In-memory хранилище задач склейки."""

    def __init__(self):
        self._jobs: dict[str, Job] = {}
        self._lock = asyncio.Lock()

    async def create(self) -> Job:
        async with self._lock:
            job_id = uuid.uuid4().hex
            job = Job(id=job_id)
            self._jobs[job_id] = job
            return job

    async def get(self, job_id: str) -> Optional[Job]:
        async with self._lock:
            return self._jobs.get(job_id)

    async def update(
            self,
            job: Job,
            *,
            status: Optional[JobStatus] = None,
            progress: Optional[float] = None,
            message: Optional[str] = None,
            error: Optional[str] = None,
    ):
        """Обновить состояние и разослать всем подписчикам."""
        if status is not None:
            job.status = status
        if progress is not None:
            job.progress = max(0.0, min(1.0, progress))
        if message is not None:
            job.message = message
        if error is not None:
            job.error = error

        event = job.snapshot()
        # Рассылаем без await под локом — очереди небольшие, put_nowait не блокирует.
        for q in job._subscribers:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass  # подписчик не успевает читать — пропускаем

    def subscribe(self, job: Job) -> asyncio.Queue:
        """WebSocket подписывается на прогресс конкретной job."""
        q: asyncio.Queue = asyncio.Queue(maxsize=64)
        job._subscribers.append(q)
        # сразу отправляем текущий снапшот, чтобы новый клиент не ждал
        q.put_nowait(job.snapshot())
        return q

    def unsubscribe(self, job: Job, q: asyncio.Queue):
        if q in job._subscribers:
            job._subscribers.remove(q)

    async def cleanup(self, job: Job):
        """Удалить временные файлы и саму job."""
        for p in job.temp_files:
            try:
                p.unlink(missing_ok=True)
            except OSError as e:
                logger.warning("Failed to remove %s: %s", p, e)
        if job.result_path:
            try:
                job.result_path.unlink(missing_ok=True)
            except OSError:
                pass
        async with self._lock:
            self._jobs.pop(job.id, None)

    async def cancel(self, job: Job):
        """Отмена: убиваем ffmpeg если жив, удаляем временные файлы."""
        job.cancelled = True
        if job.process and job.process.returncode is None:
            try:
                job.process.kill()
            except ProcessLookupError:
                pass
        await self.update(job, status=JobStatus.CANCELLED, message="Отменено пользователем")
        await self.cleanup(job)


jobs = JobManager()