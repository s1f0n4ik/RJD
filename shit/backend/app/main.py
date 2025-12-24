from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
import logging

from app.config import settings
from app.routers import cameras, loaders, status, streams
from app.services.websocket_manager import manager, websocket_endpoint

# Настройка логирования
logging.basicConfig(
    level=logging.DEBUG if settings.DEBUG else logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifecycle events"""
    logger.info(f"🚀 Starting {settings.APP_NAME}")

    # Startup: запуск WebSocket broadcast
    await manager.start_broadcast()

    yield

    # Shutdown: остановка WebSocket broadcast
    await manager.stop_broadcast()
    logger.info("👋 Application shutdown complete")


# Создание FastAPI приложения
app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="API для управления RTSP камерами и нейронными загрузчиками",
    lifespan=lifespan
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Подключение роутеров
app.include_router(cameras.router, prefix="/api", tags=["Cameras"])
app.include_router(loaders.router, prefix="/api", tags=["Loaders"])
app.include_router(status.router, prefix="/api", tags=["Status"])
app.include_router(streams.router, tags=["Streams"])

# WebSocket endpoint
app.add_websocket_route("/ws", websocket_endpoint)


# Health check
@app.get("/", tags=["Health"])
async def root():
    """Health check endpoint"""
    return {
        "status": "ok",
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION
    }


@app.get("/health", tags=["Health"])
async def health_check():
    """Detailed health check"""
    from app.services.flask_client import check_flask_health

    flask_status = await check_flask_health()

    return {
        "status": "ok",
        "services": {
            "fastapi": "ok",
            "flask": "ok" if flask_status else "unavailable"
        },
        "websocket": {
            "active_connections": len(manager.active_connections)
        }
    }


# Global exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    logger.error(f"Global exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Internal server error",
            "error": str(exc) if settings.DEBUG else "An error occurred"
        }
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.DEBUG,
        log_level="debug" if settings.DEBUG else "info"
    )