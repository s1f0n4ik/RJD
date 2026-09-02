"""
Кадр архива на заданный момент времени.

Лупа таймлайна показывает, что было под курсором. Сегмент берётся из индекса в
нормализованном времени изделия, кадр вынимается ffmpeg-ом с перемоткой перед
входным файлом — она идёт по ключевым кадрам и стоит десятки миллисекунд.
Последние кадры лежат в памяти: мышь ходит по одному месту, а процесс на каждое
её движение изделию дорог.
"""

import logging
import subprocess
from collections import OrderedDict
from pathlib import Path
from typing import Optional

from app.services.segments import index

logger = logging.getLogger(__name__)

# Ширина превью в пикселях, высота считается по соотношению сторон
FRAME_WIDTH = 256

# Кадры внутри одной корзины считаются одним и тем же
BUCKET_MS = 1_000

CACHE_SIZE = 96
FFMPEG_TIMEOUT_S = 6

_cache: "OrderedDict[tuple[str, int], bytes]" = OrderedDict()


def _remember(key: tuple[str, int], data: bytes) -> None:
    _cache[key] = data
    _cache.move_to_end(key)
    while len(_cache) > CACHE_SIZE:
        _cache.popitem(last=False)


def _extract(path: Path, offset_ms: int) -> Optional[bytes]:
    """Один кадр в JPEG; None, если ffmpeg ничего не отдал."""
    command = [
        "ffmpeg", "-nostdin", "-loglevel", "error",
        "-ss", f"{offset_ms / 1000:.3f}",
        "-i", str(path),
        "-frames:v", "1",
        "-vf", f"scale={FRAME_WIDTH}:-2",
        "-f", "mjpeg", "-",
    ]

    try:
        result = subprocess.run(
            command, capture_output=True, timeout=FFMPEG_TIMEOUT_S, check=False
        )
    except subprocess.TimeoutExpired:
        logger.warning("Frame extraction timed out: %s at %d ms", path, offset_ms)
        return None

    if result.returncode != 0 or not result.stdout:
        logger.debug(
            "Frame extraction failed for %s at %d ms: %s",
            path, offset_ms, result.stderr.decode("utf-8", "replace").strip(),
        )
        return None

    return result.stdout


def frame_at(camera_id: str, stream_key: str, ms: int) -> Optional[bytes]:
    """Кадр дорожки на момент времени изделия; None, если записи там нет."""
    # У строк без конца выборка подставляет запасную длительность, поэтому в
    # кандидаты попадает всё, что началось незадолго до момента. Нужен
    # последний из них — он единственный может содержать этот кадр
    started = [
        segment for segment in index.range_segments(camera_id, stream_key, ms, ms + 1)
        if segment["start_ms"] <= ms
    ]
    if not started:
        return None

    segment = started[-1]
    path = Path(segment["path"])
    if not path.exists():
        return None

    offset_ms = max(0, ms - segment["start_ms"])
    key = (segment["path"], offset_ms // BUCKET_MS)

    cached = _cache.get(key)
    if cached is not None:
        _cache.move_to_end(key)
        return cached

    data = _extract(path, offset_ms)
    if data is not None:
        _remember(key, data)

    return data
