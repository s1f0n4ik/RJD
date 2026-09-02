"""
Индекс архивных сегментов.

media-center пишет в базу голые факты: когда фрагмент открылся, когда закрылся,
где лежит и сколько весит. Времени он не считает — на изделии без CAN и интернета
настенные часы врут, поэтому у каждой строки есть ещё и монотонное время, которое
не врёт никогда.

Раскладкой по календарю занимается этот модуль. У каждой сессии (одного запуска
media-center) есть якорь: сдвиг, которым монотонная шкала превращается в
настенную. Достоверный якорь берётся из первой точки сессии, где время пришло с
шины, и чинит задним числом всё, что записано до этого момента. Недостоверный
якорь ставится «монотонной стеной»: сессия не может начаться раньше, чем
кончилась предыдущая, поэтому сутки физически не накладываются друг на друга.
"""

import logging
import os
import re
import sqlite3
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional

from app.config import settings
from app.services.storage import storage

logger = logging.getLogger(__name__)

DAY_MS = 86_400_000
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".ts"}

# Таймштамп в имени фрагмента: <camera>_YYYY-MM-DD_HH-MM-SS.mp4
FILENAME_TS = re.compile(r"(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})")

# Записи, сделанные до появления потоков, лежат прямо в папке камеры
LEGACY_STREAM = "legacy"

# Зазор между сегментами больше этого — уже разрыв, а не смена файла
GAP_THRESHOLD_MS = 2_000

# Сессии раздвигаются на эту величину, чтобы соседние не совпадали краями
SESSION_SPACING_MS = 1_000

# Открытая строка, файл которой давно не менялся, — след обрыва питания
OPEN_STALE_SEC = 120

# Потолок длительности сегмента, когда её нечем измерить
FALLBACK_DURATION_MS = 600_000

# Источники, которым можно верить. sadko — нынешнее имя, can — прежнее
TRUSTED_SOURCES = ("sadko", "can")


@dataclass
class FSession:
    uid: str
    started_mono_ms: int
    started_wall_ms: int
    time_source: str
    anchor_ms: int = 0
    trusted: bool = False


