from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import logging

from app.config import settings
from app.api import cameras, loaders, status, streams
from app.services.websocket_manager import manager

# Настройка логирования
logging.basicConfig(
    level=logging.DEBUG if settings.DEBUG else logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Управление жизненным циклом приложения"""
    logger.info("🚀 Starting FastAPI server")

    # Запуск WebSocket broadcaster
    manager.start_broadcasting()

    yield

    # Остановка WebSocket broadcaster
    manager.stop_broadcasting()
    logger.info("👋 Shutting down FastAPI server")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    lifespan=lifespan
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Роутеры
app.include_router(cameras.router, prefix="/api", tags=["cameras"])
app.include_router(loaders.router, prefix="/api", tags=["loaders"])
app.include_router(status.router, prefix="/api", tags=["status"])
app.include_router(streams.router, tags=["streams"])

# WebSocket
from app.api.websocket import router as ws_router

app.include_router(ws_router)


@app.get("/")
async def root():
    return {
        "service": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "status": "running"
    }


@app.get("/health")
async def health():
    return {"status": "ok"}