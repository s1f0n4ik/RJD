import asyncio
import logging

from app.config import settings
from app.services.segments import index

logger = logging.getLogger(__name__)


class IndexReconciler:
    """
    Держит индекс сегментов и диск в согласии: строки без файлов удаляет, файлы
    без строк заносит, брошенные обрывом питания строки закрывает.

    Первый проход идёт сразу при старте — именно он поднимает в индекс всё, что
    записано до его появления, и подбирает хвост, оборванный выключением.
    """

    def __init__(self):
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self):
        logger.info(
            "Starting index reconciler: db=%s, interval=%ss",
            settings.ARCHIVE_DB_PATH, settings.RECONCILE_INTERVAL_SEC,
        )
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        self._stop.set()
        if self._task:
            await self._task

    async def _run(self):
        while not self._stop.is_set():
            try:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, index.reconcile)
            except Exception:
                logger.exception("Reconcile iteration failed")

            try:
                await asyncio.wait_for(
                    self._stop.wait(),
                    timeout=settings.RECONCILE_INTERVAL_SEC,
                )
            except asyncio.TimeoutError:
                pass


reconciler = IndexReconciler()