class SegmentIndex:
    """Чтение индекса сегментов и нормализация времени."""

    def __init__(self, db_path: Path):
        self.db_path = db_path

    @property
    def records_root(self) -> Path:
        # Путь записей меняется в рантайме через API — берём его у storage
        return storage.root

    # ── соединение ──

    def _connect(self) -> Optional[sqlite3.Connection]:
        if not self.db_path.exists():
            return None
        conn = sqlite3.connect(self.db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000;")
        return conn

    def available(self) -> bool:
        conn = self._connect()
        if conn is None:
            return False
        try:
            return self._has_table(conn, "segments")
        finally:
            conn.close()

    @staticmethod
    def _has_table(conn: sqlite3.Connection, name: str) -> bool:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?;", (name,)
        ).fetchone()
        return row is not None

    def _ensure_own_schema(self, conn: sqlite3.Connection) -> None:
        """Таблица поправок принадлежит storage-service, её создаём сами."""
        conn.execute(
            "CREATE TABLE IF NOT EXISTS session_time("
            "  session_uid TEXT PRIMARY KEY,"
            "  anchor_ms INTEGER NOT NULL,"
            "  trusted INTEGER NOT NULL DEFAULT 0,"
            "  computed_at INTEGER"
            ");"
        )
        conn.commit()

    # ── якоря сессий ──

    def _load_sessions(self, conn: sqlite3.Connection) -> list[FSession]:
        """
        Считает якорь каждой сессии. Порядок сессий — порядок их появления в
        базе, то есть порядок загрузок изделия.
        """
        if not self._has_table(conn, "sessions"):
            return []

        rows = conn.execute(
            "SELECT uid, started_mono_ms, started_wall_ms, time_source"
            " FROM sessions ORDER BY id;"
        ).fetchall()

        sessions: list[FSession] = []
        wall_floor: Optional[int] = None

        for row in rows:
            session = FSession(
                uid=row["uid"],
                started_mono_ms=row["started_mono_ms"],
                started_wall_ms=row["started_wall_ms"],
                time_source=row["time_source"] or "none",
            )

            trusted_anchor = self._trusted_anchor(conn, session)
            if trusted_anchor is not None:
                session.anchor_ms = trusted_anchor
                session.trusted = True
            else:
                # Догадка по часам изделия — годится, только если не залезает
                # на уже уложенные сессии
                guess = session.started_wall_ms - session.started_mono_ms
                if wall_floor is not None and guess < wall_floor:
                    guess = wall_floor
                session.anchor_ms = guess
                session.trusted = False

            end = self._session_end_ms(conn, session)
            if end is not None:
                wall_floor = end + SESSION_SPACING_MS

            sessions.append(session)

        return sessions

    @staticmethod
    def _trusted_anchor(conn: sqlite3.Connection, session: FSession) -> Optional[int]:
        """
        Сдвиг монотонной шкалы к настоящему времени. Берётся из первой точки
        сессии, где время пришло от Садко: ею чинится вся сессия целиком,
        включая записанное до того, как источник времени ожил.

        can — как это называлось до переименования источника; старые базы
        читаются наравне с новыми.
        """
        if session.time_source in TRUSTED_SOURCES:
            return session.started_wall_ms - session.started_mono_ms

        row = conn.execute(
            "SELECT wall_start_ms, mono_start_ms FROM segments"
            " WHERE session_uid=? AND time_source IN (?, ?)"
            " ORDER BY mono_start_ms LIMIT 1;",
            (session.uid, *TRUSTED_SOURCES),
        ).fetchone()

        if row is None:
            return None
        return row["wall_start_ms"] - row["mono_start_ms"]

    @staticmethod
    def _session_end_ms(conn: sqlite3.Connection, session: FSession) -> Optional[int]:
        """Конец сессии по её последнему сегменту, в нормализованном времени."""
        row = conn.execute(
            "SELECT MAX(COALESCE(mono_end_ms, mono_start_ms)) AS last_mono"
            " FROM segments WHERE session_uid=?;",
            (session.uid,),
        ).fetchone()

        last_mono = row["last_mono"] if row else None
        if last_mono is None:
            last_mono = session.started_mono_ms
        return last_mono + session.anchor_ms

    def _persist_anchors(self, conn: sqlite3.Connection, sessions: Iterable[FSession]) -> None:
        """Кладём посчитанное рядом — чтобы поправки были видны снаружи."""
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        conn.executemany(
            "INSERT INTO session_time(session_uid,anchor_ms,trusted,computed_at)"
            " VALUES(?,?,?,?)"
            " ON CONFLICT(session_uid) DO UPDATE SET"
            " anchor_ms=excluded.anchor_ms,"
            " trusted=excluded.trusted,"
            " computed_at=excluded.computed_at;",
            [(s.uid, s.anchor_ms, 1 if s.trusted else 0, now_ms) for s in sessions],
        )
        conn.commit()

    # ── выборка дня ──

    def day(self, date_key: str) -> dict:
        """Дорожки за сутки: непрерывные куски, пропуски и сами сегменты."""
        conn = self._connect()
        if conn is None:
            return {"date": date_key, "tracks": [], "available": False}

        try:
            self._ensure_own_schema(conn)
            if not self._has_table(conn, "segments"):
                return {"date": date_key, "tracks": [], "available": False}

            day_start = _day_start_ms(date_key)
            day_end = day_start + DAY_MS

            sessions = self._load_sessions(conn)
            self._persist_anchors(conn, sessions)

            rows = self._rows_in_window(conn, sessions, day_start, day_end)
            tracks = self._build_tracks(rows, day_start, day_end)

            return {
                "date": date_key,
                "day_start_ms": day_start,
                "day_end_ms": day_end,
                "available": True,
                "tracks": tracks,
            }
        finally:
            conn.close()

    def _rows_in_window(
        self,
        conn: sqlite3.Connection,
        sessions: list[FSession],
        window_start: int,
        window_end: int,
    ) -> list[dict]:
        """
        Сегменты, попадающие в окно. Идём по сессиям: окно переводится в
        монотонную шкалу сессии её же якорем.
        """
        found: list[dict] = []

        for session in sessions:
            mono_lo = window_start - session.anchor_ms
            mono_hi = window_end - session.anchor_ms

            cursor = conn.execute(
                "SELECT * FROM segments"
                " WHERE session_uid=? AND mono_start_ms < ?"
                " AND COALESCE(mono_end_ms, mono_start_ms + ?) > ?"
                " ORDER BY mono_start_ms;",
                (session.uid, mono_hi, FALLBACK_DURATION_MS, mono_lo),
            )
            for row in cursor:
                found.append(self._normalize(row, session))

        # Строки, найденные сверкой: сессии у них нет, время только настенное
        cursor = conn.execute(
            "SELECT * FROM segments"
            " WHERE (session_uid IS NULL OR session_uid='')"
            " AND wall_start_ms < ?"
            " AND COALESCE(wall_end_ms, wall_start_ms + ?) > ?"
            " ORDER BY wall_start_ms;",
            (window_end, FALLBACK_DURATION_MS, window_start),
        )
        for row in cursor:
            found.append(self._normalize(row, None))

        return found

    @staticmethod
    def _normalize(row: sqlite3.Row, session: Optional[FSession]) -> dict:
        """Строка базы → сегмент в настенном времени изделия."""
        if session is not None:
            start = row["mono_start_ms"] + session.anchor_ms
            end = None if row["mono_end_ms"] is None else row["mono_end_ms"] + session.anchor_ms
            trusted = session.trusted
        else:
            start = row["wall_start_ms"]
            end = row["wall_end_ms"]
            trusted = False

        return {
            "id": row["id"],
            "camera_id": row["camera_id"],
            "stream_key": row["stream_key"],
            "path": row["path"],
            "file": os.path.basename(row["path"]),
            "start_ms": start,
            "end_ms": end,
            "size_bytes": row["size_bytes"] or 0,
            "closed": bool(row["closed"]),
            "origin": row["origin"],
            "trusted": trusted,
            "session_uid": row["session_uid"] or "",
        }

    def _build_tracks(self, rows: list[dict], day_start: int, day_end: int) -> list[dict]:
        """Группирует сегменты по дорожкам и считает куски и пропуски."""
        by_track: dict[tuple[str, str], list[dict]] = {}
        for row in rows:
            by_track.setdefault((row["camera_id"], row["stream_key"]), []).append(row)

        tracks = []
        for (camera_id, stream_key), items in sorted(by_track.items()):
            items.sort(key=lambda x: x["start_ms"])
            _fill_missing_ends(items)

            runs = _merge_runs(items, day_start, day_end)
            gaps = _find_gaps(items, runs)

            recorded_ms = sum(end - start for start, end in runs)
            tracks.append({
                "camera_id": camera_id,
                "stream_key": stream_key,
                "trusted": all(item["trusted"] for item in items) if items else True,
                "recorded_ms": recorded_ms,
                "bytes": sum(item["size_bytes"] for item in items),
                "segment_count": len(items),
                "runs": [{"start_ms": s, "end_ms": e} for s, e in runs],
                "gaps": gaps,
                "segments": items,
            })

        return tracks

    def range_segments(
        self, camera_id: str, stream_key: str, from_ms: int, to_ms: int
    ) -> list[dict]:
        """Сегменты одной дорожки, задевающие диапазон, — по ним идёт склейка."""
        conn = self._connect()
        if conn is None:
            return []

        try:
            self._ensure_own_schema(conn)
            if not self._has_table(conn, "segments"):
                return []

            sessions = self._load_sessions(conn)
            rows = [
                row for row in self._rows_in_window(conn, sessions, from_ms, to_ms)
                if row["camera_id"] == camera_id and row["stream_key"] == stream_key
            ]
            rows.sort(key=lambda item: item["start_ms"])
            _fill_missing_ends(rows)
            return rows
        finally:
            conn.close()

    # ── календарь и сводка ──

    def days(self, date_from: str, date_to: str) -> list[dict]:
        """Сутки, за которые есть хоть что-то, — для подсветки в календаре."""
        conn = self._connect()
        if conn is None:
            return []

        try:
            self._ensure_own_schema(conn)
            if not self._has_table(conn, "segments"):
                return []

            window_start = _day_start_ms(date_from)
            window_end = _day_start_ms(date_to) + DAY_MS

            sessions = self._load_sessions(conn)
            self._persist_anchors(conn, sessions)

            rows = self._rows_in_window(conn, sessions, window_start, window_end)

            # Концы достраиваем так же, как в выборке дня, иначе календарь и
            # экран дня показывают разное число записанных часов
            by_track: dict[tuple[str, str], list[dict]] = {}
            for row in rows:
                by_track.setdefault((row["camera_id"], row["stream_key"]), []).append(row)

            by_day: dict[str, dict] = {}
            for track_key, items in by_track.items():
                items.sort(key=lambda x: x["start_ms"])
                _fill_missing_ends(items)

                for item in items:
                    # Сегмент может пересекать полночь — раскладываем по суткам
                    for key, covered in _split_by_day(item["start_ms"], item["end_ms"]):
                        day = by_day.setdefault(key, {
                            "date": key,
                            "recorded_ms": 0,
                            "bytes": 0,
                            "segment_count": 0,
                            "tracks": set(),
                            "trusted": True,
                        })
                        day["recorded_ms"] += covered
                        day["tracks"].add(track_key)
                        if not item["trusted"]:
                            day["trusted"] = False

                    key = _date_key(item["start_ms"])
                    by_day[key]["bytes"] += item["size_bytes"]
                    by_day[key]["segment_count"] += 1

            result = []
            for key in sorted(by_day):
                day = by_day[key]
                day["track_count"] = len(day.pop("tracks"))
                result.append(day)
            return result
        finally:
            conn.close()

    def state(self) -> dict:
        """Глубина архива и объём — для правой панели."""
        conn = self._connect()
        if conn is None:
            return {"available": False}

        try:
            self._ensure_own_schema(conn)
            if not self._has_table(conn, "segments"):
                return {"available": False}

            sessions = self._load_sessions(conn)
            self._persist_anchors(conn, sessions)

            total = conn.execute(
                "SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes FROM segments;"
            ).fetchone()

            bounds = self._bounds(conn, sessions)

            return {
                "available": True,
                "segment_count": total["count"],
                "bytes": total["bytes"],
                "first_ms": bounds[0],
                "last_ms": bounds[1],
                "first_date": _date_key(bounds[0]) if bounds[0] is not None else None,
                "last_date": _date_key(bounds[1]) if bounds[1] is not None else None,
                "session_count": len(sessions),
                "untrusted_sessions": sum(1 for s in sessions if not s.trusted),
            }
        finally:
            conn.close()

    def _bounds(
        self, conn: sqlite3.Connection, sessions: list[FSession]
    ) -> tuple[Optional[int], Optional[int]]:
        first: Optional[int] = None
        last: Optional[int] = None

        for session in sessions:
            row = conn.execute(
                "SELECT MIN(mono_start_ms) AS lo,"
                " MAX(COALESCE(mono_end_ms, mono_start_ms)) AS hi"
                " FROM segments WHERE session_uid=?;",
                (session.uid,),
            ).fetchone()
            if row is None or row["lo"] is None:
                continue
            lo = row["lo"] + session.anchor_ms
            hi = row["hi"] + session.anchor_ms
            first = lo if first is None else min(first, lo)
            last = hi if last is None else max(last, hi)

        row = conn.execute(
            "SELECT MIN(wall_start_ms) AS lo,"
            " MAX(COALESCE(wall_end_ms, wall_start_ms)) AS hi"
            " FROM segments WHERE session_uid IS NULL OR session_uid='';"
        ).fetchone()
        if row is not None and row["lo"] is not None:
            first = row["lo"] if first is None else min(first, row["lo"])
            last = row["hi"] if last is None else max(last, row["hi"])

        return first, last

    # ── сверка с диском ──

    def reconcile(self) -> dict:
        """
        Приводит базу и диск в согласие: строки без файлов удаляются, файлы без
        строк заносятся как найденные, брошенные открытые строки закрываются.
        """
        conn = self._connect()
        if conn is None:
            # Базы ещё нет — её создаст media-center при первой записи
            return {"skipped": True}

        try:
            self._ensure_own_schema(conn)
            if not self._has_table(conn, "segments"):
                return {"skipped": True}

            known = {row["path"]: row for row in conn.execute(
                "SELECT id, path, closed, mono_start_ms, wall_start_ms FROM segments;"
            )}

            removed = self._drop_missing(conn, known)
            closed = self._close_abandoned(conn, known)
            added = self._add_found(conn, known)

            conn.commit()
            if removed or closed or added:
                logger.info(
                    "Segment index reconciled: %d rows dropped, %d closed, %d found on disk",
                    removed, closed, added,
                )
            return {"dropped": removed, "closed": closed, "found": added}
        finally:
            conn.close()

    @staticmethod
    def _drop_missing(conn: sqlite3.Connection, known: dict) -> int:
        gone = [path for path in known if not os.path.exists(path)]
        if not gone:
            return 0
        conn.executemany("DELETE FROM segments WHERE path=?;", [(p,) for p in gone])
        for path in gone:
            known.pop(path, None)
        return len(gone)

    @staticmethod
    def _close_abandoned(conn: sqlite3.Connection, known: dict) -> int:
        """
        Открытая строка, файл которой давно не менялся, — след обрыва питания:
        media-center закрыть её уже не сможет, меряем файл и закрываем сами.
        """
        now = datetime.now().timestamp()
        closed = 0

        for path, row in known.items():
            if row["closed"]:
                continue
            try:
                stat = os.stat(path)
            except OSError:
                continue
            if now - stat.st_mtime < OPEN_STALE_SEC:
                continue

            duration_ms = _probe_duration_ms(path)
            if duration_ms is None:
                continue

            conn.execute(
                "UPDATE segments SET mono_end_ms=mono_start_ms+?,"
                " wall_end_ms=wall_start_ms+?, size_bytes=?, closed=1 WHERE id=?;",
                (duration_ms, duration_ms, stat.st_size, row["id"]),
            )
            closed += 1

        return closed

    def _add_found(self, conn: sqlite3.Connection, known: dict) -> int:
        """
        Файлы, которых нет в базе: записи, принесённые руками, и всё, что
        накопилось до появления индекса. Время берётся из имени и достоверным
        не считается.
        """
        added = 0

        for path, camera_id, stream_key in self._walk_records():
            if path in known:
                continue

            wall_ms = _wall_from_filename(path)
            if wall_ms is None:
                continue

            try:
                size = os.path.getsize(path)
            except OSError:
                continue

            conn.execute(
                "INSERT OR IGNORE INTO segments("
                "session_uid,camera_id,stream_key,path,"
                "mono_start_ms,wall_start_ms,time_source,size_bytes,closed,origin)"
                " VALUES('',?,?,?,0,?, 'none',?,1,'scan');",
                (camera_id, stream_key, path, wall_ms, size),
            )
            added += 1

        return added

    def _walk_records(self):
        """Видеофайлы под корнем записей: <камера>/<поток>/файл и старая плоская раскладка."""
        root = self.records_root
        if not root.exists():
            return

        for camera_dir in sorted(root.iterdir()):
            if not camera_dir.is_dir():
                continue
            for entry in sorted(camera_dir.iterdir()):
                if entry.is_dir():
                    for file in sorted(entry.iterdir()):
                        if file.is_file() and file.suffix.lower() in VIDEO_EXTENSIONS:
                            yield str(file), camera_dir.name, entry.name
                elif entry.is_file() and entry.suffix.lower() in VIDEO_EXTENSIONS:
                    yield str(entry), camera_dir.name, LEGACY_STREAM

    def forget_file(self, path: str) -> None:
        """Файл удалён чисткой — строка уходит вместе с ним."""
        conn = self._connect()
        if conn is None:
            return
        try:
            if not self._has_table(conn, "segments"):
                return
            conn.execute("DELETE FROM segments WHERE path=?;", (path,))
            conn.commit()
        finally:
            conn.close()

    def files_oldest_first(self) -> list[str]:
        """
        Порядок удаления при нехватке места — по нормализованному времени, а не
        по mtime: когда часы врали, mtime не совпадает с порядком записи.
        """
        conn = self._connect()
        if conn is None:
            return []

        try:
            self._ensure_own_schema(conn)
            if not self._has_table(conn, "segments"):
                return []

            sessions = {s.uid: s for s in self._load_sessions(conn)}
            rows = conn.execute(
                "SELECT path, session_uid, mono_start_ms, wall_start_ms FROM segments;"
            ).fetchall()

            ordered = []
            for row in rows:
                session = sessions.get(row["session_uid"])
                start = (row["mono_start_ms"] + session.anchor_ms) if session else row["wall_start_ms"]
                ordered.append((start, row["path"]))

            ordered.sort(key=lambda item: item[0])
            return [path for _, path in ordered]
        finally:
            conn.close()


