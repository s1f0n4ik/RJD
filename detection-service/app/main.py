import asyncio
import json
import logging
import urllib.request
from contextlib import asynccontextmanager

import grpc
from fastapi import FastAPI

import detection_ingress_pb2_grpc as rpc
from app.api import router as journal_router
from app.config import settings
from app.gateway import link
from app.jobs import jobs
from app.master import journal, master, run, worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

MAX_MESSAGE_BYTES = 64 * 1024 * 1024
# Пинги сервера: пропавшее без закрытия соединения устройство отваливается само
GRPC_OPTIONS = [
    ("grpc.max_receive_message_length", MAX_MESSAGE_BYTES),
    ("grpc.keepalive_time_ms", 10000),
    ("grpc.keepalive_timeout_ms", 5000),
    ("grpc.keepalive_permit_without_calls", 1),
    ("grpc.http2.max_pings_without_data", 0),
]


class Ingress(rpc.DetectionIngressServicer):
    async def Stream(self, request_iterator, context):
        device_id = None
        try:
            async for message in request_iterator:
                sender, ack = await run(master.handle, message)
                if device_id is None:
                    device_id = sender
                    await run(master.stream_opened, device_id, context.peer())
                yield ack
        finally:
            if device_id is not None:
                worker.submit(master.stream_closed, device_id)


def fetch_active() -> str:
    with urllib.request.urlopen(f"{settings.GATEWAY_URL}/integrations", timeout=3) as response:
        return json.load(response)["active"]


async def poll_gateway():
    reachable = True
    while True:
        try:
            active = await asyncio.get_running_loop().run_in_executor(None, fetch_active)
            if not reachable:
                logger.info("gateway reachable again")
            reachable = True
            if active:
                await run(master.set_active, active)
        except Exception as e:
            if reachable:
                logger.warning("gateway %s unavailable, keeping last known configuration: %s", settings.GATEWAY_URL, e)
            reachable = False
        await asyncio.sleep(settings.GATEWAY_POLL_SEC)


async def every(seconds: float, fn):
    while True:
        try:
            await run(fn)
        except Exception:
            logger.exception("%s failed", fn.__name__)
        await asyncio.sleep(seconds)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await run(journal.open)
    await run(master.start)

    # gRPC живёт в том же цикле событий, что и HTTP
    server = grpc.aio.server(options=GRPC_OPTIONS)
    rpc.add_DetectionIngressServicer_to_server(Ingress(), server)
    server.add_insecure_port(f"0.0.0.0:{settings.GRPC_PORT}")
    await server.start()
    logger.info("gRPC listening on port %s", settings.GRPC_PORT)
    await jobs.start()

    tasks = [
        asyncio.create_task(every(0.5, master.tick)),
        asyncio.create_task(every(settings.CLEANUP_INTERVAL_SEC, journal.cleanup)),
        asyncio.create_task(poll_gateway()),
        asyncio.create_task(link.run()),
    ]
    yield
    await server.stop(grace=2)
    for task in tasks:
        task.cancel()
    await jobs.stop()
    await run(journal.close)
    logger.info("stopped")


app = FastAPI(title=settings.APP_NAME, lifespan=lifespan)
app.include_router(journal_router)


@app.get("/health", tags=["Health"])
async def health():
    """Живость сервиса для healthcheck контейнера."""
    return {"status": "ok", "service": settings.APP_NAME}
