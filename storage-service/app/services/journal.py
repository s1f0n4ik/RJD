import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Optional

from app.config import settings

logger = logging.getLogger(__name__)

# Разрешённые значения вердикта — совпадают с дефолтом схемы (media-center).
VERDICTS = {"unverified", "true", "false"}


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

    def list_detections(
        self,
        *,
        t_from: Optional[int] = None,
        t_to: Optional[int] = None,
        verdict: Optional[str] = None,
        camera_id: Optional[str] = None,
        config_id: Optional[str] = None,
        cids: Optional[list[int]] = None,
        bbox: Optional[tuple[float, float, float, float]] = None,
        order: str = "desc",
        limit: int = 100,
        offset: int = 0,
    ) -> dict:
        """Список записей с фильтрами и пагинацией.

        cids — id классов (фронт разворачивает выбранный класс/суперкласс в
        список id по конфигурации; журнал о семантике классов не знает).
        bbox — (min_lon, min_lat, max_lon, max_lat) для выборки под область карты.
        """
        if not self.available():
            return {"detections": [], "total": 0, "limit": limit, "offset": offset}

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
