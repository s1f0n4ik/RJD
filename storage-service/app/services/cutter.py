"""
Склейка и выгрузка по индексу сегментов.

Отличие от прежней склейки: куски подбираются не обходом каталога по «минутам
от полуночи», а по базе — в нормализованном времени изделия. Поток копируется
без перекодирования, поэтому левая граница ложится на ближайший предшествующий
ключевой кадр; фактические границы результата возвращаются вместе с ним, чтобы
запрошенное и полученное можно было сравнить.

Разрывы внутри диапазона проходятся насквозь: в файле их просто нет, и время в
нём идёт непрерывно. Насколько итог короче запроса, интерфейс говорит заранее.
"""

import logging
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from app.services.jobs import Job, JobStatus, jobs
from app.services.merger import run_ffmpeg_concat, zip_files
from app.services.segments import index

logger = logging.getLogger(__name__)


def _stamp(ms: int) -> str:
    """Метка для имени файла в настенном времени изделия."""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")


def _pick(camera: str, stream: str, from_ms: int, to_ms: int) -> list[dict]:
    segments = index.range_segments(camera, stream, from_ms, to_ms)
    if not segments:
        raise RuntimeError("No recordings in the selected range")

    existing = [s for s in segments if Path(s["path"]).exists()]
    if not existing:
        raise RuntimeError("Files of the selected range are missing on disk")

    return existing


async def run_cut_job(
    job: Job,
    *,
    camera: str,
    stream: str,
    from_ms: int,
    to_ms: int,
):
    """Склейка диапазона в один MP4 копированием потока."""
    try:
        if job.cancelled:
            return

        await jobs.update(job, status=JobStatus.PARSING, message="Подбираем сегменты...")

        segments = _pick(camera, stream, from_ms, to_ms)
        recorded_ms = sum(
            max(0, min(s["end_ms"], to_ms) - max(s["start_ms"], from_ms))
            for s in segments
        )

        job.files_total = len(segments)
        job.duration_seconds = recorded_ms / 1000

        temp_dir = Path(tempfile.gettempdir())
        list_file = temp_dir / f"cut_{job.id}.txt"
        progress_file = temp_dir / f"progress_{job.id}.txt"
        output = temp_dir / f"{camera}_{_stamp(from_ms)}_{_stamp(to_ms)}.mp4"
        job.temp_files.extend([list_file, progress_file])

        with open(list_file, "w") as handle:
            for segment in segments:
                escaped = segment["path"].replace("'", "'\\''")
                handle.write(f"file '{escaped}'\n")

        # Отступ внутрь первого сегмента: с копированием потока он ляжет на
        # ближайший предшествующий ключевой кадр
        trim_start = max(0.0, (from_ms - segments[0]["start_ms"]) / 1000)

        await jobs.update(
            job,
            status=JobStatus.MERGING,
            progress=0.0,
            message=f"Склейка {len(segments)} сегментов...",
        )

        await run_ffmpeg_concat(
            list_file=list_file,
            output_file=output,
            progress_file=progress_file,
            expected_seconds=recorded_ms / 1000,
            on_progress=lambda p: jobs.update(job, progress=p),
            job=job,
            files_count=len(segments),
            trim_start_sec=trim_start,
            trim_duration_sec=recorded_ms / 1000 if recorded_ms else None,
        )

        if not output.exists():
            raise RuntimeError("Output file was not created")

        job.temp_files.append(output)
        job.result_path = output
        job.result_filename = output.name
        job.result_media_type = "video/mp4"
        job.files_processed = len(segments)
        job.bytes_total = output.stat().st_size

        size_mb = job.bytes_total / 1024 ** 2
        await jobs.update(
            job,
            status=JobStatus.READY,
            progress=1.0,
            message=f"Готово ({size_mb:.1f} МБ)",
        )

    except Exception as e:
        logger.exception("Cut job %s failed", job.id)
        await jobs.update(job, status=JobStatus.FAILED, error=str(e), message=f"Ошибка: {e}")
        await jobs.cleanup(job)


async def run_zip_job(
    job: Job,
    *,
    camera: str,
    stream: str,
    from_ms: int,
    to_ms: int,
):
    """Выгрузка исходных сегментов диапазона одним архивом, без обработки."""
    try:
        if job.cancelled:
            return

        await jobs.update(job, status=JobStatus.PARSING, message="Подбираем файлы...")

        segments = _pick(camera, stream, from_ms, to_ms)
        files = [Path(s["path"]) for s in segments]
        total_bytes = sum(s["size_bytes"] or 0 for s in segments)
        job.files_total = len(files)

        temp_dir = Path(tempfile.gettempdir())
        output = temp_dir / f"{camera}_{_stamp(from_ms)}_{_stamp(to_ms)}.zip"
        job.temp_files.append(output)

        await jobs.update(
            job,
            status=JobStatus.ARCHIVING,
            progress=0.0,
            message=f"Архивация {len(files)} файлов...",
        )

        await zip_files(files=files, target=output, total_bytes=total_bytes, job=job)

        if job.cancelled:
            return

        job.result_path = output
        job.result_filename = output.name
        job.result_media_type = "application/zip"
        job.bytes_total = output.stat().st_size

        size_mb = job.bytes_total / 1024 ** 2
        await jobs.update(
            job,
            status=JobStatus.READY,
            progress=1.0,
            message=f"Готово ({size_mb:.1f} МБ)",
        )

    except Exception as e:
        logger.exception("Zip job %s failed", job.id)
        await jobs.update(job, status=JobStatus.FAILED, error=str(e), message=f"Ошибка: {e}")
        await jobs.cleanup(job)
