import logging
import subprocess
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from app.config import settings
from app.services.storage import storage

logger = logging.getLogger(__name__)


class MergeError(Exception):
    """Ошибка склейки."""
    pass


def merge_range(
        camera: str,
        date: str,
        start_minutes: float,
        end_minutes: float,
) -> tuple[Path, Path]:
    """
    Склеивает фрагменты в указанном диапазоне.
    Возвращает (output_file, list_file) — обе временные, требуют cleanup'а.
    """
    camera_path = storage.root / camera
    if not camera_path.is_dir():
        raise MergeError(f"Camera '{camera}' not found")

    all_files = sorted(
        (f for f in camera_path.glob("*.mp4") if f.is_file()),
        key=lambda x: x.name,
    )
    if not all_files:
        raise MergeError("No video files found for this camera")

    try:
        date_obj = datetime.strptime(date, "%Y-%m-%d")
    except ValueError as e:
        raise MergeError(f"Invalid date format: {e}")

    start_time = date_obj + timedelta(minutes=start_minutes)
    end_time = date_obj + timedelta(minutes=end_minutes)

    relevant = [
        f for f in all_files
        if _intersects(f, start_time, end_time)
    ]
    if not relevant:
        raise MergeError(
            f"No recordings in range "
            f"{start_time.strftime('%H:%M')}-{end_time.strftime('%H:%M')}"
        )

    temp_dir = Path(tempfile.gettempdir())
    timestamp = int(datetime.now().timestamp())
    list_file = temp_dir / f"merge_{camera}_{timestamp}.txt"
    output_file = (
            temp_dir
            / f"{camera}_{date}_{int(start_minutes):04d}-{int(end_minutes):04d}.mp4"
    )

    with open(list_file, "w") as f:
        for video in relevant:
            f.write(f"file '{video.absolute()}'\n")

    cmd = [
        "ffmpeg", "-f", "concat", "-safe", "0",
        "-i", str(list_file), "-c", "copy", "-y", str(output_file),
    ]
    logger.info("Running ffmpeg for %s", camera)

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=settings.MERGE_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired:
        list_file.unlink(missing_ok=True)
        raise MergeError("Merge timeout — try shorter range")

    if result.returncode != 0:
        list_file.unlink(missing_ok=True)
        output_file.unlink(missing_ok=True)
        raise MergeError(f"ffmpeg failed: {result.stderr[:200]}")

    if not output_file.exists():
        list_file.unlink(missing_ok=True)
        raise MergeError("Output file was not created")

    return output_file, list_file


def _intersects(video: Path, start: datetime, end: datetime) -> bool:
    try:
        file_time = datetime.fromtimestamp(video.stat().st_ctime)
    except OSError:
        return False
    file_end = file_time + timedelta(minutes=10)
    return file_time <= end and file_end >= start