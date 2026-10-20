import asyncio
import logging

from app.config import settings
from app.services.segments import index

logger = logging.getLogger(__name__)

# Быстрый проход по открытым и несверенным строкам, с
LIVE_CHECK_INTERVAL_SEC = 10


class IndexReconciler:
    """
    Держит индекс сегментов и диск в согласии: строки без файлов удаляет, файлы
    без строк заносит, брошенные обрывом питания строки закрывает.

    Первый проход идёт сразу при старте — именно он поднимает в индекс всё, что
    записано до его появления, и подбирает хвост, оборванный выключением.
    """

    def __init__(self):
        self._tasks: list[asyncio.Task] = []
        self._stop = asyncio.Event()

    async def start(self):
        logger.info(
            "Starting index reconciler: db=%s, interval=%ss, live check=%ss",
            settings.ARCHIVE_DB_PATH, settings.RECONCILE_INTERVAL_SEC, LIVE_CHECK_INTERVAL_SEC,
        )
        self._tasks = [
            asyncio.create_task(self._run(index.reconcile, settings.RECONCILE_INTERVAL_SEC, "Reconcile")),
            asyncio.create_task(self._run(index.check_live, LIVE_CHECK_INTERVAL_SEC, "Live check")),
        ]

    async def stop(self):
        self._stop.set()
        for task in self._tasks:
            await task

    async def _run(self, step, interval: int, name: str):
        while not self._stop.is_set():
            try:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, step)
            except Exception:
                logger.exception("%s iteration failed", name)

            try:
                await asyncio.wait_for(self._stop.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass


reconciler = IndexReconciler()
