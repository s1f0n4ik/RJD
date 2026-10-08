import json
import logging
import shutil
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

logger = logging.getLogger(__name__)

GB = 1024 ** 3
# Лимиты хранилища журнала по умолчанию, ГБ; 0 — без ограничения
DEFAULT_LIMITS = {"images_limit_gb": 25.0, "db_limit_gb": 1.0}
# Чистка до этой доли лимита, чтобы не удалять по чуть-чуть каждый цикл
TARGET_RATIO = 0.9
# Потолок пачек удаления записей за цикл: длинную чистку продолжит следующий
MAX_BATCHES_PER_CYCLE = 20

SCHEMA = """
CREATE TABLE IF NOT EXISTS detections(
    id INTEGER PRIMARY KEY,
    device_id TEXT NOT NULL,
    camera_id TEXT NOT NULL,
    config_id TEXT,
    class_id INTEGER,
    class_name TEXT,
    superclass TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    closed_reason TEXT,
    image_id INTEGER,
    lat REAL,
    lon REAL,
    gps_valid INTEGER NOT NULL DEFAULT 0,
    late INTEGER NOT NULL DEFAULT 0,
    verdict TEXT NOT NULL DEFAULT 'unverified',
    verdict_note TEXT,
    verdict_at INTEGER
);
CREATE TABLE IF NOT EXISTS tracks(
    id INTEGER PRIMARY KEY,
    detection_id INTEGER,
    device_id TEXT NOT NULL,
    session INTEGER NOT NULL,
    track_no INTEGER NOT NULL,
    camera_id TEXT NOT NULL,
    class_id INTEGER,
    class_name TEXT,
    superclass TEXT,
    first_ts INTEGER NOT NULL,
    last_ts INTEGER NOT NULL,
    UNIQUE(device_id, session, track_no)
);
CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY,
    track_id INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    session INTEGER NOT NULL,
    packet_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    ts INTEGER NOT NULL,
    confidence REAL,
    x INTEGER, y INTEGER, w INTEGER, h INTEGER,
    frame_w INTEGER, frame_h INTEGER,
    lat REAL, lon REAL, alt REAL, speed REAL, course REAL,
    gps_valid INTEGER NOT NULL DEFAULT 0,
    sadko_time INTEGER NOT NULL DEFAULT 0,
    image_ref INTEGER,
    received_at INTEGER NOT NULL,
    late INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS images(
    id INTEGER PRIMARY KEY,
    device_id TEXT NOT NULL,
    session INTEGER NOT NULL,
    device_image_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    bytes INTEGER,
    received_at INTEGER NOT NULL,
    UNIQUE(device_id, session, device_image_id)
);
CREATE TABLE IF NOT EXISTS journal_settings(
    key TEXT PRIMARY KEY,
    value REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_det_started ON detections(started_at);
CREATE INDEX IF NOT EXISTS idx_det_ended ON detections(ended_at);
CREATE INDEX IF NOT EXISTS idx_track_det ON tracks(detection_id);
CREATE INDEX IF NOT EXISTS idx_event_track ON events(track_id);
CREATE INDEX IF NOT EXISTS idx_event_packet ON events(device_id, session, packet_id);
CREATE INDEX IF NOT EXISTS idx_event_image ON events(device_id, session, image_ref);
"""

EVENT_GPS = ("lat", "lon", "alt", "speed", "course")


def now_ms() -> int:
    return int(time.time() * 1000)


