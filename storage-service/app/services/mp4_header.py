# Длительность в заголовке фрагментного mp4 для файлов без события закрытия

import logging
import os
import struct
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Заголовок фрагментного mp4 лежит в начале файла: ftyp, free, moov
HEADER_BYTES = 256 * 1024

# Кадр длиннее этого — разрыв записи внутри файла, мс; как порог разрыва таймлайна
HOLE_MS = 2_000

# Разрыв в первых мс файла — головной: до него старая группа кадров после заморозки; как kStaleLagMs в media-center
LEADING_HOLE_MS = 3_000


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


# Шкала и длительность кадра по умолчанию у каждой дорожки: track_ID -> (timescale, default_duration)
def _tracks(data: bytes, moov: tuple[int, int]) -> dict[int, tuple[int, int]]:
    defaults: dict[int, int] = {}
    mvex = _find(data, *moov, b"mvex")
    if mvex is not None:
        for kind, body, _stop in _children(data, *mvex):
            if kind == b"trex":
                track_id, duration = struct.unpack(">I4xI", data[body + 4:body + 16])
                defaults[track_id] = duration

    tracks: dict[int, tuple[int, int]] = {}
    for kind, body, stop in _children(data, *moov):
        if kind != b"trak":
            continue
        tkhd = _find(data, body, stop, b"tkhd")
        mdia = _find(data, body, stop, b"mdia")
        mdhd = _find(data, *mdia, b"mdhd") if mdia is not None else None
        if tkhd is None or mdhd is None:
            continue
        track_id = struct.unpack(">I", data[tkhd[0] + (20 if data[tkhd[0]] == 1 else 12):][:4])[0]
        scale = _timescale(data, mdhd[0])
        if scale:
            tracks[track_id] = (scale, defaults.get(track_id, 0))
    return tracks


# Отрезки времени дорожек в одном moof: (track_ID, начало, конец, разрывы) в единицах шкалы дорожки
def _moof_spans(moof: bytes, tracks: dict[int, tuple[int, int]]) -> list[tuple[int, int, int, list[tuple[int, int]]]]:
    spans = []
    for kind, body, stop in _children(moof, 8, len(moof)):
        if kind != b"traf":
            continue
        track_id, default, start, duration = None, 0, None, 0
        holes: list[tuple[int, int]] = []
        for name, at, _end in _children(moof, body, stop):
            if name == b"tfhd":
                flags = int.from_bytes(moof[at + 1:at + 4], "big")
                track_id = struct.unpack(">I", moof[at + 4:at + 8])[0]
                default = tracks.get(track_id, (0, 0))[1]
                offset = at + 8 + (8 if flags & 0x01 else 0) + (4 if flags & 0x02 else 0)
                if flags & 0x08:
                    default = struct.unpack(">I", moof[offset:offset + 4])[0]
            elif name == b"tfdt":
                wide = moof[at] == 1
                start = struct.unpack(">Q" if wide else ">I", moof[at + 4:at + (12 if wide else 8)])[0]
            elif name == b"trun":
                flags = int.from_bytes(moof[at + 1:at + 4], "big")
                count = struct.unpack(">I", moof[at + 4:at + 8])[0]
                hole = HOLE_MS * tracks.get(track_id, (0, 0))[0] // 1000
                if not flags & 0x100:
                    # Разрыв бывает отдельным фрагментом из одного кадра с длительностью по умолчанию
                    if hole and default > hole:
                        holes.extend((duration + i * default, duration + (i + 1) * default) for i in range(count))
                    duration += count * default
                    continue
                cursor = at + 8 + (4 if flags & 0x01 else 0) + (4 if flags & 0x04 else 0)
                step = 4 * sum(1 for bit in (0x100, 0x200, 0x400, 0x800) if flags & bit)
                for _ in range(count):
                    sample = struct.unpack(">I", moof[cursor:cursor + 4])[0]
                    # Разрыв записи mp4mux кладёт длительностью кадра перед ним
                    if hole and sample > hole:
                        holes.append((duration, duration + sample))
                    duration += sample
                    cursor += step
        if track_id in tracks and start is not None:
            spans.append((track_id, start, start + duration, [(start + a, start + b) for a, b in holes]))
    return spans


# Коробка в файле: (имя, конец) или None, если заголовок битый или коробка не помещается в файл
def _box_at(handle, at: int, size: int) -> Optional[tuple[bytes, int]]:
    handle.seek(at)
    head = handle.read(16)
    if len(head) < 8:
        return None
    box_size, name = struct.unpack(">I4s", head[:8])
    header = 8
    if box_size == 1:
        if len(head) < 16:
            return None
        box_size, header = struct.unpack(">Q", head[8:16])[0], 16
    elif box_size == 0:
        box_size = size - at
    if box_size < header or at + box_size > size or not name.isalnum():
        return None
    return name, at + box_size


# Начало следующего целого moof после from_at: по сигнатуре и вложенной mfhd
def _next_moof(handle, from_at: int, size: int) -> Optional[int]:
    chunk = 1 << 20
    at = from_at
    while at < size:
        handle.seek(at)
        data = handle.read(chunk + 16)
        index = data.find(b"moof")
        while index != -1:
            start = at + index - 4
            if start >= from_at and data[index + 8:index + 12] == b"mfhd":
                box = _box_at(handle, start, size)
                if box is not None and box[0] == b"moof":
                    return start
            index = data.find(b"moof", index + 1)
        at += chunk
    return None


# Длительность того, что реально лежит в файле, по moof/tfdt/trun; None — мерить нечем, 0 — после заголовка нет данных
def content_duration_ms(path: Path) -> Optional[int]:
    try:
        with open(path, "rb") as handle:
            size = os.fstat(handle.fileno()).st_size
            data = handle.read(HEADER_BYTES)
            moov = _find(data, 0, len(data), b"moov")
            if moov is None:
                return None
            tracks = _tracks(data, moov)
            if not tracks:
                return None

            first: dict[int, int] = {}
            last: dict[int, int] = {}
            holes: dict[int, list[tuple[int, int]]] = {}
            pending: list[tuple[int, int, int, list[tuple[int, int]]]] = []
            has_data = False
            at = moov[1]
            while at + 8 <= size:
                box = _box_at(handle, at, size)
                # Битая или обрезанная коробка: дальше ищется следующий целый фрагмент
                if box is None:
                    has_data = True
                    pending = []
                    at = _next_moof(handle, at + 8, size)
                    if at is None:
                        break
                    continue

                name, end = box
                if name == b"moof":
                    handle.seek(at)
                    pending = _moof_spans(handle.read(end - at), tracks)
                elif name == b"mdat":
                    has_data = True
                    for track_id, start, stop, gaps in pending:
                        first.setdefault(track_id, start)
                        last[track_id] = max(last.get(track_id, stop), stop)
                        holes.setdefault(track_id, []).extend(gaps)
                    pending = []
                elif name not in (b"free", b"skip", b"mfra"):
                    has_data = True
                at = end
    except (OSError, struct.error):
        return None

    if not last:
        return None if has_data else 0

    def from_fresh(track_id: int) -> int:
        scale = tracks[track_id][0]
        lead = LEADING_HOLE_MS * scale // 1000
        # Начало — конец головного разрыва, если он есть: старая группа кадров на таймлайн не идёт
        begin = max([b for a, b in holes.get(track_id, []) if a - first[track_id] < lead], default=first[track_id])
        return (last[track_id] - begin) * 1000 // scale

    # Кадры есть, но все до головного разрыва: пустым такой файл не считается
    fresh = max(from_fresh(t) for t in last)
    return fresh if fresh > 0 else None


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
