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
    return [s for s in segments if Path(s["path"]).exists()]


def _recorded_ms(segments: list[dict], from_ms: int, to_ms: int) -> int:
    return sum(
        max(0, min(s["end_ms"], to_ms) - max(s["start_ms"], from_ms))
        for s in segments
    )


async def run_cut_job(job: Job, *, tracks: list[dict], from_ms: int, to_ms: int):
    """Склейка диапазона копированием потока, по файлу на каждую дорожку."""
    try:
        if job.cancelled:
            return

        await jobs.update(job, status=JobStatus.QUEUED, message="Устройство занято")
        async with jobs.device_lock():
            if job.cancelled:
                return
            await _cut(job, tracks, from_ms, to_ms)

    except Exception as e:
        logger.exception("Cut job %s failed", job.id)
        await jobs.update(job, status=JobStatus.FAILED, error=str(e), message=f"Ошибка: {e}")
        await jobs.cleanup(job)


async def _cut(job: Job, tracks: list[dict], from_ms: int, to_ms: int) -> None:
    await jobs.update(job, status=JobStatus.PARSING, progress=0.0, message="Подбираем сегменты...")

    temp_dir = Path(tempfile.gettempdir())
    picked: list[tuple[dict, list[dict]]] = []

    for track in tracks:
        segments = _pick(track["camera"], track["stream"], from_ms, to_ms)
        if segments:
            picked.append((track, segments))

    if not picked:
        raise RuntimeError("No recordings in the selected range")

    job.files_total = sum(len(segments) for _, segments in picked)
    job.duration_seconds = sum(_recorded_ms(s, from_ms, to_ms) for _, s in picked) / 1000

    await jobs.update(job, status=JobStatus.MERGING, progress=0.0,
                      message=f"Склейка {len(picked)} дорожек...")

    results: list[Path] = []
    done = 0

    for track, segments in picked:
        if job.cancelled:
            return

        camera = track["camera"]
        recorded_ms = _recorded_ms(segments, from_ms, to_ms)

        list_file = temp_dir / f"cut_{job.id}_{len(results)}.txt"
        progress_file = temp_dir / f"progress_{job.id}_{len(results)}.txt"
        output = temp_dir / f"{camera}_{_stamp(from_ms)}_{_stamp(to_ms)}.mp4"
        job.temp_files.extend([list_file, progress_file, output])

        with open(list_file, "w") as handle:
            for segment in segments:
                escaped = segment["path"].replace("'", "'\\''")
                handle.write(f"file '{escaped}'\n")

        # Отступ внутрь первого сегмента ложится на ближайший ключевой кадр
        trim_start = max(0.0, (from_ms - segments[0]["start_ms"]) / 1000)
        base = done

        async def on_progress(value: float, base=base) -> None:
            await jobs.update(job, progress=(base + value) / len(picked))

        await run_ffmpeg_concat(
            list_file=list_file,
            output_file=output,
            progress_file=progress_file,
            expected_seconds=recorded_ms / 1000,
            on_progress=on_progress,
            job=job,
            files_count=len(segments),
            trim_start_sec=trim_start,
            trim_duration_sec=recorded_ms / 1000 if recorded_ms else None,
        )

        if not output.exists():
            raise RuntimeError(f"Output file was not created: {camera}")

        results.append(output)
        done += 1
        job.files_processed = sum(len(s) for _, s in picked[:done])

    if job.cancelled:
        return

    if len(results) == 1:
        job.result_path = results[0]
        job.result_media_type = "video/mp4"
    else:
        await jobs.update(job, status=JobStatus.ARCHIVING, progress=0.99,
                          message=f"Упаковка {len(results)} файлов...")
        archive = temp_dir / f"archive_{_stamp(from_ms)}_{_stamp(to_ms)}.zip"
        job.temp_files.append(archive)

        await zip_files(
            entries=[(f, f.name) for f in results],
            target=archive,
            total_bytes=sum(f.stat().st_size for f in results),
            job=job,
        )
        job.result_path = archive
        job.result_media_type = "application/zip"

    job.result_filename = job.result_path.name
    job.bytes_total = job.result_path.stat().st_size

    size_mb = job.bytes_total / 1024 ** 2
    await jobs.update(job, status=JobStatus.READY, progress=1.0, message=f"Готово ({size_mb:.1f} МБ)")


async def run_zip_job(job: Job, *, tracks: list[dict], from_ms: int, to_ms: int):
    """Выгрузка исходных сегментов диапазона архивом, папка на камеру."""
    try:
        if job.cancelled:
            return

        await jobs.update(job, status=JobStatus.QUEUED, message="Устройство занято")
        async with jobs.device_lock():
            if job.cancelled:
                return
            await _zip(job, tracks, from_ms, to_ms)

    except Exception as e:
        logger.exception("Zip job %s failed", job.id)
        await jobs.update(job, status=JobStatus.FAILED, error=str(e), message=f"Ошибка: {e}")
        await jobs.cleanup(job)


async def _zip(job: Job, tracks: list[dict], from_ms: int, to_ms: int) -> None:
    await jobs.update(job, status=JobStatus.PARSING, progress=0.0, message="Подбираем файлы...")

    entries: list[tuple[Path, str]] = []
    total_bytes = 0
    cameras: set[str] = set()

    for track in tracks:
        camera = track["camera"]
        for segment in _pick(camera, track["stream"], from_ms, to_ms):
            entries.append((Path(segment["path"]), f"{camera}/{Path(segment['path']).name}"))
            total_bytes += segment["size_bytes"] or 0
            cameras.add(camera)

    if not entries:
        raise RuntimeError("No recordings in the selected range")

    job.files_total = len(entries)
    job.duration_seconds = 0

    temp_dir = Path(tempfile.gettempdir())
    name = next(iter(cameras)) if len(cameras) == 1 else "archive"
    output = temp_dir / f"{name}_{_stamp(from_ms)}_{_stamp(to_ms)}.zip"
    job.temp_files.append(output)

    await jobs.update(job, status=JobStatus.ARCHIVING, progress=0.0,
                      message=f"Архивация {len(entries)} файлов...")

    await zip_files(entries=entries, target=output, total_bytes=total_bytes, job=job)

    if job.cancelled:
        return

    job.result_path = output
    job.result_filename = output.name
    job.result_media_type = "application/zip"
    job.bytes_total = output.stat().st_size

    size_mb = job.bytes_total / 1024 ** 2
    await jobs.update(job, status=JobStatus.READY, progress=1.0, message=f"Готово ({size_mb:.1f} МБ)")
