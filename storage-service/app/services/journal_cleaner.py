import asyncio
import logging

from app.config import settings
from app.services.journal import journal, GB

logger = logging.getLogger(__name__)

# Чистим до этой доли лимита, чтобы не удалять по чуть-чуть каждый цикл
TARGET_RATIO = 0.9
# Потолок пакетов удаления записей за цикл: длинную чистку продолжит следующий
MAX_BATCHES_PER_CYCLE = 20


class JournalCleaner:
    """Фоновый надзор за хранилищем журнала обнаружений.

    Лимиты читаются из таблицы journal_settings в самой базе (правятся с
    фронта на лету). Изображения сверх лимита удаляются без записей — журнал
    покажет заглушку; база сверх лимита теряет старейшие записи вместе с их
    изображениями.
    """

    def __init__(self):
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self):
        logger.info("Starting journal cleaner: interval=%ss", settings.CLEANUP_INTERVAL_SEC)
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        self._stop.set()
        if self._task:
            await self._task

    async def _run(self):
        while not self._stop.is_set():
            try:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, self._check_once)
            except Exception:
                logger.exception("Journal cleaner iteration failed")

            try:
                await asyncio.wait_for(
                    self._stop.wait(),
                    timeout=settings.CLEANUP_INTERVAL_SEC,
                )
            except asyncio.TimeoutError:
                pass

    def _check_once(self):
        if not journal.available():
            return

        limits = journal.read_limits()
        self._check_frames(limits["images_limit_gb"])
        self._check_db(limits["db_limit_gb"])

    def _check_frames(self, limit_gb: float):
        if limit_gb <= 0:
            return
        limit = int(limit_gb * GB)
        size = journal.frames_size_bytes()
        if size <= limit:
            return

        target = int(limit * TARGET_RATIO)
        deleted, freed = journal.delete_oldest_frames(size - target)
        logger.warning(
            "Journal frames over limit: %.2fGB > %.2fGB — deleted %d files (%.2fGB), records kept",
            size / GB, limit_gb, deleted, freed / GB,
        )

    def _check_db(self, limit_gb: float):
        if limit_gb <= 0:
            return
        limit = int(limit_gb * GB)
        journal.compact()
        size = journal.db_size_bytes()
        if size <= limit:
            return

        # Без инкрементального вакуума удаление строк не вернёт место диску
        journal.ensure_incremental_vacuum()

        target = int(limit * TARGET_RATIO)
        total_rows = 0
        total_files = 0
        for _ in range(MAX_BATCHES_PER_CYCLE):
            rows, files = journal.delete_oldest_detections()
            if rows == 0:
                break
            total_rows += rows
            total_files += files
            journal.compact()
            if journal.db_size_bytes() <= target:
                break

        logger.warning(
            "Journal db over limit: %.2fGB > %.2fGB — deleted %d detections (%d frames), now %.2fGB",
            size / GB, limit_gb, total_rows, total_files, journal.db_size_bytes() / GB,
        )


journal_cleaner = JournalCleaner()
