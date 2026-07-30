import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Iterator, Optional

from app.config import settings

logger = logging.getLogger(__name__)

# Разрешённые значения вердикта — совпадают с дефолтом схемы (media-center).
VERDICTS = {"unverified", "true", "false"}

GB = 1024 ** 3

# Дефолты лимитов хранилища журнала; 0 = ограничение выключено.
DEFAULT_LIMITS = {"images_limit_gb": 10.0, "db_limit_gb": 1.0}


class JournalService:
    """Чтение журнала обнаружений и правка вердиктов.

    База (SQLite, WAL) пишется процессом media-center; storage-service открывает
    её на чтение для списков/карты и на запись — только для вердиктов. Соединение
    открывается на каждый запрос: эндпоинты синхронные, FastAPI гонит их в пуле
    потоков, а отдельное соединение на вызов безопаснее общего.
    """

    def __init__(self, db_path: Path, frames_dir: Path, tiles_path: Path, map_dir: Path):
        self.db_path = db_path
        self.frames_dir = frames_dir
        self.tiles_path = tiles_path
        self.map_dir = map_dir

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=3000;")
        return conn

    def available(self) -> bool:
        return self.db_path.exists()

    # ── Чтение ──

    @staticmethod
    def _build_where(
        *,
        t_from: Optional[int] = None,
        t_to: Optional[int] = None,
        verdict: Optional[str] = None,
        camera_id: Optional[str] = None,
        config_id: Optional[str] = None,
        cids: Optional[list[int]] = None,
        bbox: Optional[tuple[float, float, float, float]] = None,
    ) -> tuple[str, list[Any]]:
        """Общий конструктор WHERE для списка и для head — иначе счётчик новых
        записей считался бы не по тому же набору, что показан пользователю."""
        where: list[str] = []
        params: list[Any] = []

        if t_from is not None:
            where.append("ts >= ?")
            params.append(t_from)
        if t_to is not None:
            where.append("ts <= ?")
            params.append(t_to)
        if verdict in VERDICTS:
            where.append("verdict = ?")
            params.append(verdict)
        if camera_id:
            where.append("camera_id = ?")
            params.append(camera_id)
        if config_id:
            where.append("config_id = ?")
            params.append(config_id)
        if cids:
            placeholders = ",".join("?" for _ in cids)
            where.append(
                f"id IN (SELECT det_id FROM detection_objects WHERE cid IN ({placeholders}))"
            )
            params.extend(cids)
        if bbox is not None:
            min_lon, min_lat, max_lon, max_lat = bbox
            where.append("gps_valid = 1 AND lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?")
            params.extend([min_lon, max_lon, min_lat, max_lat])

        clause = f"WHERE {' AND '.join(where)}" if where else ""
        return clause, params

    def head(self, **filters: Any) -> dict:
        """Максимальный id и количество записей по тем же фильтрам, что и список.

        Дешёвая ручка для периодического опроса: фронт дёргает полный список
        только когда max_id изменился.
        """
        if not self.available():
            return {"max_id": 0, "total": 0}

        clause, params = self._build_where(**filters)
        with self._connect() as conn:
            row = conn.execute(
                f"SELECT COALESCE(MAX(id), 0) AS max_id, COUNT(*) AS total FROM detections {clause}",
                params,
            ).fetchone()
        return {"max_id": row["max_id"], "total": row["total"]}

    def list_detections(
        self,
        *,
        order: str = "desc",
        limit: int = 100,
        offset: int = 0,
        **filters: Any,
    ) -> dict:
        """Список записей с фильтрами и пагинацией.

        cids — id классов (фронт разворачивает выбранный класс/суперкласс в
        список id по конфигурации; журнал о семантике классов не знает).
        bbox — (min_lon, min_lat, max_lon, max_lat) для выборки под область карты.
        """
        if not self.available():
            return {"detections": [], "total": 0, "limit": limit, "offset": offset}

        clause, params = self._build_where(**filters)
        direction = "ASC" if order == "asc" else "DESC"

        with self._connect() as conn:
            total = conn.execute(
                f"SELECT COUNT(*) AS n FROM detections {clause}", params
            ).fetchone()["n"]

            rows = conn.execute(
                f"SELECT * FROM detections {clause} "
                f"ORDER BY ts {direction} LIMIT ? OFFSET ?",
                [*params, limit, offset],
            ).fetchall()

        return {
            "detections": [self._row_to_dict(r) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    def get_detection(self, det_id: int) -> Optional[dict]:
        if not self.available():
            return None
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM detections WHERE id = ?", [det_id]
            ).fetchone()
        return self._row_to_dict(row) if row else None

    def resolve_frame(self, det_id: int) -> Optional[Path]:
        """Абсолютный путь к JPEG записи с защитой от path traversal."""
        if not self.available():
            return None
        with self._connect() as conn:
            row = conn.execute(
                "SELECT image_path FROM detections WHERE id = ?", [det_id]
            ).fetchone()
        if not row or not row["image_path"]:
            return None
        candidate = self.frames_dir / row["image_path"]
        try:
            candidate.resolve().relative_to(self.frames_dir.resolve())
        except (ValueError, OSError):
            return None
        return candidate if candidate.is_file() else None

    # ── Запись ──

    def set_verdict(self, det_id: int, verdict: str, note: Optional[str], at_ms: int) -> bool:
        if not self.available() or verdict not in VERDICTS:
            return False
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE detections SET verdict = ?, verdict_note = ?, verdict_at = ? "
                "WHERE id = ?",
                [verdict, note, at_ms, det_id],
            )
            conn.commit()
            return cur.rowcount > 0

    # ── Карта: тайлы, стиль, глифы, спрайты ──

    def resolve_map_asset(self, rel: str) -> Optional[Path]:
        """Файл стиля/глифов/спрайтов с защитой от path traversal."""
        candidate = self.map_dir / rel
        try:
            candidate.resolve().relative_to(self.map_dir.resolve())
        except (ValueError, OSError):
            return None
        return candidate if candidate.is_file() else None

    def tile(self, z: int, x: int, y: int) -> Optional[bytes]:
        """Один тайл из .mbtiles. mbtiles хранит строки в TMS — переворачиваем y.

        Для векторных тайлов внутри лежит PBF, обычно уже gzip-сжатый; отдаём как
        есть, а заголовок Content-Encoding проставляет роутер по сигнатуре.
        """
        if not self.tiles_path.exists():
            return None
        tms_y = (1 << z) - 1 - y
        try:
            conn = sqlite3.connect(f"file:{self.tiles_path}?mode=ro", uri=True, timeout=2.0)
            try:
                row = conn.execute(
                    "SELECT tile_data FROM tiles "
                    "WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
                    [z, x, tms_y],
                ).fetchone()
            finally:
                conn.close()
        except sqlite3.Error as e:
            logger.warning("tile(%s/%s/%s) failed: %s", z, x, y, e)
            return None
        return row[0] if row else None

    # ── Хранилище: лимиты, занятость, удаление старого ──

    def _ensure_settings(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS journal_settings("
            "  key TEXT PRIMARY KEY,"
            "  value REAL NOT NULL"
            ")"
        )
        conn.executemany(
            "INSERT OR IGNORE INTO journal_settings(key, value) VALUES (?, ?)",
            list(DEFAULT_LIMITS.items()),
        )
        conn.commit()

    def read_limits(self) -> dict:
        """Лимиты в ГБ из таблицы настроек; 0 = ограничение выключено."""
        limits = dict(DEFAULT_LIMITS)
        if not self.available():
            return limits
        with self._connect() as conn:
            self._ensure_settings(conn)
            for row in conn.execute("SELECT key, value FROM journal_settings"):
                if row["key"] in limits:
                    limits[row["key"]] = max(0.0, float(row["value"]))
        return limits

    def write_limits(self, images_limit_gb: float, db_limit_gb: float) -> bool:
        if not self.available():
            return False
        with self._connect() as conn:
            self._ensure_settings(conn)
            conn.executemany(
                "INSERT INTO journal_settings(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [
                    ("images_limit_gb", max(0.0, images_limit_gb)),
                    ("db_limit_gb", max(0.0, db_limit_gb)),
                ],
            )
            conn.commit()
        return True

    def frames_size_bytes(self) -> int:
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

    def db_size_bytes(self) -> int:
        total = 0
        for suffix in ("", "-wal"):
            p = Path(str(self.db_path) + suffix)
            try:
                if p.is_file():
                    total += p.stat().st_size
            except OSError:
                continue
        return total

    def storage_state(self) -> dict:
        return {
            **self.read_limits(),
            "frames_bytes": self.frames_size_bytes(),
            "db_bytes": self.db_size_bytes(),
        }

    def _frames_oldest_first(self) -> Iterator[Path]:
        """JPEG от старых к новым: дневные каталоги YYYY-MM-DD сортируются
        именем, внутри дня — по mtime."""
        if not self.frames_dir.is_dir():
            return
        day_dirs = sorted(d for d in self.frames_dir.iterdir() if d.is_dir())
        for day in day_dirs:
            try:
                files = sorted(
                    (f for f in day.iterdir() if f.is_file()),
                    key=lambda f: f.stat().st_mtime,
                )
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

    def delete_oldest_frames(self, bytes_to_free: int) -> tuple[int, int]:
        """Удаляет старейшие кадры, записи в базе не трогает — журнал покажет
        заглушку вместо изображения. Возвращает (файлов, байт)."""
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
                logger.warning("delete_oldest_frames: %s: %s", path, e)
        self._remove_empty_day_dirs()
        return deleted, freed

    def _unlink_frames(self, image_paths: list[str]) -> int:
        deleted = 0
        for rel in image_paths:
            if not rel:
                continue
            candidate = self.frames_dir / rel
            try:
                candidate.resolve().relative_to(self.frames_dir.resolve())
            except (ValueError, OSError):
                continue
            try:
                candidate.unlink(missing_ok=True)
                deleted += 1
            except OSError as e:
                logger.warning("_unlink_frames: %s: %s", rel, e)
        return deleted

    def ensure_incremental_vacuum(self) -> None:
        """Включает auto_vacuum=INCREMENTAL: без него удаление строк не
        уменьшает файл. Смена режима требует полного VACUUM — при активном
        писателе может не пройти, тогда повтор в следующем цикле."""
        if not self.available():
            return
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        try:
            mode = conn.execute("PRAGMA auto_vacuum").fetchone()[0]
            if mode == 2:
                return
            conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
            conn.execute("VACUUM")
            logger.info("journal.db: auto_vacuum switched to INCREMENTAL")
        except sqlite3.Error as e:
            logger.warning("ensure_incremental_vacuum failed (retry later): %s", e)
        finally:
            conn.close()

    def compact(self) -> None:
        """Возврат освобождённых страниц диску + усечение WAL."""
        if not self.available():
            return
        try:
            conn = sqlite3.connect(self.db_path, timeout=10.0)
            try:
                conn.execute("PRAGMA busy_timeout=3000")
                conn.execute("PRAGMA incremental_vacuum")
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            finally:
                conn.close()
        except sqlite3.Error as e:
            logger.warning("compact failed: %s", e)

    def delete_oldest_detections(self, batch: int = 500) -> tuple[int, int]:
        """Старейшие записи вместе с их изображениями. Возвращает (записей, файлов)."""
        if not self.available():
            return 0, 0
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, image_path FROM detections ORDER BY ts ASC LIMIT ?",
                [batch],
            ).fetchall()
            if not rows:
                return 0, 0
            ids = [r["id"] for r in rows]
            placeholders = ",".join("?" for _ in ids)
            conn.execute(f"DELETE FROM detection_objects WHERE det_id IN ({placeholders})", ids)
            conn.execute(f"DELETE FROM detections WHERE id IN ({placeholders})", ids)
            conn.commit()

        files = self._unlink_frames([r["image_path"] for r in rows])
        self._remove_empty_day_dirs()
        return len(rows), files

    def purge(self, before_ts: Optional[int] = None) -> dict:
        """Очистка журнала: всё или записи старше before_ts (unix ms),
        вместе с изображениями. Завершается вакуумом."""
        if not self.available():
            return {"deleted": 0, "files_deleted": 0}

        deleted = 0
        files_deleted = 0
        while True:
            with self._connect() as conn:
                if before_ts is None:
                    rows = conn.execute(
                        "SELECT id, image_path FROM detections ORDER BY ts ASC LIMIT 1000"
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT id, image_path FROM detections WHERE ts < ? "
                        "ORDER BY ts ASC LIMIT 1000",
                        [before_ts],
                    ).fetchall()
                if not rows:
                    break
                ids = [r["id"] for r in rows]
                placeholders = ",".join("?" for _ in ids)
                conn.execute(
                    f"DELETE FROM detection_objects WHERE det_id IN ({placeholders})", ids
                )
                conn.execute(f"DELETE FROM detections WHERE id IN ({placeholders})", ids)
                conn.commit()

            deleted += len(rows)
            files_deleted += self._unlink_frames([r["image_path"] for r in rows])

        self._remove_empty_day_dirs()
        self.ensure_incremental_vacuum()
        self.compact()

        logger.info("purge: %d detections, %d frames deleted", deleted, files_deleted)
        return {"deleted": deleted, "files_deleted": files_deleted}

    # ── helpers ──

    def _row_to_dict(self, row: sqlite3.Row) -> dict:
        try:
            objects = json.loads(row["dets_json"]) if row["dets_json"] else []
        except (ValueError, TypeError):
            objects = []

        gps = None
        if row["gps_valid"]:
            gps = {
                "lat": row["lat"],
                "lon": row["lon"],
                "alt": row["alt"],
                "speed": row["speed"],
                "course": row["course"],
            }

        return {
            "id": row["id"],
            "ts": row["ts"],
            "camera_id": row["camera_id"],
            "config_id": row["config_id"],
            "gps": gps,
            "width": row["width"],
            "height": row["height"],
            "track_id": row["track_id"],
            "event": row["event"],
            "objects": objects,
            "verdict": row["verdict"],
            "verdict_note": row["verdict_note"],
            "verdict_at": row["verdict_at"],
            "frame_url": f"/api/journal/frame/{row['id']}.jpg",
        }


journal = JournalService(
    Path(settings.JOURNAL_DB_PATH),
    Path(settings.JOURNAL_FRAMES_PATH),
    Path(settings.JOURNAL_TILES_MBTILES),
    Path(settings.JOURNAL_MAP_DIR),
)
