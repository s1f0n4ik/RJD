import asyncio
import logging

from itertools import islice
from pathlib import Path

from app.config import settings
from app.services import exports
from app.services.segments import index
from app.services.storage import storage

logger = logging.getLogger(__name__)


class StorageCleaner:
    """
    Фоновая задача, следящая за занятостью диска с записями.
    Когда занято больше MAX_USED_PERCENT — удаляет самые старые файлы,
    пока занятость не опустится до порога * CLEANUP_TARGET_RATIO.
    """

    def __init__(self):
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self):
        if settings.MAX_USED_PERCENT <= 0:
            logger.info("Cleanup disabled (MAX_USED_PERCENT=0)")
            return
        logger.info(
            "Starting cleaner: threshold=%.0f%% used, target=%.0f%% used, interval=%ss",
            settings.MAX_USED_PERCENT,
            settings.MAX_USED_PERCENT * settings.CLEANUP_TARGET_RATIO,
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
        loop = asyncio.get_running_loop()
        usage = await loop.run_in_executor(None, storage.disk_usage)
        if usage is None:
            return

        # Результаты выгрузок живут под своей квотой и записи не вытесняют
        exported = await loop.run_in_executor(None, lambda: exports.dir_size(exports.root()))
        used = max(0, usage.used - exported)
        free = usage.free + exported
        used_percent = used / usage.total * 100 if usage.total else 0.0

        if used_percent <= settings.MAX_USED_PERCENT:
            logger.debug(
                "Disk OK: %.1f%% used (free %.2fGB)",
                used_percent, free / 1024 ** 3,
                )
            return

        # Чистим пока занятость не упадёт до порога с запасом.
        # target_free_bytes — сколько свободного места нужно достичь.
        target_used_percent = settings.MAX_USED_PERCENT * settings.CLEANUP_TARGET_RATIO
        target_free_bytes = int(usage.total * (1 - target_used_percent / 100))

        logger.warning(
            "Disk usage over threshold: %.1f%% > %.1f%%. Freeing down to %.1f%% used",
            used_percent, settings.MAX_USED_PERCENT, target_used_percent,
            )

        await loop.run_in_executor(None, self._free_until, target_free_bytes, free)

    def _free_until(self, target_free_bytes: int, start_free_bytes: int):
        """
        Синхронная процедура удаления.
        Идём от самых старых файлов к новым и удаляем, пока оценка свободного
        места не достигнет target_free_bytes. Запись параллельно занимает место,
        поэтому это оценка, финальную коррекцию делает следующий цикл.

        Проход ограничен сверху: освободить девять процентов диска одним махом
        значит снести сотни файлов подряд, а следующий цикл всё равно через
        минуту. Заодно это страховка — неверный порядок удаления виден после
        первой пачки, а не после всей глубины архива.
        """
        limit = settings.CLEANUP_MAX_FILES_PER_PASS
        deleted: list[str] = []
        freed_bytes = 0

        for file_path in self._oldest_first(limit):
            if start_free_bytes + freed_bytes >= target_free_bytes:
                break
            if freed_bytes >= settings.CLEANUP_MAX_BYTES_PER_PASS:
                logger.info("Pass byte limit reached, rest goes to the next cycle")
                break
            try:
                size = file_path.stat().st_size
                file_path.unlink()
                freed_bytes += size
                deleted.append(str(file_path))
                logger.info("Deleted old recording: %s (%.2fMB)", file_path, size / 1024**2)
            except OSError as e:
                logger.warning("Failed to delete %s: %s", file_path, e)

        # Файлы и их строки уходят вместе, иначе индекс начнёт врать
        index.forget_files(deleted)

        removed_dirs = storage.remove_empty_subdirs()

        logger.info(
            "Cleanup pass done: %d files (%.2fGB freed), %d empty dirs removed",
            len(deleted), freed_bytes / 1024 ** 3, removed_dirs,
                           )

    @staticmethod
    def _oldest_first(limit: int):
        """
        Порядок удаления берём из индекса: он знает нормализованное время
        записи. Когда часы изделия врали, mtime не совпадает с порядком записи,
        и чистка по нему съедает не то. Индекса нет — падаем на обход диска.
        """
        indexed = index.oldest_files(limit)
        if indexed:
            return [Path(path) for path in indexed]

        logger.warning("Segment index is empty, falling back to mtime order")
        # Обход диска отдаёт итератор, срез по нему не сделать
        return list(islice(storage.all_files_oldest_first(), limit))


cleaner = StorageCleaner()
