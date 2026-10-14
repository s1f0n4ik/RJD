import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import settings
from app.routers import recordings, archive, pool as pool_router
from app.services import exports
from app.services.cleaner import cleaner
from app.services.jobs import jobs
from app.services.journal import journal
from app.services.reconciler import reconciler
from app.services.volumes import pool

logging.basicConfig(
    level=logging.DEBUG if settings.DEBUG else logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting %s", settings.APP_NAME)
    # После перезапуска задач нет, а их результаты на диске — есть
    exports.sweep()
    journal.move_legacy()
    await pool.start()
    await jobs.start()
    await cleaner.start()
    await reconciler.start()
    yield
    logger.info("Stopping background services")
    await jobs.stop()
    await cleaner.stop()
    await reconciler.stop()
    await pool.stop()


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    lifespan=lifespan,
)

app.include_router(recordings.router, prefix="/api", tags=["Recordings"])
app.include_router(archive.router, prefix="/api", tags=["Archive"])
app.include_router(pool_router.router, prefix="/api", tags=["Storage pool"])


@app.get("/", tags=["Health"])
async def root():
    return {"status": "ok", "service": settings.APP_NAME}