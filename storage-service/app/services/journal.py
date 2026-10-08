import logging
import sqlite3
from contextlib import closing
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)

GB = 1024 ** 3

# Лимиты журнала по умолчанию, ГБ; их ведёт мастер обнаружений в journal_settings
DEFAULT_LIMITS = {"images_limit_gb": 25.0, "db_limit_gb": 1.0}


class JournalService:
    # Журнал пишет мастер обнаружений; здесь — только его вес и лимиты для резерва диска
    def __init__(self, db_path: Path, frames_dir: Path):
        self.db_path = db_path
        self.frames_dir = frames_dir

    def available(self) -> bool:
        return self.db_path.exists()

    def read_limits(self) -> dict:
        limits = dict(DEFAULT_LIMITS)
        if not self.available():
            return limits
        try:
            with closing(sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, timeout=5.0)) as conn:
                for key, value in conn.execute("SELECT key, value FROM journal_settings"):
                    if key in limits:
                        limits[key] = max(0.0, float(value))
        except sqlite3.Error as e:
            logger.warning("journal limits unavailable: %s", e)
        return limits

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
            path = Path(str(self.db_path) + suffix)
            try:
                if path.is_file():
                    total += path.stat().st_size
            except OSError:
                continue
        return total

    def journal_bytes(self) -> int:
        return self.frames_size_bytes() + self.db_size_bytes()

    # Нет базы — нет журнала на этой машине, резервировать нечего
    def reserve_bytes(self) -> int:
        if not self.available():
            return 0
        limits = self.read_limits()
        return int((limits["images_limit_gb"] + limits["db_limit_gb"]) * GB)


journal = JournalService(Path(settings.JOURNAL_DB_PATH), Path(settings.JOURNAL_FRAMES_PATH))