# ── свободные функции ──

def _day_start_ms(date_key: str) -> int:
    """
    Полночь суток в миллисекундах. Время изделия уже сдвинуто на его пояс, так
    что считаем в UTC — иначе пояс сервера наложится вторым слоем.
    """
    day = datetime.strptime(date_key, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(day.timestamp() * 1000)


def _date_key(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def _wall_from_filename(path: str) -> Optional[int]:
    match = FILENAME_TS.search(os.path.basename(path))
    if not match:
        return None
    year, month, day, hour, minute, second = (int(part) for part in match.groups())
    try:
        stamp = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
    except ValueError:
        return None
    return int(stamp.timestamp() * 1000)


def _probe_duration_ms(path: str) -> Optional[int]:
    """Длительность файла через ffprobe. Зовётся редко — только для брошенных строк."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=20,
        )
        if result.returncode != 0:
            return None
        return int(float(result.stdout.strip()) * 1000)
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        logger.warning("ffprobe failed for %s: %s", path, e)
        return None


def _split_by_day(start_ms: int, end_ms: int) -> list[tuple[str, int]]:
    """Отрезок → сколько его пришлось на каждые сутки, которые он задел."""
    parts = []
    cursor = start_ms

    while cursor < end_ms:
        day_start = (cursor // DAY_MS) * DAY_MS
        day_end = day_start + DAY_MS
        edge = min(end_ms, day_end)
        parts.append((_date_key(cursor), edge - cursor))
        cursor = edge

    return parts


def _fill_missing_ends(items: list[dict]) -> None:
    """
    Конец есть не у всех: фрагмент может писаться прямо сейчас, а у найденных
    сверкой строк его нет вовсе. Достраиваем по началу следующего сегмента, а
    последнему даём типичную для дорожки длительность.
    """
    known = [item["end_ms"] - item["start_ms"] for item in items if item["end_ms"]]
    typical = sorted(known)[len(known) // 2] if known else FALLBACK_DURATION_MS

    for index, item in enumerate(items):
        if item["end_ms"]:
            continue
        if index + 1 < len(items):
            span = items[index + 1]["start_ms"] - item["start_ms"]
            item["end_ms"] = item["start_ms"] + min(span, typical * 2)
        else:
            item["end_ms"] = item["start_ms"] + typical
        item["estimated_end"] = True


def _merge_runs(items: list[dict], day_start: int, day_end: int) -> list[tuple[int, int]]:
    """Соседние сегменты сливаются в непрерывный кусок, пока зазор мал."""
    runs: list[tuple[int, int]] = []

    for item in items:
        start = max(item["start_ms"], day_start)
        end = min(item["end_ms"], day_end)
        if end <= start:
            continue

        if runs and start - runs[-1][1] <= GAP_THRESHOLD_MS:
            runs[-1] = (runs[-1][0], max(runs[-1][1], end))
        else:
            runs.append((start, end))

    return runs


def _find_gaps(items: list[dict], runs: list[tuple[int, int]]) -> list[dict]:
    """
    Пропуски между кусками. Разрыв на границе сессий значит, что изделие было
    обесточено, — это не поломка записи, и красным его помечать нельзя.
    """
    sessions_at = [(item["start_ms"], item["session_uid"]) for item in items]

    gaps = []
    for left, right in zip(runs, runs[1:]):
        before = _session_at(sessions_at, left[1])
        after = _session_at(sessions_at, right[0])
        gaps.append({
            "start_ms": left[1],
            "end_ms": right[0],
            "kind": "power" if before != after else "record",
        })
    return gaps


def _session_at(sessions_at: list[tuple[int, str]], ms: int) -> str:
    found = ""
    for start, uid in sessions_at:
        if start <= ms:
            found = uid
        else:
            break
    return found


index = SegmentIndex(Path(settings.ARCHIVE_DB_PATH))
