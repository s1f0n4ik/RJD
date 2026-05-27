import asyncio
import logging

from app.config import settings
from app.services.storage import storage

logger = logging.getLogger(__name__)


class StorageCleaner:
    """
    Фоновая задача, следящая за объёмом записей.
    Если превышен MAX_STORAGE_GB — удаляет самые старые файлы
    до CLEANUP_TARGET_RATIO * лимит.
    """

    def __init__(self):
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self):
        if settings.MAX_STORAGE_GB <= 0:
            logger.info("Cleanup disabled (MAX_STORAGE_GB=0)")
            return
        logger.info(
            "Starting cleaner: limit=%sGB, target=%.0f%%, interval=%ss",
            settings.MAX_STORAGE_GB,
            settings.CLEANUP_TARGET_RATIO * 100,
            settings.CLEANUP_INTERVAL_SEC,
            )
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        self._stop.set()
        if self._task:
            await self._task

    async def _run(self):
        while not self._stop.is_set():
            try:
                await self._check_once()
            except Exception:
                logger.exception("Cleaner iteration failed")

            try:
                await asyncio.wait_for(
                    self._stop.wait(),
                    timeout=settings.CLEANUP_INTERVAL_SEC,
                )
            except asyncio.TimeoutError:
                pass

    async def _check_once(self):
        # storage.total_size_bytes() — синхронный, может блокировать loop на больших каталогах.
        # Выносим в thread executor.
        loop = asyncio.get_running_loop()
        total_bytes = await loop.run_in_executor(None, storage.total_size_bytes)

        limit_bytes = int(settings.MAX_STORAGE_GB * 1024 ** 3)
        target_bytes = int(limit_bytes * settings.CLEANUP_TARGET_RATIO)

        if total_bytes <= limit_bytes:
            logger.debug(
                "Storage OK: %.2fGB / %.2fGB",
                total_bytes / 1024 ** 3, settings.MAX_STORAGE_GB,
                )
            return

        logger.warning(
            "Storage limit exceeded: %.2fGB / %.2fGB. Cleaning to %.2fGB",
            total_bytes / 1024 ** 3,
            settings.MAX_STORAGE_GB,
            target_bytes / 1024 ** 3,
            )

        await loop.run_in_executor(None, self._delete_until, target_bytes, total_bytes)

    def _delete_until(self, target_bytes: int, current_bytes: int):
        """
        Синхронная процедура удаления.
        Идём по всем файлам от самых старых до новых и удаляем,
        пока не уложимся в target_bytes.
        """
        deleted_count = 0
        freed_bytes = 0

        for file_path in storage.all_files_oldest_first():
            if current_bytes - freed_bytes <= target_bytes:
                break
            try:
                size = file_path.stat().st_size
                file_path.unlink()
                freed_bytes += size
                deleted_count += 1
                logger.info("Deleted old recording: %s (%.2fMB)", file_path, size / 1024**2)
            except OSError as e:
                logger.warning("Failed to delete %s: %s", file_path, e)

        # После удаления файлов — чистим пустые подкаталоги
        removed_dirs = storage.remove_empty_subdirs()

        logger.info(
            "Cleanup done: %d files (%.2fGB freed), %d empty dirs removed",
            deleted_count, freed_bytes / 1024 ** 3, removed_dirs,
                           )


cleaner = StorageCleaner()