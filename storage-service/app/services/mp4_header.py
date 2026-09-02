# Длительность в заголовке фрагментного mp4 для файлов без события закрытия

import logging
import struct
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Заголовок фрагментного mp4 лежит в начале файла: ftyp, free, moov
HEADER_BYTES = 256 * 1024


# Коробки уровня [start, end): имя, начало тела, конец коробки
def _children(data: bytes, start: int, end: int):
    at = start
    while at + 8 <= end and at + 8 <= len(data):
        size = struct.unpack(">I", data[at:at + 4])[0]
        name = data[at + 4:at + 8]
        header = 8

        if size == 1:
            if at + 16 > len(data):
                return
            size = struct.unpack(">Q", data[at + 8:at + 16])[0]
            header = 16
        elif size == 0:
            size = end - at

        if size < header:
            return

        yield name, at + header, min(at + size, len(data))
        at += size


def _find(data: bytes, start: int, end: int, name: bytes):
    for kind, body, stop in _children(data, start, end):
        if kind == name:
            return body, stop
    return None


def _duration_offset(data: bytes, body: int, narrow: int, wide: int) -> tuple[int, bool]:
    is_wide = data[body] == 1
    return body + (wide if is_wide else narrow), is_wide


def _timescale(data: bytes, body: int) -> int:
    at = body + (20 if data[body] == 1 else 12)
    return struct.unpack(">I", data[at:at + 4])[0]


# Длительность, заявленная заголовком; None — заголовка нет
def header_duration_ms(path: Path) -> Optional[int]:
    try:
        with open(path, "rb") as handle:
            data = handle.read(HEADER_BYTES)
    except OSError:
        return None

    moov = _find(data, 0, len(data), b"moov")
    if moov is None:
        return None

    mvhd = _find(data, *moov, b"mvhd")
    if mvhd is None:
        return None

    scale = _timescale(data, mvhd[0])
    if not scale:
        return None

    at, wide = _duration_offset(data, mvhd[0], 16, 24)
    units = struct.unpack(">Q" if wide else ">I", data[at:at + (8 if wide else 4)])[0]
    return int(units * 1000 / scale)


# Дописывает длительность в mvhd, mehd, tkhd и mdhd, не сдвигая байты файла
def write_duration(path: Path, duration_ms: int) -> bool:
    if duration_ms <= 0:
        return False

    try:
        with open(path, "r+b") as handle:
            data = handle.read(HEADER_BYTES)

            moov = _find(data, 0, len(data), b"moov")
            if moov is None:
                return False

            mvhd = _find(data, *moov, b"mvhd")
            if mvhd is None:
                return False

            movie_scale = _timescale(data, mvhd[0])
            if not movie_scale:
                return False

            movie_units = int(duration_ms * movie_scale / 1000)

            def put(body: int, narrow: int, wide_off: int, units: int) -> None:
                at, wide = _duration_offset(data, body, narrow, wide_off)
                handle.seek(at)
                handle.write(struct.pack(">Q" if wide else ">I", units))

            put(mvhd[0], 16, 24, movie_units)

            mvex = _find(data, *moov, b"mvex")
            if mvex is not None:
                mehd = _find(data, *mvex, b"mehd")
                if mehd is not None:
                    put(mehd[0], 4, 4, movie_units)

            # Дорожек может быть несколько, у каждой своя шкала в mdhd
            for kind, body, stop in _children(data, *moov):
                if kind != b"trak":
                    continue

                tkhd = _find(data, body, stop, b"tkhd")
                if tkhd is not None:
                    put(tkhd[0], 20, 28, movie_units)

                mdia = _find(data, body, stop, b"mdia")
                if mdia is None:
                    continue
                mdhd = _find(data, *mdia, b"mdhd")
                if mdhd is None:
                    continue

                media_scale = _timescale(data, mdhd[0])
                if media_scale:
                    put(mdhd[0], 16, 24, int(duration_ms * media_scale / 1000))

        return True
    except OSError as e:
        logger.warning("Cannot write duration into %s: %s", path, e)
        return False
