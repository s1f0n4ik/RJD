import asyncio
import logging
import re
import subprocess
import tempfile
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

from app.config import settings
from app.services.jobs import Job, JobStatus, jobs
from app.services.storage import storage

logger = logging.getLogger(__name__)


async def run_merge_job(
        job: Job,
        *,
        camera: str,
        date: str,
        start_minutes: float,
        end_minutes: float,
        archive: bool,
):
    """
    Полный жизненный цикл задачи склейки. Сама обновляет прогресс job через jobs.update().
    """
    try:
        # ── Фаза 1: парсинг ──
        await jobs.update(job, status=JobStatus.PARSING, message="Подбираем фрагменты...")

        camera_path = storage.root / camera
        if not camera_path.is_dir():
            raise RuntimeError(f"Camera '{camera}' not found")

        try:
            date_obj = datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise RuntimeError("Invalid date format, expected YYYY-MM-DD")

        start_time = date_obj + timedelta(minutes=start_minutes)
        end_time = date_obj + timedelta(minutes=end_minutes)
        expected_seconds = (end_time - start_time).total_seconds()

        relevant = _collect_files(camera_path, start_time, end_time)
        if not relevant:
            raise RuntimeError("No recordings in the selected range")

        logger.info("Job %s: %d files in range", job.id, len(relevant))

        # ── Фаза 2: подготовка ──
        temp_dir = Path(tempfile.gettempdir())
        timestamp = int(datetime.now().timestamp())
        list_file = temp_dir / f"merge_{camera}_{timestamp}.txt"
        output_mp4 = temp_dir / (
            f"{camera}_{date}_"
            f"{int(start_minutes):04d}-{int(end_minutes):04d}.mp4"
        )
        progress_file = temp_dir / f"progress_{job.id}.txt"

        job.temp_files.extend([list_file, progress_file])

        with open(list_file, "w") as f:
            for v in relevant:
                f.write(f"file '{v.absolute()}'\n")

        # ── Фаза 3: ffmpeg с прогрессом ──
        await jobs.update(
            job,
            status=JobStatus.MERGING,
            progress=0.0,
            message=f"Склейка {len(relevant)} файлов...",
        )

        await _run_ffmpeg_with_progress(
            list_file=list_file,
            output_file=output_mp4,
            progress_file=progress_file,
            expected_seconds=expected_seconds,
            on_progress=lambda p: jobs.update(job, progress=p),
        )

        if not output_mp4.exists():
            raise RuntimeError("Output file was not created")

        job.temp_files.append(output_mp4)

        # ── Фаза 4: упаковка в zip (опционально) ──
        if archive:
            await jobs.update(
                job,
                status=JobStatus.ARCHIVING,
                progress=0.0,
                message="Упаковка в архив...",
            )
            output_zip = temp_dir / (output_mp4.stem + ".zip")
            await _zip_file(
                source=output_mp4,
                target=output_zip,
                on_progress=lambda p: jobs.update(job, progress=p),
            )
            job.temp_files.append(output_zip)
            job.result_path = output_zip
            job.result_filename = output_zip.name
            job.result_media_type = "application/zip"
        else:
            job.result_path = output_mp4
            job.result_filename = output_mp4.name
            job.result_media_type = "video/mp4"

        # ── Готово ──
        size_mb = job.result_path.stat().st_size / 1024 ** 2
        await jobs.update(
            job,
            status=JobStatus.READY,
            progress=1.0,
            message=f"Готово ({size_mb:.1f} МБ). Скачивайте.",
        )

    except Exception as e:
        logger.exception("Job %s failed", job.id)
        await jobs.update(
            job, status=JobStatus.FAILED, error=str(e), message=f"Ошибка: {e}"
        )
        await jobs.cleanup(job)


def _collect_files(camera_path: Path, start: datetime, end: datetime) -> list[Path]:
    out = []
    for f in sorted(camera_path.glob("*.mp4")):
        if not f.is_file():
            continue
        try:
            ft = datetime.fromtimestamp(f.stat().st_ctime)
        except OSError:
            continue
        f_end = ft + timedelta(minutes=10)
        if ft <= end and f_end >= start:
            out.append(f)
    return out


# ── ffmpeg с парсингом прогресса ──

_TIME_RE = re.compile(r"out_time_ms=(\d+)")


async def _run_ffmpeg_with_progress(
        *,
        list_file: Path,
        output_file: Path,
        progress_file: Path,
        expected_seconds: float,
        on_progress,
):
    """
    Запускает ffmpeg с -progress в отдельный файл и периодически парсит его.
    Прогресс — отношение out_time_ms к ожидаемой длительности диапазона.
    """
    cmd = [
        "ffmpeg",
        "-f", "concat", "-safe", "0",
        "-i", str(list_file),
        "-c", "copy",
        "-progress", str(progress_file),
        "-y",
        str(output_file),
    ]
    logger.info("ffmpeg: %s", " ".join(cmd))

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    # Задача, которая каждые 500мс читает progress-файл
    poll_task = asyncio.create_task(
        _poll_progress(progress_file, expected_seconds, on_progress, proc)
    )

    try:
        _, stderr = await asyncio.wait_for(
            proc.communicate(),
            timeout=settings.MERGE_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError("Merge timeout — try a shorter range")
    finally:
        poll_task.cancel()
        try:
            await poll_task
        except asyncio.CancelledError:
            pass

    if proc.returncode != 0:
        err = (stderr or b"").decode(errors="replace")[-500:]
        raise RuntimeError(f"ffmpeg failed: {err}")


async def _poll_progress(
        progress_file: Path,
        expected_seconds: float,
        on_progress,
        proc: asyncio.subprocess.Process,
):
    last_progress = 0.0
    while proc.returncode is None:
        await asyncio.sleep(0.5)
        if not progress_file.exists():
            continue
        try:
            text = progress_file.read_text(errors="replace")
        except OSError:
            continue

        # Берём последнее значение out_time_ms из файла
        matches = _TIME_RE.findall(text)
        if not matches:
            continue
        out_time_us = int(matches[-1])
        out_seconds = out_time_us / 1_000_000
        if expected_seconds <= 0:
            continue
        progress = out_seconds / expected_seconds
        # Защита от рывков: только если выросло заметно
        if progress - last_progress >= 0.01:
            last_progress = progress
            await on_progress(min(progress, 0.99))   # 100% ставит фаза merging-завершилась


# ── Архивация ──

async def _zip_file(*, source: Path, target: Path, on_progress):
    """Архивирует один файл в zip с периодическим обновлением прогресса."""
    loop = asyncio.get_running_loop()
    total_size = source.stat().st_size

    def _do_zip():
        # Простой stored-zip без сжатия был бы быстрее, но мы кладём
        # как deflate чтобы реально экономить место. Если хочется максимально
        # быстро — поменяй на ZIP_STORED.
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as zf:
            zf.write(source, arcname=source.name)

    # Простой подход: запускаем зип в executor, параллельно — таймер на проценты.
    zip_task = loop.run_in_executor(None, _do_zip)

    # Простой эвристический прогресс по размеру целевого файла
    while not zip_task.done():
        await asyncio.sleep(0.5)
        if target.exists():
            try:
                cur = target.stat().st_size
                # zip обычно меньше source, но как индикатор подходит
                progress = min(cur / total_size, 0.95)
                await on_progress(progress)
            except OSError:
                pass

    await zip_task
    await on_progress(1.0)