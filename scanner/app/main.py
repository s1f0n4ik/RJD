"""
app/main.py — Camera Scanner Service

Отдельный микросервис для поиска ONVIF-камер в сети.
Порт 8002. Проксируется через nginx как /api/scan/*.
"""

import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import scan

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Camera Scanner Service",
    version="1.0.0",
    description="ONVIF WS-Discovery сканер камер в локальной сети",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(scan.router, prefix="/scan", tags=["Scan"])


@app.get("/health", tags=["Health"])
async def health():
    return {"status": "ok", "service": "camera-scanner"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8002, log_level="info")