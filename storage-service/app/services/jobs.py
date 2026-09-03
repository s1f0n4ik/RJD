import asyncio
import logging
import shutil
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional

from app.config import settings

logger = logging.getLogger(__name__)


class JobStatus(str, Enum):
    PENDING = "pending"
    QUEUED = "queued"          # ждёт, пока устройство освободится
    PARSING = "parsing"        # ищем файлы в диапазоне
    MERGING = "merging"        # ffmpeg склейка
    ARCHIVING = "archiving"    # упаковка в zip
    READY = "ready"            # готово к скачиванию
    DOWNLOADED = "downloaded"  # клиент уже забрал
    FAILED = "failed"
    CANCELLED = "cancelled"


FINISHED = (JobStatus.READY, JobStatus.DOWNLOADED, JobStatus.FAILED, JobStatus.CANCELLED)


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
    title: str = ""
    subtitle: str = ""


@dataclass
class Job:
    id: str
    status: JobStatus = JobStatus.PENDING
    # Что это за выгрузка: пережидает перезагрузку страницы
    title: str = ""
    subtitle: str = ""
    progress: float = 0.0
    message: str = ""
    error: Optional[str] = None
    # Результат: по файлу на дорожку; несколько файлов уходят архивом на лету
    result_paths: list[Path] = field(default_factory=list)
    result_filename: Optional[str] = None
    result_media_type: str = "video/mp4"
    # Каталог результатов этой задачи внутри каталога выгрузок
    work_dir: Optional[Path] = None
    result_path: Optional[Path] = None
    files_total: int = 0
    files_processed: int = 0
    bytes_total: int = 0
    duration_seconds: float = 0.0
    finished_at: Optional[float] = None
    cancelled: bool = False
    process: Optional[asyncio.subprocess.Process] = None
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
            title=self.title,
            subtitle=self.subtitle,
        )

    def result_bytes(self) -> int:
        total = 0
        for path in self.result_paths:
            try:
                total += path.stat().st_size
            except OSError:
                continue
        return total


class JobManager:
    """In-memory хранилище задач склейки."""

    def __init__(self):
        self._jobs: dict[str, Job] = {}
        self._lock = asyncio.Lock()
        # Тяжёлая часть идёт по одной: рядом пишутся живые камеры
        self._device = asyncio.Lock()
        self._sweeper: Optional[asyncio.Task] = None

    async def start(self):
        self._sweeper = asyncio.create_task(self._sweep_loop())

    async def stop(self):
        if self._sweeper:
            self._sweeper.cancel()
            try:
                await self._sweeper
            except asyncio.CancelledError:
                pass
            self._sweeper = None

    async def create(self, title: str = "", subtitle: str = "") -> Job:
        async with self._lock:
            job_id = uuid.uuid4().hex
            job = Job(id=job_id, title=title, subtitle=subtitle)
            self._jobs[job_id] = job
            return job

    def device_lock(self) -> asyncio.Lock:
        return self._device

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
            if status in FINISHED and job.finished_at is None:
                job.finished_at = time.monotonic()
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
        """Удалить временные файлы, результаты и саму job."""
        for p in job.temp_files:
            try:
                p.unlink(missing_ok=True)
            except OSError as e:
                logger.warning("Failed to remove %s: %s", p, e)
        for p in job.result_paths:
            try:
                p.unlink(missing_ok=True)
            except OSError as e:
                logger.warning("Failed to remove %s: %s", p, e)
        if job.work_dir:
            shutil.rmtree(job.work_dir, ignore_errors=True)
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

    # Освободить место под новую задачу: готовые результаты уходят от старых к новым
    async def evict(self, need: int) -> int:
        async with self._lock:
            done = sorted(
                (j for j in self._jobs.values()
                 if j.status in (JobStatus.READY, JobStatus.DOWNLOADED) and j.result_paths),
                key=lambda j: j.finished_at or 0.0,
            )
        freed = 0
        for job in done:
            if freed >= need:
                break
            size = job.result_bytes()
            logger.info("Evicting export %s (%d bytes) to make room", job.id, size)
            await self.cleanup(job)
            freed += size
        return freed

    # Нескачанные результаты не живут вечно, законченные задачи не копятся в памяти
    async def _sweep_loop(self):
        while True:
            await asyncio.sleep(60)
            now = time.monotonic()
            async with self._lock:
                stale = [
                    j for j in self._jobs.values()
                    if j.finished_at is not None and (
                        (j.status in (JobStatus.READY, JobStatus.DOWNLOADED)
                         and now - j.finished_at > settings.EXPORT_TTL_SEC)
                        or (j.status in (JobStatus.FAILED, JobStatus.CANCELLED)
                            and now - j.finished_at > 3600)
                    )
                ]
            for job in stale:
                logger.info("Export %s expired (%s)", job.id, job.status.value)
                await self.cleanup(job)


jobs = JobManager()
