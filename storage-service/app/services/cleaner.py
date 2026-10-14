import asyncio
import logging
import shutil

from itertools import islice
from pathlib import Path
from typing import Optional

from app.config import settings
from app.services.segments import index
from app.services.storage import storage
from app.services.volumes import internal_usage, pool

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
        await loop.run_in_executor(None, self._check_internal)
        await loop.run_in_executor(None, self._check_ring)

    def _check_internal(self):
        # /storage чистится собственным давлением: выгрузки и резерв журнала
        entry = pool.internal_entry()
        measured = internal_usage()
        if measured is None or not measured["total"]:
            return

        total = measured["total"]
        percent = measured["used"] / total * 100
        if percent <= entry["high"]:
            logger.debug("Internal disk OK: %.1f%% used (free %.2fGB)", percent, measured["free"] / 1024 ** 3)
            return

        logger.warning(
            "Internal disk over threshold: %.1f%% > %.1f%%. Freeing down to %.1f%% used",
            percent, entry["high"], entry["low"],
        )
        need = {entry["id"]: int(total * (1 - entry["low"] / 100)) - measured["free"]}

        limit = settings.CLEANUP_MAX_FILES_PER_PASS
        candidates = index.oldest_files(limit, need)
        if not candidates:
            logger.warning("Segment index is empty, falling back to mtime order")
            candidates = [(str(p), entry["id"]) for p in islice(storage.all_files_oldest_first(), limit)]

        self._free(candidates, need, [storage.root])

    def _check_ring(self):
        # Внешние диски чистятся кольцом, только когда писать уже некуда
        ring = pool.ring()
        if not ring:
            return

        need: dict[str, int] = {}
        for entry, mount, _root in ring:
            usage = self._disk(mount)
            if usage is None or usage.used / usage.total * 100 < entry["high"]:
                return
            need[entry["id"]] = usage.used - int(usage.total * entry["low"] / 100)

        logger.warning("All write disks are over their thresholds, freeing the oldest recordings")
        candidates = index.oldest_files(settings.CLEANUP_MAX_FILES_PER_PASS, need)
        self._free(candidates, need, [root for _entry, _mount, root in ring])

    @staticmethod
    def _disk(path: str):
        try:
            usage = shutil.disk_usage(path)
        except OSError:
            return None
        return usage if usage.total else None

    @staticmethod
    def _free(candidates: list[tuple[str, str]], need: dict[str, int], roots: list[Optional[Path]]):
        # Самые старые файлы удаляются, пока хоть один том не освободит своё
        deleted: list[str] = []
        freed: dict[str, int] = {}
        freed_total = 0

        for file_path, volume_id in candidates:
            if any(freed.get(v, 0) >= n for v, n in need.items()):
                break
            if freed_total >= settings.CLEANUP_MAX_BYTES_PER_PASS:
                logger.info("Pass byte limit reached, rest goes to the next cycle")
                break
            path = Path(file_path)
            try:
                size = path.stat().st_size
                path.unlink()
            except OSError as e:
                logger.warning("Failed to delete %s: %s", path, e)
                continue
            freed[volume_id] = freed.get(volume_id, 0) + size
            freed_total += size
            deleted.append(file_path)
            logger.info("Deleted old recording: %s (%.2fMB)", path, size / 1024 ** 2)

        # Файлы и их строки уходят вместе, иначе индекс начнёт врать
        index.forget_files(deleted)

        removed_dirs = sum(storage.remove_empty_subdirs(root) for root in roots if root)

        logger.info(
            "Cleanup pass done: %d files (%.2fGB freed), %d empty dirs removed",
            len(deleted), freed_total / 1024 ** 3, removed_dirs,
        )


cleaner = StorageCleaner()