class Journal:
    # Все вызовы — из одного рабочего потока мастера
    def __init__(self, root: Path):
        self.root = root
        self.db_path = root / "journal.db"
        self.frames_dir = root / "frames"
        self.state_path = root / "master-state.json"
        self.conn: Optional[sqlite3.Connection] = None

    def open(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        legacy_limits = self._move_legacy()

        self.conn = sqlite3.connect(self.db_path, timeout=10.0, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.conn.executescript(SCHEMA)
        self.conn.executemany(
            "INSERT OR IGNORE INTO journal_settings(key, value) VALUES (?, ?)", list(DEFAULT_LIMITS.items())
        )
        self.conn.executemany(
            "INSERT OR REPLACE INTO journal_settings(key, value) VALUES (?, ?)", list(legacy_limits.items())
        )
        self.conn.commit()
        rows = self.conn.execute("SELECT COUNT(*) FROM detections").fetchone()[0]
        logger.info("journal opened: %s, %d detection(s)", self.db_path, rows)

    def close(self) -> None:
        if self.conn is not None:
            self.conn.close()
            self.conn = None

    # Старая база media-center с её кадрами уходит в legacy-<дата>; возвращает её лимиты
    def _move_legacy(self) -> dict:
        if not self.db_path.exists():
            return {}
        probe = sqlite3.connect(self.db_path, timeout=10.0)
        try:
            legacy = probe.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'detection_objects'"
            ).fetchone() is not None
            limits = {}
            if legacy and probe.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journal_settings'"
            ).fetchone():
                limits = {
                    key: float(value)
                    for key, value in probe.execute("SELECT key, value FROM journal_settings")
                    if key in DEFAULT_LIMITS
                }
        finally:
            probe.close()
        if not legacy:
            return {}

        stamp = datetime.now()
        dest = self.root / f"legacy-{stamp:%Y-%m-%d}"
        if dest.exists():
            dest = self.root / f"legacy-{stamp:%Y-%m-%d-%H%M%S}"
        dest.mkdir(parents=True)
        for name in ("journal.db", "journal.db-wal", "journal.db-shm", "frames"):
            src = self.root / name
            if src.exists():
                shutil.move(str(src), str(dest / name))
        logger.warning("legacy journal moved to %s, limits kept: %s", dest, limits)
        return limits

    def commit(self) -> None:
        self.conn.commit()

    # ── Последняя известная конфигурация шлюза ──

    def load_active(self) -> Optional[str]:
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8")).get("active_integration")
        except (OSError, ValueError):
            return None

    def save_active(self, active: str) -> None:
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"active_integration": active}), encoding="utf-8")
        tmp.replace(self.state_path)

    # ── Запись ──

    def packet_seen(self, device_id: str, session: int, packet_id: int) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM events WHERE device_id = ? AND session = ? AND packet_id = ? LIMIT 1",
            [device_id, session, packet_id],
        ).fetchone() is not None

    def add_detection(self, packet, track, late: bool) -> int:
        gps = packet.gps
        cur = self.conn.execute(
            "INSERT INTO detections(device_id, camera_id, config_id, class_id, class_name, superclass, "
            "started_at, lat, lon, gps_valid, late) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                packet.device_id, packet.camera_id, packet.config_id, track.class_id, track.class_name,
                track.superclass or None, packet.ts,
                gps.lat if gps.valid else None, gps.lon if gps.valid else None, int(gps.valid), int(late),
            ],
        )
        return cur.lastrowid

    def close_detection(self, detection_id: int, ended_at: int, reason: str) -> None:
        self.conn.execute(
            "UPDATE detections SET ended_at = ?, closed_reason = ? WHERE id = ? AND ended_at IS NULL",
            [ended_at, reason, detection_id],
        )

    # Открытые прошлого запуска: конец — последнее время их треков
    def close_all_open(self, reason: str) -> int:
        cur = self.conn.execute(
            "UPDATE detections SET closed_reason = ?, ended_at = COALESCE("
            "(SELECT MAX(last_ts) FROM tracks WHERE tracks.detection_id = detections.id), started_at) "
            "WHERE ended_at IS NULL",
            [reason],
        )
        self.conn.commit()
        return cur.rowcount

    def set_detection_image(self, detection_id: int, image_id: int) -> None:
        self.conn.execute(
            "UPDATE detections SET image_id = ? WHERE id = ? AND image_id IS NULL", [image_id, detection_id]
        )

    # Трек уже был (связь вернулась после закрытия) — переходит к новому обнаружению
    def add_track(self, detection_id: int, packet, track) -> int:
        return self.conn.execute(
            "INSERT INTO tracks(detection_id, device_id, session, track_no, camera_id, class_id, class_name, "
            "superclass, first_ts, last_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(device_id, session, track_no) DO UPDATE SET "
            "detection_id = excluded.detection_id, last_ts = excluded.last_ts RETURNING id",
            [
                detection_id, packet.device_id, packet.session, track.track_id, packet.camera_id,
                track.class_id, track.class_name, track.superclass or None, packet.ts, packet.ts,
            ],
        ).fetchone()[0]

    def touch_track(self, track_row: int, ts: int) -> None:
        self.conn.execute("UPDATE tracks SET last_ts = MAX(last_ts, ?) WHERE id = ?", [ts, track_row])

    def add_event(self, track_row: int, packet, track, event: str, received_at: int, late: bool) -> None:
        box = list(track.box) if len(track.box) == 4 else [None] * 4
        gps = packet.gps
        self.conn.execute(
            "INSERT INTO events(track_id, device_id, session, packet_id, event, ts, confidence, x, y, w, h, "
            "frame_w, frame_h, lat, lon, alt, speed, course, gps_valid, sadko_time, image_ref, received_at, late) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                track_row, packet.device_id, packet.session, packet.id, event, packet.ts, track.confidence,
                *box, packet.width, packet.height,
                *(getattr(gps, f) if gps.valid else None for f in EVENT_GPS),
                int(gps.valid), int(packet.sadko_time), packet.image_id or None, received_at, int(late),
            ],
        )

    # Снимок файлом в frames/<дата>/<id>.jpg; повтор — None
    def add_image(self, image, received_at: int) -> Optional[int]:
        cur = self.conn.execute(
            "INSERT OR IGNORE INTO images(device_id, session, device_image_id, path, width, height, bytes, "
            "received_at) VALUES (?, ?, ?, '', ?, ?, ?, ?)",
            [image.device_id, image.session, image.id, image.width, image.height, len(image.jpeg), received_at],
        )
        if cur.rowcount == 0:
            return None
        image_id = cur.lastrowid
        day = datetime.fromtimestamp(received_at / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        rel = f"{day}/{image_id}.jpg"
        path = self.frames_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(image.jpeg)
        self.conn.execute("UPDATE images SET path = ? WHERE id = ?", [rel, image_id])
        return image_id

    def image_id(self, device_id: str, session: int, device_image_id: int) -> Optional[int]:
        row = self.conn.execute(
            "SELECT id FROM images WHERE device_id = ? AND session = ? AND device_image_id = ?",
            [device_id, session, device_image_id],
        ).fetchone()
        return row[0] if row else None

    def detections_for_image(self, device_id: str, session: int, device_image_id: int) -> list[int]:
        return [
            row[0]
            for row in self.conn.execute(
                "SELECT DISTINCT tracks.detection_id FROM events JOIN tracks ON tracks.id = events.track_id "
                "WHERE events.device_id = ? AND events.session = ? AND events.image_ref = ? "
                "AND tracks.detection_id IS NOT NULL",
                [device_id, session, device_image_id],
            )
        ]

    # ── Хранилище: лимиты и чистка ──

    def read_limits(self) -> dict:
        limits = dict(DEFAULT_LIMITS)
        for row in self.conn.execute("SELECT key, value FROM journal_settings"):
            if row["key"] in limits:
                limits[row["key"]] = max(0.0, float(row["value"]))
        return limits

    def frames_bytes(self) -> int:
        total = 0
        if not self.frames_dir.is_dir():
            return 0
        for path in self.frames_dir.rglob("*"):
            try:
                if path.is_file():
                    total += path.stat().st_size
            except OSError:
                continue
        return total

    def db_bytes(self) -> int:
        total = 0
        for suffix in ("", "-wal"):
            path = Path(str(self.db_path) + suffix)
            try:
                if path.is_file():
                    total += path.stat().st_size
            except OSError:
                continue
        return total

    def cleanup(self) -> None:
        limits = self.read_limits()
        self._check_frames(limits["images_limit_gb"])
        self._check_db(limits["db_limit_gb"])

    def _check_frames(self, limit_gb: float) -> None:
        if limit_gb <= 0:
            return
        limit = int(limit_gb * GB)
        size = self.frames_bytes()
        if size <= limit:
            return
        deleted, freed = self._delete_oldest_frames(size - int(limit * TARGET_RATIO))
        logger.warning(
            "journal frames over limit: %.2fGB > %.2fGB, deleted %d files (%.2fGB), records kept",
            size / GB, limit_gb, deleted, freed / GB,
        )

    def _check_db(self, limit_gb: float) -> None:
        if limit_gb <= 0:
            return
        limit = int(limit_gb * GB)
        self._compact()
        size = self.db_bytes()
        if size <= limit:
            return
        total_rows = 0
        total_files = 0
        for _ in range(MAX_BATCHES_PER_CYCLE):
            rows, files = self._delete_oldest_detections()
            if rows == 0:
                break
            total_rows += rows
            total_files += files
            self._compact()
            if self.db_bytes() <= int(limit * TARGET_RATIO):
                break
        logger.warning(
            "journal db over limit: %.2fGB > %.2fGB, deleted %d detections (%d frames), now %.2fGB",
            size / GB, limit_gb, total_rows, total_files, self.db_bytes() / GB,
        )

    def _frames_oldest_first(self) -> Iterator[Path]:
        if not self.frames_dir.is_dir():
            return
        for day in sorted(d for d in self.frames_dir.iterdir() if d.is_dir()):
            try:
                files = sorted((f for f in day.iterdir() if f.is_file()), key=lambda f: f.stat().st_mtime)
            except OSError:
                continue
            yield from files

    def _remove_empty_day_dirs(self) -> None:
        if not self.frames_dir.is_dir():
            return
        for day in self.frames_dir.iterdir():
            if day.is_dir():
                try:
                    day.rmdir()
                except OSError:
                    pass

    def _delete_oldest_frames(self, bytes_to_free: int) -> tuple[int, int]:
        deleted = 0
        freed = 0
        for path in self._frames_oldest_first():
            if freed >= bytes_to_free:
                break
            try:
                size = path.stat().st_size
                path.unlink()
                freed += size
                deleted += 1
            except OSError as e:
                logger.warning("delete frame %s: %s", path, e)
        self._remove_empty_day_dirs()
        return deleted, freed

    # Старейшие закрытые обнаружения вместе с треками, событиями и снимками
    def _delete_oldest_detections(self, batch: int = 500) -> tuple[int, int]:
        ids = [
            row[0]
            for row in self.conn.execute(
                "SELECT id FROM detections WHERE ended_at IS NOT NULL ORDER BY started_at LIMIT ?", [batch]
            )
        ]
        if not ids:
            return 0, 0
        marks = ",".join("?" for _ in ids)
        images = self.conn.execute(
            f"SELECT DISTINCT images.id, images.path FROM events "
            f"JOIN tracks ON tracks.id = events.track_id "
            f"JOIN images ON images.device_id = events.device_id AND images.session = events.session "
            f"AND images.device_image_id = events.image_ref WHERE tracks.detection_id IN ({marks})",
            ids,
        ).fetchall()
        self.conn.execute(
            f"DELETE FROM events WHERE track_id IN (SELECT id FROM tracks WHERE detection_id IN ({marks}))", ids
        )
        self.conn.execute(f"DELETE FROM tracks WHERE detection_id IN ({marks})", ids)
        self.conn.execute(f"DELETE FROM detections WHERE id IN ({marks})", ids)
        if images:
            self.conn.execute(
                f"DELETE FROM images WHERE id IN ({','.join('?' for _ in images)})", [row[0] for row in images]
            )
        self.conn.commit()

        files = 0
        for row in images:
            try:
                (self.frames_dir / row[1]).unlink(missing_ok=True)
                files += 1
            except OSError as e:
                logger.warning("delete frame %s: %s", row[1], e)
        self._remove_empty_day_dirs()
        return len(ids), files

    def _compact(self) -> None:
        try:
            self.conn.execute("PRAGMA incremental_vacuum").fetchall()
            self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
        except sqlite3.Error as e:
            logger.warning("journal compact failed: %s", e)
