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
import time
from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable, Optional

from app.config import settings
from app.services import mp4_header

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

# Открытый фрагмент, содержимое которого не растёт столько секунд, брошен
STALL_SEC = 30

# Работа одного прохода проверки закрытых строк по содержимому, с
VERIFY_BUDGET_SEC = 2

# Расхождение заявленной и настоящей длительности, которое правится по файлу: меньшее таймлайн не покажет разрывом
VERIFY_SLACK_MS = GAP_THRESHOLD_MS

EMPTY_ERROR = "empty: no frames in file"

# Потолок длительности сегмента, когда её нечем измерить
FALLBACK_DURATION_MS = 600_000

# Сколько времени один проход сверки тратит на промер длительностей
MEASURE_BUDGET_SEC = 60

# Одиночный ffprobe на плате стоит ~125 мс, поэтому меряем пачками
MEASURE_WORKERS = 4
MEASURE_CHUNK = 32

# Зазор, через который куски календаря сшиваются: на циферблате суток он всё равно не виден
CALENDAR_MERGE_MS = 120_000

# Строк за одну транзакцию удаления диапазона
DELETE_BATCH = 500

# Источники, которым можно верить. sadko — нынешнее имя, can — прежнее
TRUSTED_SOURCES = ("sadko", "can")

# Окно правдоподобного настенного времени, как в разборе времени шлюза: 2025–2050
WALL_MIN_MS = int(datetime(2025, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
WALL_MAX_MS = int(datetime(2051, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)


@dataclass
class FSession:
    uid: str
    started_mono_ms: int
    started_wall_ms: int
    time_source: str
    anchor_ms: int = 0
    trusted: bool = False


@dataclass(frozen=True)
class FVolumeView:
    # Внутренний том; строки без volume_id принадлежат ему
    internal_id: Optional[str] = None
    # Подключённые тома: id → каталог записей устройства на томе (None — каталог неизвестен)
    present: dict = field(default_factory=dict)
    # Извлечённые тома: id → имя для подписи
    offline: dict = field(default_factory=dict)
    # Проверка тома прямо сейчас: метка на месте и каталог записей существует
    alive: Callable[[str], bool] = lambda _volume_id: False


class SegmentIndex:
    """Чтение индекса сегментов и нормализация времени."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        # Файлы, которые ffprobe не смог измерить, — второй раз не пробуем
        self._unmeasurable: set[int] = set()
        # Открытые строки: id -> (содержимое мс, когда последний раз росло по monotonic)
        self._growth: dict[int, tuple[int, float]] = {}
        self._schema_ready = False
        # Состояние пула, публикуется пулом при каждом опросе дисков
        self.view = FVolumeView()

    def _volume_of(self, row) -> Optional[str]:
        return row["volume_id"] or self.view.internal_id

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
        # Файлы, строки которых удалены из архива вручную; стираются, когда их том подключён
        conn.execute(
            "CREATE TABLE IF NOT EXISTS pending_delete("
            "  path TEXT PRIMARY KEY,"
            "  volume_id TEXT,"
            "  queued_at INTEGER NOT NULL"
            ");"
        )
        if self._has_table(conn, "segments"):
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(segments);")}
            for name, decl in (("volume_id", "TEXT"), ("error", "TEXT"), ("verified", "INTEGER NOT NULL DEFAULT 0")):
                if name in columns:
                    continue
                try:
                    conn.execute(f"ALTER TABLE segments ADD COLUMN {name} {decl};")
                except sqlite3.OperationalError as e:
                    # Колонку уже добавил media-center
                    if "duplicate column" not in str(e):
                        raise
            conn.execute("CREATE INDEX IF NOT EXISTS idx_seg_volume ON segments(volume_id);")
            self._schema_ready = True
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

            anchor, trusted = self._anchor_of(conn, session)
            if not trusted and wall_floor is not None and anchor < wall_floor:
                # Часы могли уехать назад: без Садко их никто не синхронизирует,
                # и новая сессия не должна лечь поверх уже уложенных
                anchor = wall_floor

            session.anchor_ms = anchor
            session.trusted = trusted

            end = self._session_end_ms(conn, session)
            if end is not None:
                wall_floor = end + SESSION_SPACING_MS

            sessions.append(session)

        return sessions

    def _anchor_of(self, conn: sqlite3.Connection, session: FSession) -> tuple[int, bool]:
        """
        Сдвиг монотонной шкалы к настенной и то, чего он стоит.

        Источники перебираются от лучшего к худшему, внутри источника берётся
        самая ранняя по mono запись — тогда скачок часов посреди сессии не
        двигает её целиком. Строка sessions идёт последней: её настенное время
        снято при старте процесса, когда шлюз ещё молчал, и с временем самих
        сегментов может расходиться на пояс.

        can — прежнее имя источника Садко, старые базы читаются наравне.
        """
        has_marks = self._has_table(conn, "time_marks")

        for sources in (TRUSTED_SOURCES, ("system",), ("none",)):
            trusted = sources is TRUSTED_SOURCES

            if (trusted and session.time_source in TRUSTED_SOURCES
                    and WALL_MIN_MS <= session.started_wall_ms < WALL_MAX_MS):
                return session.started_wall_ms - session.started_mono_ms, True

            if has_marks:
                base = self._base_from(
                    conn,
                    "SELECT wall_ms - mono_ms AS base FROM time_marks"
                    f" WHERE session_uid=? AND time_source IN ({_places(sources)})"
                    " AND wall_ms >= ? AND wall_ms < ?"
                    " ORDER BY mono_ms LIMIT 1;",
                    (session.uid, *sources, WALL_MIN_MS, WALL_MAX_MS),
                )
                if base is not None:
                    return base, trusted

            base = self._base_from(
                conn,
                "SELECT wall_start_ms - mono_start_ms AS base FROM segments"
                f" WHERE session_uid=? AND time_source IN ({_places(sources)})"
                " AND wall_start_ms >= ? AND wall_start_ms < ?"
                " ORDER BY mono_start_ms LIMIT 1;",
                (session.uid, *sources, WALL_MIN_MS, WALL_MAX_MS),
            )
            if base is not None:
                return base, trusted

        return session.started_wall_ms - session.started_mono_ms, False

    @staticmethod
    def _base_from(conn: sqlite3.Connection, sql: str, params: tuple) -> Optional[int]:
        row = conn.execute(sql, params).fetchone()
        return None if row is None else row["base"]

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
        """
        Кладём посчитанное рядом — чтобы поправки были видны снаружи. Пишем
        только изменившееся: якоря считаются на каждый запрос архива, и
        безусловная запись делала писателем любое чтение.
        """
        stored = {
            row["session_uid"]: (row["anchor_ms"], row["trusted"])
            for row in conn.execute(
                "SELECT session_uid, anchor_ms, trusted FROM session_time;"
            )
        }

        changed = [
            (s.uid, s.anchor_ms, 1 if s.trusted else 0)
            for s in sessions
            if stored.get(s.uid) != (s.anchor_ms, 1 if s.trusted else 0)
        ]
        if not changed:
            return

        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        conn.executemany(
            "INSERT INTO session_time(session_uid,anchor_ms,trusted,computed_at)"
            " VALUES(?,?,?,?)"
            " ON CONFLICT(session_uid) DO UPDATE SET"
            " anchor_ms=excluded.anchor_ms,"
            " trusted=excluded.trusted,"
            " computed_at=excluded.computed_at;",
            [(uid, anchor, trusted, now_ms) for uid, anchor, trusted in changed],
        )
        conn.commit()

    # ── выборка дня ──

    def day(self, date_key: str) -> dict:
        """Сутки целиком — частный случай окна."""
        start = _day_start_ms(date_key)
        result = self.window(start, start + DAY_MS)
        result["date"] = date_key
        return result

    def window(self, from_ms: int, to_ms: int) -> dict:
        """
        Дорожки за произвольный отрезок времени: непрерывные куски, пропуски и
        сами сегменты. Таймлайн не привязан к суткам, поэтому границы задаёт он.
        """
        conn = self._connect()
        if conn is None:
            return {"from_ms": from_ms, "to_ms": to_ms, "tracks": [], "available": False}

        try:
            self._ensure_own_schema(conn)
            if not self._has_table(conn, "segments"):
                return {"from_ms": from_ms, "to_ms": to_ms, "tracks": [], "available": False}

            sessions = self._load_sessions(conn)
            self._persist_anchors(conn, sessions)

            rows = self._rows_in_window(conn, sessions, from_ms, to_ms, with_neighbours=True)
            tracks = self._build_tracks(rows, from_ms, to_ms, self._known_tracks(conn))

            return {
                "from_ms": from_ms,
                "to_ms": to_ms,
                "day_start_ms": from_ms,
                "day_end_ms": to_ms,
                "available": True,
                "tracks": tracks,
            }
        finally:
            conn.close()

    # Ближайшие соседи за краями окна: без них разрыв, накрывший окно целиком,
    # выглядел бы отсутствием записей и пропадал при приближении
    _NEIGHBOUR_SQL = (
        "SELECT *, MAX({column}) FROM segments"
        " WHERE {scope} AND {column} < ? GROUP BY camera_id, stream_key;",
        "SELECT *, MIN({column}) FROM segments"
        " WHERE {scope} AND {column} >= ? GROUP BY camera_id, stream_key;",
    )

    def shape(self) -> dict:
        """
        Куски и разрывы всех дорожек за всю глубину архива, без списков
        сегментов. Это всё, что нужно таймлайну: он берёт форму один раз и
        дальше только пересчитывает координаты, не ходя в сеть на каждый сдвиг.
        Сами сегменты запрашивает плеер, и только у выбранной дорожки.
        """
        conn = self._connect()
        if conn is None:
            return {"tracks": [], "available": False}

        try:
            self._ensure_own_schema(conn)
            if not self._has_table(conn, "segments"):
                return {"tracks": [], "available": False}

            sessions = self._load_sessions(conn)
            self._persist_anchors(conn, sessions)

            first, last = self._bounds(conn, sessions)
            if first is None:
                return {"tracks": [], "available": True, "first_ms": None, "last_ms": None}

            rows = self._rows_in_window(conn, sessions, first, last + 1)
            tracks = self._build_tracks(rows, first, last + 1, self._known_tracks(conn))
            for track in tracks:
                track.pop("segments", None)

            return {
                "available": True,
                "first_ms": first,
                "last_ms": last,
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
        with_neighbours: bool = False,
    ) -> list[dict]:
        """
        Сегменты, попадающие в окно. Идём по сессиям: окно переводится в
        монотонную шкалу сессии её же якорем. С `with_neighbours` добавляются
        ближайшие сегменты за обоими краями — они нужны, чтобы знать границы
        разрыва, накрывшего окно целиком.
        """
        found: list[dict] = []

        def collect(sql: str, params: tuple, session: Optional[FSession]) -> None:
            for row in conn.execute(sql, params):
                found.append(self._normalize(row, session))

        for session in sessions:
            mono_lo = window_start - session.anchor_ms
            mono_hi = window_end - session.anchor_ms
            scope = "session_uid=?"

            collect(
                "SELECT * FROM segments"
                " WHERE session_uid=? AND mono_start_ms < ?"
                " AND COALESCE(mono_end_ms, mono_start_ms + ?) > ?"
                " ORDER BY mono_start_ms;",
                (session.uid, mono_hi, FALLBACK_DURATION_MS, mono_lo),
                session,
            )

            if with_neighbours:
                for template, bound in zip(self._NEIGHBOUR_SQL, (mono_lo, mono_hi)):
                    collect(
                        template.format(column="mono_start_ms", scope=scope),
                        (session.uid, bound),
                        session,
                    )

        # Строки, найденные сверкой: сессии у них нет, время только настенное
        scope = "(session_uid IS NULL OR session_uid='')"
        collect(
            "SELECT * FROM segments"
            f" WHERE {scope}"
            " AND wall_start_ms < ?"
            " AND COALESCE(wall_end_ms, wall_start_ms + ?) > ?"
            " ORDER BY wall_start_ms;",
            (window_end, FALLBACK_DURATION_MS, window_start),
            None,
        )

        if with_neighbours:
            for template, bound in zip(self._NEIGHBOUR_SQL, (window_start, window_end)):
                collect(
                    template.format(column="wall_start_ms", scope=scope),
                    (bound,),
                    None,
                )

        # Соседи пересекаются с основной выборкой — оставляем по одной строке
        unique = {row["id"]: row for row in found}
        return list(unique.values())

    def _normalize(self, row: sqlite3.Row, session: Optional[FSession]) -> dict:
        """Строка базы → сегмент в настенном времени изделия."""
        if session is not None:
            start = row["mono_start_ms"] + session.anchor_ms
            end = None if row["mono_end_ms"] is None else row["mono_end_ms"] + session.anchor_ms
            trusted = session.trusted
        else:
            start = row["wall_start_ms"]
            end = row["wall_end_ms"]
            trusted = False

        volume_id = self._volume_of(row)
        disk = self.view.offline.get(volume_id)

        return {
            "id": row["id"],
            "volume_id": volume_id,
            "available": disk is None,
            "disk": disk,
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

    @staticmethod
    def _known_tracks(conn: sqlite3.Connection) -> list[tuple[str, str]]:
        """Все пары «камера + поток», когда-либо писавшие, — по индексу idx_seg_track."""
        cursor = conn.execute(
            "SELECT DISTINCT camera_id, stream_key FROM segments"
            " WHERE camera_id IS NOT NULL AND stream_key IS NOT NULL;"
        )
        return [(row["camera_id"], row["stream_key"]) for row in cursor]

    def _build_tracks(
        self,
        rows: list[dict],
        window_start: int,
        window_end: int,
        known: Iterable[tuple[str, str]] = (),
    ) -> list[dict]:
        """
        Группирует сегменты по дорожкам и считает куски и пропуски. Куски и
        разрывы считаются по всему, что пришло, включая соседей за краями окна,
        и лишь потом подрезаются: разрыв — свойство архива, а не окна. Границы
        разрыва отдаются настоящими, чтобы подпись не врала о его длине.
        """
        by_track: dict[tuple[str, str], list[dict]] = {}
        for row in rows:
            by_track.setdefault((row["camera_id"], row["stream_key"]), []).append(row)

        # Дорожка живёт, пока у камеры есть хоть один сегмент в архиве
        for key in known:
            by_track.setdefault(key, [])

        tracks = []
        for (camera_id, stream_key), items in sorted(by_track.items()):
            items.sort(key=lambda x: x["start_ms"])
            _fill_missing_ends(items)

            runs = _merge_runs(items)
            gaps = _find_gaps(items, runs)

            inside = [
                item for item in items
                if item["end_ms"] > window_start and item["start_ms"] < window_end
            ]
            visible = [
                (max(start, window_start), min(end, window_end), disk)
                for start, end, disk in runs
                if end > window_start and start < window_end
            ]

            tracks.append({
                "camera_id": camera_id,
                "stream_key": stream_key,
                "trusted": all(item["trusted"] for item in inside) if inside else True,
                "recorded_ms": sum(end - start for start, end, _disk in visible),
                "bytes": sum(item["size_bytes"] for item in inside),
                "segment_count": len(inside),
                "runs": [
                    {"start_ms": s, "end_ms": e, "available": d is None, "disk": d}
                    for s, e, d in visible
                ],
                "gaps": [
                    gap for gap in gaps
                    if gap["end_ms"] > window_start and gap["start_ms"] < window_end
                ],
                "segments": inside,
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

    # Закрытые сегменты дорожек, задетые диапазоном, уходят из индекса, их файлы — в очередь на стирание
    def delete_range(self, tracks: Iterable[tuple[str, str]], from_ms: int, to_ms: int) -> dict:
        wanted = set(tracks)
        result = {"removed": 0, "bytes": 0, "deferred": 0, "kept_open": 0}
        conn = self._connect()
        if conn is None:
            return result

        try:
            self._ensure_own_schema(conn)
            if not self._has_table(conn, "segments"):
                return result

            sessions = self._load_sessions(conn)
            by_track: dict[tuple[str, str], list[dict]] = {}
            for row in self._rows_in_window(conn, sessions, from_ms, to_ms):
                key = (row["camera_id"], row["stream_key"])
                if key in wanted:
                    by_track.setdefault(key, []).append(row)

            doomed = []
            for items in by_track.values():
                items.sort(key=lambda item: item["start_ms"])
                _fill_missing_ends(items)
                for item in items:
                    if item["end_ms"] <= from_ms or item["start_ms"] >= to_ms:
                        continue
                    if item["closed"]:
                        doomed.append(item)
                    else:
                        result["kept_open"] += 1

            now = int(time.time() * 1000)
            for start in range(0, len(doomed), DELETE_BATCH):
                batch = doomed[start:start + DELETE_BATCH]
                conn.executemany(
                    "INSERT OR IGNORE INTO pending_delete(path, volume_id, queued_at) VALUES(?,?,?);",
                    [(item["path"], item["volume_id"], now) for item in batch],
                )
                conn.execute(
                    f"DELETE FROM segments WHERE id IN ({_places(batch)});",
                    [item["id"] for item in batch],
                )
                conn.commit()

            result["removed"] = len(doomed)
            result["bytes"] = sum(item["size_bytes"] for item in doomed)
            result["deferred"] = sum(1 for item in doomed if not item["available"])
            logger.warning(
                "Archive range %d..%d deleted for %s: %d rows, %d bytes, %d files wait for their disk, %d open kept",
                from_ms, to_ms, sorted(wanted), result["removed"], result["bytes"], result["deferred"], result["kept_open"],
            )
            return result
        finally:
            conn.close()

    # Стирает файлы удалённых диапазонов на подключённых томах; файлы извлечённых ждут возвращения тома
    def sweep_pending(self) -> int:
        conn = self._connect()
        if conn is None:
            return 0
        try:
            self._ensure_own_schema(conn)
            return self._sweep_pending(conn)
        finally:
            conn.close()

    def _sweep_pending(self, conn: sqlite3.Connection) -> int:
        alive: dict[str, bool] = {}
        done = []
        for row in conn.execute("SELECT path, volume_id FROM pending_delete;").fetchall():
            volume_id = row["volume_id"] or self.view.internal_id
            if volume_id not in alive:
                alive[volume_id] = volume_id in self.view.present and self.view.alive(volume_id)
            if not alive[volume_id]:
                continue
            try:
                os.remove(row["path"])
            except FileNotFoundError:
                pass
            except OSError as e:
                logger.warning("Cannot remove file of deleted range %s: %s", row["path"], e)
                continue
            done.append((row["path"],))

        if done:
            conn.executemany("DELETE FROM pending_delete WHERE path=?;", done)
            conn.commit()
            logger.info("Removed %d files of deleted archive ranges", len(done))
        return len(done)

    # Строки окна одним запросом: время нормализует SQLite по якорям сессий из временной таблицы
    def _light_rows(
        self, conn: sqlite3.Connection, sessions: list[FSession], window_start: int, window_end: int
    ) -> list[dict]:
        conn.execute(
            "CREATE TEMP TABLE IF NOT EXISTS anchors(uid TEXT PRIMARY KEY, anchor_ms INTEGER, trusted INTEGER);"
        )
        conn.execute("DELETE FROM temp.anchors;")
        conn.executemany(
            "INSERT INTO temp.anchors VALUES(?,?,?);",
            [(s.uid, s.anchor_ms, int(s.trusted)) for s in sessions],
        )
        conn.commit()

        cursor = conn.execute(
            "SELECT camera_id, stream_key, volume_id, size_bytes, st, en, tr FROM ("
            " SELECT s.camera_id, s.stream_key, s.volume_id, s.size_bytes,"
            "  CASE WHEN a.uid IS NULL THEN s.wall_start_ms ELSE s.mono_start_ms + a.anchor_ms END AS st,"
            "  CASE WHEN a.uid IS NULL THEN s.wall_end_ms ELSE s.mono_end_ms + a.anchor_ms END AS en,"
            "  COALESCE(a.trusted, 0) AS tr"
            " FROM segments s LEFT JOIN temp.anchors a ON a.uid = s.session_uid"
            " WHERE a.uid IS NOT NULL OR s.session_uid IS NULL OR s.session_uid = ''"
            ") WHERE st < ? AND COALESCE(en, st + ?) > ?;",
            (window_end, FALLBACK_DURATION_MS, window_start),
        )
        offline = self.view.offline
        return [
            {
                "camera_id": row["camera_id"],
                "stream_key": row["stream_key"],
                "start_ms": row["st"],
                "end_ms": row["en"],
                "size_bytes": row["size_bytes"] or 0,
                "trusted": bool(row["tr"]),
                "available": (row["volume_id"] or self.view.internal_id) not in offline,
            }
            for row in cursor
        ]

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

            by_track: dict[tuple[str, str], list[dict]] = {}
            for row in self._light_rows(conn, sessions, window_start, window_end):
                by_track.setdefault((row["camera_id"], row["stream_key"]), []).append(row)

            by_day: dict[str, dict] = {}

            def day_of(key: str) -> dict:
                return by_day.setdefault(key, {
                    "date": key, "recorded_ms": 0, "bytes": 0, "segment_count": 0,
                    "trusted": True, "tracks": {},
                })

            def track_of(day: dict, camera_id: str, stream_key: str) -> dict:
                return day["tracks"].setdefault((camera_id, stream_key), {
                    "camera_id": camera_id, "stream_key": stream_key, "recorded_ms": 0, "runs": [],
                })

            for (camera_id, stream_key), items in sorted(by_track.items()):
                items.sort(key=lambda x: x["start_ms"])
                # Концы достраиваются так же, как в выборке окна таймлайна
                _fill_missing_ends(items)

                for item in items:
                    for key, start, end in _day_pieces(item["start_ms"], item["end_ms"]):
                        day = day_of(key)
                        track_of(day, camera_id, stream_key)["recorded_ms"] += end - start
                        if not item["trusted"]:
                            day["trusted"] = False
                    day = day_of(_date_key(item["start_ms"]))
                    day["bytes"] += item["size_bytes"]
                    day["segment_count"] += 1

                for start, end, available in _calendar_runs(items):
                    for key, piece_start, piece_end in _day_pieces(start, end):
                        track_of(day_of(key), camera_id, stream_key)["runs"].append(
                            {"start_ms": piece_start, "end_ms": piece_end, "available": available}
                        )

            result = []
            for key in sorted(by_day):
                day = by_day[key]
                tracks = list(day.pop("tracks").values())
                spans = sorted((run["start_ms"], run["end_ms"]) for track in tracks for run in track["runs"])
                day["recorded_ms"] = sum(end - start for start, end in _union(spans))
                day["track_count"] = len(tracks)
                day["tracks"] = tracks
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

            self._stamp_internal(conn)
            conn.commit()

            swept = self._sweep_pending(conn)

            # Строки извлечённых томов сверке не подлежат
            known = {
                row["path"]: row for row in conn.execute(
                    "SELECT id, path, closed, mono_start_ms, wall_start_ms, volume_id, error FROM segments;"
                )
                if self._volume_of(row) in self.view.present
            }

            removed = self._drop_missing(conn, known)
            conn.commit()
            empty = self._drop_empty(conn, known)
            closed = self._close_abandoned(conn, known)
            added = self._add_found(conn, known)
            conn.commit()

            measured = self._measure_missing_ends(conn)
            conn.commit()

            if removed or empty or closed or added or measured:
                logger.info(
                    "Segment index reconciled: %d rows dropped, %d empty files removed, %d closed,"
                    " %d found on disk, %d durations measured",
                    removed, empty, closed, added, measured,
                )
            return {
                "dropped": removed, "empty": empty, "closed": closed, "found": added,
                "measured": measured, "swept": swept,
            }

        finally:
            conn.close()

    # Быстрый проход: открытые строки по росту содержимого, закрытые — сверка с файлом
    def check_live(self) -> dict:
        conn = self._connect()
        if conn is None:
            return {"skipped": True}

        try:
            if not self._schema_ready:
                self._ensure_own_schema(conn)
            if not self._has_table(conn, "segments"):
                return {"skipped": True}

            growing, stalled = self._check_open(conn)
            verified = self._verify_closed(conn)
            return {"growing": growing, "stalled": stalled, "verified": verified}

        finally:
            conn.close()

    def _check_open(self, conn: sqlite3.Connection) -> tuple[int, int]:
        rows = [
            row for row in conn.execute(
                "SELECT id, path, camera_id, stream_key, mono_start_ms, mono_end_ms, volume_id"
                " FROM segments WHERE closed=0;"
            )
            if self._volume_of(row) in self.view.present
        ]
        now = time.monotonic()
        growing = stalled = 0

        for row in rows:
            path = row["path"]
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            measured = mp4_header.measure_content(Path(path))
            if measured is None:
                continue
            content, has_data = measured

            last = self._growth.get(row["id"])
            if last is None or content > last[0]:
                self._growth[row["id"]] = (content, now)
                growing += 1
                # Живой край строки — конец того, что уже лежит в файле
                if content and row["mono_end_ms"] != row["mono_start_ms"] + content:
                    conn.execute(
                        "UPDATE segments SET mono_end_ms=mono_start_ms+?, wall_end_ms=wall_start_ms+?"
                        " WHERE id=? AND closed=0;",
                        (content, content, row["id"]),
                    )
                    conn.commit()
                continue
            if now - last[1] < STALL_SEC:
                continue

            self._growth.pop(row["id"], None)
            stalled += 1
            if not has_data:
                self._mark_empty(conn, path)
                conn.commit()
                continue

            # Следующий фрагмент есть — запись шла дальше, потеряно только закрытие
            later = conn.execute(
                "SELECT 1 FROM segments WHERE camera_id=? AND stream_key=? AND id>? LIMIT 1;",
                (row["camera_id"], row["stream_key"], row["id"]),
            ).fetchone()
            error = None if later else f"stalled: no growth for {STALL_SEC} s"
            conn.execute(
                "UPDATE segments SET mono_end_ms=mono_start_ms+?, wall_end_ms=wall_start_ms+?, size_bytes=?,"
                " closed=1, verified=1, error=COALESCE(error, ?) WHERE id=? AND closed=0;",
                (content, content, size, error, row["id"]),
            )
            conn.commit()
            logger.warning("Open segment stopped growing, closed at %d ms%s: %s",
                           content, "" if later else " (recording stopped)", path)

        open_ids = {row["id"] for row in rows}
        for row_id in set(self._growth) - open_ids:
            del self._growth[row_id]
        return growing, stalled

    def _verify_closed(self, conn: sqlite3.Connection) -> int:
        deadline = time.monotonic() + VERIFY_BUDGET_SEC
        rows = conn.execute(
            "SELECT id, path, mono_start_ms, mono_end_ms, volume_id FROM segments"
            " WHERE closed=1 AND verified=0 ORDER BY id DESC LIMIT 500;"
        ).fetchall()
        done = 0

        for row in rows:
            if time.monotonic() > deadline:
                break
            if self._volume_of(row) not in self.view.present:
                continue
            path = row["path"]
            try:
                size = os.path.getsize(path)
            except OSError:
                continue

            measured = mp4_header.measure_content(Path(path)) if size else (0, False)
            # Не фрагментный mp4: мерить нечем, длину держит ffprobe сверки
            if measured is None:
                conn.execute("UPDATE segments SET verified=1 WHERE id=?;", (row["id"],))
                conn.commit()
                done += 1
                continue
            content, has_data = measured
            if not has_data:
                self._mark_empty(conn, path)
                conn.commit()
                done += 1
                continue

            start, end = row["mono_start_ms"], row["mono_end_ms"]
            claimed = end - start if end is not None else None
            error = None
            if claimed is not None and claimed - content > VERIFY_SLACK_MS:
                error = f"short: claimed {claimed / 1000:.1f} s, content {content / 1000:.1f} s"
                logger.warning("Segment is shorter than claimed (%s): %s", error, path)
            if claimed is None or abs(claimed - content) > VERIFY_SLACK_MS:
                end = start + content

            stated = mp4_header.header_duration_ms(Path(path))
            if stated is not None and abs(stated - content) > VERIFY_SLACK_MS:
                mp4_header.write_duration(Path(path), content)

            conn.execute(
                "UPDATE segments SET mono_end_ms=?, wall_end_ms=wall_start_ms+?-mono_start_ms, size_bytes=?,"
                " verified=1, error=COALESCE(error, ?) WHERE id=? AND verified=0;",
                (end, end, size, error, row["id"]),
            )
            conn.commit()
            done += 1

        return done

    def _stamp_internal(self, conn: sqlite3.Connection) -> None:
        # Строки без тома записаны во внутренний том
        if self.view.internal_id:
            conn.execute(
                "UPDATE segments SET volume_id=? WHERE volume_id IS NULL;",
                (self.view.internal_id,),
            )

    def _drop_missing(self, conn: sqlite3.Connection, known: dict) -> int:
        alive: dict[str, bool] = {}
        gone = []
        for path, row in known.items():
            if os.path.exists(path):
                continue
            volume_id = self._volume_of(row)
            # Том мог исчезнуть после опроса пула — тогда файл не удалён, а недоступен
            if volume_id not in alive:
                alive[volume_id] = self.view.alive(volume_id)
            if alive[volume_id]:
                gone.append(path)
        if not gone:
            return 0

        # Строка с причиной остаётся нулевой длины: причина разрыва не теряется
        kept = [p for p in gone if known[p]["error"]]
        dropped = [p for p in gone if not known[p]["error"]]
        conn.executemany(
            "UPDATE segments SET mono_end_ms=mono_start_ms, wall_end_ms=wall_start_ms, size_bytes=0,"
            " closed=1, verified=1 WHERE path=? AND NOT (closed=1 AND mono_end_ms IS mono_start_ms);",
            [(p,) for p in kept],
        )
        conn.executemany("DELETE FROM segments WHERE path=?;", [(p,) for p in dropped])
        for path in gone:
            known.pop(path, None)
        return len(dropped)

    def _drop_empty(self, conn: sqlite3.Connection, known: dict) -> int:
        """
        Пустой файл, который давно не меняется, — след зависшей записи: в нём
        нет ни байта, играть и мерить нечего. Файл удаляется с диска, строка
        индекса остаётся нулевой длины с причиной. Только что открытый фрагмент тоже пуст, но он
        моложе порога и остаётся.
        """
        now = datetime.now().timestamp()
        gone = 0

        for path, _camera_id, _stream_key, _volume_id in self._walk_records():
            try:
                stat = os.stat(path)
            except OSError:
                continue
            if stat.st_size or now - stat.st_mtime < OPEN_STALE_SEC:
                continue
            if self._mark_empty(conn, path):
                conn.commit()
                known.pop(path, None)
                gone += 1
        return gone

    @staticmethod
    def _mark_empty(conn: sqlite3.Connection, path: str) -> bool:
        # Файл без кадров удаляется, строка остаётся нулевой длины с причиной
        try:
            os.remove(path)
        except OSError as e:
            logger.warning("Cannot remove empty segment %s: %s", path, e)
            return False
        conn.execute(
            "UPDATE segments SET mono_end_ms=mono_start_ms, wall_end_ms=wall_start_ms, size_bytes=0,"
            " closed=1, verified=1, error=COALESCE(error, ?) WHERE path=?;",
            (EMPTY_ERROR, path),
        )
        logger.warning("Empty segment removed, row kept: %s", path)
        return True

    def _close_abandoned(self, conn: sqlite3.Connection, known: dict) -> int:
        """
        Открытая строка, файл которой давно не менялся, — след обрыва питания:
        media-center закрыть её уже не сможет, меряем файл и закрываем сами.

        Файл, записанный до фрагментного mp4, обрывом теряет заголовок целиком
        и не измерим никогда — такие строки запоминаем, чтобы не звать ffprobe
        на них каждый проход сверки.
        """
        now = datetime.now().timestamp()
        closed = 0

        for path, row in known.items():
            if row["closed"] or row["id"] in self._unmeasurable:
                continue
            try:
                stat = os.stat(path)
            except OSError:
                continue
            if now - stat.st_mtime < OPEN_STALE_SEC:
                continue

            duration_ms = _probe_duration_ms(path)
            if duration_ms is None:
                self._unmeasurable.add(row["id"])
                logger.warning("Cannot measure abandoned segment, skipping it from now on: %s", path)
                continue

            conn.execute(
                "UPDATE segments SET mono_end_ms=mono_start_ms+?,"
                " wall_end_ms=wall_start_ms+?, size_bytes=?, closed=1 WHERE id=?;",
                (duration_ms, duration_ms, stat.st_size, row["id"]),
            )
            conn.commit()
            closed += 1

        return closed

    def _measure_missing_ends(self, conn: sqlite3.Connection) -> int:
        """
        Закрытая строка без конца — это находка сверки: время взято из имени
        файла, а длительность неизвестна. Меряем ffprobe и записываем настоящий
        конец, иначе он додумывается при каждой выборке.
        """
        rows = [
            row for row in conn.execute(
                "SELECT id, path, volume_id, mono_start_ms, wall_start_ms FROM segments"
                " WHERE closed=1 AND (mono_end_ms IS NULL OR wall_end_ms IS NULL)"
                " ORDER BY id;"
            )
            if row["id"] not in self._unmeasurable and self._volume_of(row) in self.view.present
        ]
        if not rows:
            return 0

        deadline = time.monotonic() + MEASURE_BUDGET_SEC
        measured = 0

        with ThreadPoolExecutor(max_workers=MEASURE_WORKERS) as pool:
            for start in range(0, len(rows), MEASURE_CHUNK):
                if time.monotonic() > deadline:
                    break

                chunk = rows[start:start + MEASURE_CHUNK]
                # Замеры пачки до записи: транзакция не ждёт ffprobe
                durations = list(pool.map(_probe_duration_ms, [row["path"] for row in chunk]))

                for row, duration_ms in zip(chunk, durations):
                    if duration_ms is None:
                        self._unmeasurable.add(row["id"])
                        continue

                    conn.execute(
                        "UPDATE segments SET mono_end_ms=mono_start_ms+?,"
                        " wall_end_ms=wall_start_ms+? WHERE id=?;",
                        (duration_ms, duration_ms, row["id"]),
                    )
                    measured += 1

                # Пачка коммитится сразу: длинная транзакция держала бы писателя
                # media-center и запросы архива всё время прохода
                conn.commit()

        return measured

    def _add_found(self, conn: sqlite3.Connection, known: dict) -> int:
        """
        Файлы, которых нет в базе: записи, принесённые руками, и всё, что
        накопилось до появления индекса. Время берётся из имени и достоверным
        не считается.
        """
        found = []
        now = datetime.now().timestamp()
        # Файлы удалённых диапазонов в архив не возвращаются
        pending = {row["path"] for row in conn.execute("SELECT path FROM pending_delete;")}

        for path, camera_id, stream_key, volume_id in self._walk_records():
            if path in known or path in pending:
                continue

            wall_ms = _wall_from_filename(path)
            if wall_ms is None:
                continue

            try:
                stat = os.stat(path)
            except OSError:
                continue
            # Пишущийся файл: строку на него заводит media-center
            if now - stat.st_mtime < OPEN_STALE_SEC:
                continue
            found.append((camera_id, stream_key, path, wall_ms, stat.st_size, volume_id))

        # Обход идёт без открытой транзакции, находки пишутся разом
        conn.executemany(
            "INSERT OR IGNORE INTO segments("
            "session_uid,camera_id,stream_key,path,"
            "mono_start_ms,wall_start_ms,time_source,size_bytes,closed,origin,volume_id)"
            " VALUES('',?,?,?,0,?, 'none',?,1,'scan',?);",
            found,
        )
        return len(found)

    def _walk_records(self):
        """Видеофайлы под корнем записей: <камера>/<поток>/файл и старая плоская раскладка."""
        for volume_id, root in list(self.view.present.items()):
            if root is None:
                continue
            try:
                yield from self._walk_root(root, volume_id)
            except OSError as e:
                logger.warning("Cannot walk volume %s at %s: %s", volume_id, root, e)

    @staticmethod
    def _walk_root(root: Path, volume_id: str):
        if not root.exists():
            return

        for camera_dir in sorted(root.iterdir()):
            if not camera_dir.is_dir():
                continue
            for entry in sorted(camera_dir.iterdir()):
                if entry.is_dir():
                    for file in sorted(entry.iterdir()):
                        if file.is_file() and file.suffix.lower() in VIDEO_EXTENSIONS:
                            yield str(file), camera_dir.name, entry.name, volume_id
                elif entry.is_file() and entry.suffix.lower() in VIDEO_EXTENSIONS:
                    yield str(entry), camera_dir.name, LEGACY_STREAM, volume_id

    def oldest_files(self, limit: int, volume_ids: Iterable[str]) -> list[tuple[str, str]]:
        """
        Самые старые файлы по нормализованному времени — порядок удаления при
        нехватке места. Не по mtime: когда часы врали, он не совпадает с
        порядком записи. Сортирует SQLite, наружу уходит только запрошенная
        пачка — таблица целиком в память не поднимается.
        """
        ids = list(volume_ids)
        if not ids:
            return []
        conn = self._connect()
        if conn is None:
            return []

        try:
            self._ensure_own_schema(conn)
            if not self._has_table(conn, "segments"):
                return []

            self._stamp_internal(conn)
            conn.commit()

            sessions = self._load_sessions(conn)

            params: list = []
            when = []
            for session in sessions:
                when.append("WHEN ? THEN mono_start_ms + ?")
                params += [session.uid, session.anchor_ms]

            # Строки сверки сессии не знают, у них есть только настенное время
            started = (
                "CASE session_uid " + " ".join(when) + " ELSE wall_start_ms END"
                if when else "wall_start_ms"
            )

            rows = conn.execute(
                f"SELECT path, volume_id FROM segments WHERE volume_id IN ({_places(ids)})"
                f" ORDER BY ({started}) LIMIT ?;",
                (*ids, *params, limit),
            )
            return [(row["path"], row["volume_id"]) for row in rows]
        finally:
            conn.close()

    def forget_volume(self, volume_id: str) -> int:
        conn = self._connect()
        if conn is None:
            return 0
        try:
            if not self._has_table(conn, "segments"):
                return 0
            removed = 0
            # Пачками: одна большая транзакция держала бы писателя media-center
            while True:
                cursor = conn.execute(
                    "DELETE FROM segments WHERE id IN"
                    " (SELECT id FROM segments WHERE volume_id=? LIMIT 5000);",
                    (volume_id,),
                )
                conn.commit()
                if cursor.rowcount <= 0:
                    return removed
                removed += cursor.rowcount
        finally:
            conn.close()

    def move_volume(self, volume_id: str, old_root: str, new_root: str) -> int:
        conn = self._connect()
        if conn is None:
            return 0
        try:
            self._ensure_own_schema(conn)
            if not self._has_table(conn, "segments"):
                return 0
            old_prefix = old_root.rstrip("/") + "/"
            new_prefix = new_root.rstrip("/") + "/"
            cursor = conn.execute(
                "UPDATE segments SET path = ? || substr(path, ?)"
                " WHERE volume_id=? AND substr(path, 1, ?) = ?;",
                (new_prefix, len(old_prefix) + 1, volume_id, len(old_prefix), old_prefix),
            )
            conn.execute(
                "UPDATE OR IGNORE pending_delete SET path = ? || substr(path, ?)"
                " WHERE volume_id=? AND substr(path, 1, ?) = ?;",
                (new_prefix, len(old_prefix) + 1, volume_id, len(old_prefix), old_prefix),
            )
            conn.commit()
            return cursor.rowcount
        finally:
            conn.close()

    def volume_stats(self) -> dict:
        conn = self._connect()
        if conn is None:
            return {}
        try:
            self._ensure_own_schema(conn)
            if not self._has_table(conn, "segments"):
                return {}

            anchors = {s.uid: s.anchor_ms for s in self._load_sessions(conn)}
            stats: dict[str, dict] = {}

            for row in conn.execute(
                "SELECT volume_id, session_uid, COUNT(*) AS count,"
                " COALESCE(SUM(size_bytes), 0) AS bytes,"
                " MIN(mono_start_ms) AS mono_lo, MAX(COALESCE(mono_end_ms, mono_start_ms)) AS mono_hi,"
                " MIN(wall_start_ms) AS wall_lo, MAX(COALESCE(wall_end_ms, wall_start_ms)) AS wall_hi"
                " FROM segments GROUP BY volume_id, session_uid;"
            ):
                anchor = anchors.get(row["session_uid"])
                if anchor is None:
                    lo, hi = row["wall_lo"], row["wall_hi"]
                else:
                    lo, hi = row["mono_lo"] + anchor, row["mono_hi"] + anchor

                item = stats.setdefault(self._volume_of(row), {
                    "bytes": 0, "segment_count": 0, "first_ms": lo, "last_ms": hi,
                })
                item["bytes"] += row["bytes"]
                item["segment_count"] += row["count"]
                item["first_ms"] = min(item["first_ms"], lo)
                item["last_ms"] = max(item["last_ms"], hi)

            return stats
        finally:
            conn.close()

    def segment_path(self, segment_id: int) -> Optional[str]:
        conn = self._connect()
        if conn is None:
            return None
        try:
            if not self._has_table(conn, "segments"):
                return None
            row = conn.execute("SELECT path FROM segments WHERE id=?;", (segment_id,)).fetchone()
            return row["path"] if row else None
        finally:
            conn.close()

    def forget_files(self, paths: Iterable[str]) -> None:
        """
        Файлы удалены чисткой — строки уходят вместе с ними, одной транзакцией.
        По строке за раз это были бы сотни блокировок подряд поверх писателя.
        """
        batch = [(path,) for path in paths]
        if not batch:
            return

        conn = self._connect()
        if conn is None:
            return
        try:
            if not self._has_table(conn, "segments"):
                return
            conn.executemany("DELETE FROM segments WHERE path=?;", batch)
            conn.commit()
        finally:
            conn.close()


# ── свободные функции ──

def _places(values: Iterable) -> str:
    """Плейсхолдеры под IN (...) по числу значений."""
    return ",".join("?" for _ in values)


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


# Отрезок → его куски по суткам: ключ суток, начало и конец куска
def _day_pieces(start_ms: int, end_ms: int) -> list[tuple[str, int, int]]:
    parts = []
    cursor = start_ms

    while cursor < end_ms:
        edge = min(end_ms, (cursor // DAY_MS + 1) * DAY_MS)
        parts.append((_date_key(cursor), cursor, edge))
        cursor = edge

    return parts


# Сегменты дорожки → куски для календаря: соседние с одинаковой доступностью сшиваются через короткие зазоры
def _calendar_runs(items: list[dict]) -> list[tuple[int, int, bool]]:
    runs: list[list] = []
    for item in items:
        last = runs[-1] if runs else None
        if last and last[2] == item["available"] and item["start_ms"] - last[1] <= CALENDAR_MERGE_MS:
            last[1] = max(last[1], item["end_ms"])
        else:
            runs.append([item["start_ms"], item["end_ms"], item["available"]])
    return [(start, end, available) for start, end, available in runs]


# Объединение отрезков, отсортированных по началу
def _union(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    out: list[list[int]] = []
    for start, end in spans:
        if out and start <= out[-1][1]:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return [(start, end) for start, end in out]


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


def _merge_runs(items: list[dict]) -> list[tuple[int, int, Optional[str]]]:
    """Соседние сегменты сливаются в непрерывный кусок, пока зазор мал."""
    runs: list[tuple[int, int, Optional[str]]] = []

    for item in items:
        start = item["start_ms"]
        end = item["end_ms"]
        disk = item["disk"]
        if end <= start:
            continue

        # Запись на извлечённом диске — отдельный кусок
        if runs and start - runs[-1][1] <= GAP_THRESHOLD_MS and runs[-1][2] == disk:
            runs[-1] = (runs[-1][0], max(runs[-1][1], end), disk)
        else:
            runs.append((start, end, disk))

    return runs


def _find_gaps(items: list[dict], runs: list[tuple[int, int, Optional[str]]]) -> list[dict]:
    """Пропуски между кусками: kind=power на границе сессий, record внутри одной."""
    starts = [item["start_ms"] for item in items]

    gaps = []
    for left, right in zip(runs, runs[1:]):
        # Куски одной записи на разных дисках идут встык
        if right[0] - left[1] <= GAP_THRESHOLD_MS:
            continue
        before = _session_at(items, starts, left[1])
        after = _session_at(items, starts, right[0])
        gaps.append({
            "start_ms": left[1],
            "end_ms": right[0],
            "kind": "power" if before != after else "record",
        })
    return gaps


def _session_at(items: list[dict], starts: list[int], ms: int) -> str:
    """Сессия последнего сегмента, начавшегося не позже ms; items отсортированы по началу."""
    found = bisect_right(starts, ms) - 1
    return items[found]["session_uid"] if found >= 0 else ""


index = SegmentIndex(Path(settings.ARCHIVE_DB_PATH))
