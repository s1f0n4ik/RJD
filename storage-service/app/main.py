import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import settings
from app.routers import recordings, journal, archive
from app.services.cleaner import cleaner
from app.services.journal_cleaner import journal_cleaner
from app.services.reconciler import reconciler

logging.basicConfig(
    level=logging.DEBUG if settings.DEBUG else logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting %s", settings.APP_NAME)
    await cleaner.start()
    await journal_cleaner.start()
    await reconciler.start()
    yield
    logger.info("Stopping background services")
    await cleaner.stop()
    await journal_cleaner.stop()
    await reconciler.stop()


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    lifespan=lifespan,
)

app.include_router(recordings.router, prefix="/api", tags=["Recordings"])
app.include_router(journal.router, prefix="/api", tags=["Journal"])
app.include_router(archive.router, prefix="/api", tags=["Archive"])


@app.get("/", tags=["Health"])
async def root():
    return {"status": "ok", "service": settings.APP_NAME}