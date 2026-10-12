import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import grpc

import frame_ingress_pb2_grpc as gw_rpc
from app.config import settings
from app.journal import now_ms
from app.master import Outgoing, master, run, worker
from app.overlay import Box, render

logger = logging.getLogger(__name__)

MAX_MESSAGE_BYTES = 64 * 1024 * 1024
MAX_QUEUE = 1000
CHANNEL_OPTIONS = [
    ("grpc.max_send_message_length", MAX_MESSAGE_BYTES),
    ("grpc.max_receive_message_length", MAX_MESSAGE_BYTES),
    ("grpc.initial_reconnect_backoff_ms", 1000),
    ("grpc.min_reconnect_backoff_ms", 1000),
    ("grpc.max_reconnect_backoff_ms", 2000),
]

# Рамки и плашка кадра КАУС рисуются мимо потока журнала
draw_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="overlay")


class GatewayLink:
    # Поток StreamFrames в шлюз: без связи сообщения выбрасываются, после подключения открытые досылаются
    def __init__(self):
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.queue: Optional[asyncio.Queue] = None
        self.seq = 0
        # Состояние звена для экрана конфигураций
        self.connected_at: Optional[int] = None
        self.lost_at: Optional[int] = now_ms()
        self.rejected = 0

    # Из любого потока
    def submit(self, message: Outgoing) -> None:
        if self.queue is None or self.loop is None:
            master.feed.dropped(message.entry)
            return
        if message.jpeg is None and message.path is None:
            self.loop.call_soon_threadsafe(self._put, message)
        else:
            draw_pool.submit(self._draw, message)

    def _draw(self, message: Outgoing) -> None:
        request = message.request
        try:
            boxes = [Box(*d.box, f"{d.cls} {d.cf:.2f}") for d in request.dets if len(d.box) == 4]
            request.image = render(message.jpeg if message.jpeg is not None else message.path, boxes, request.ts, message.gps)
            request.format = "jpeg"
        except Exception:
            logger.exception("frame for detection(s) %s not drawn", [d.detection_id for d in request.dets])
            master.feed.dropped(message.entry)
            return
        self.loop.call_soon_threadsafe(self._put, message)

    def _put(self, message: Outgoing) -> None:
        queue = self.queue
        request = message.request
        if queue is None:
            master.feed.dropped(message.entry)
            return
        if queue.full():
            logger.warning("gateway queue full, message for detection(s) %s dropped", [d.detection_id for d in request.dets])
            master.feed.dropped(message.entry)
            return
        self.seq += 1
        request.id = self.seq
        master.feed.queued(message.entry, request.id)
        queue.put_nowait(request)

    @staticmethod
    async def _requests(queue: asyncio.Queue):
        while True:
            yield await queue.get()

    def state(self) -> dict:
        return {
            "connected": self.queue is not None,
            "connected_at": self.connected_at,
            "lost_at": self.lost_at,
            "queue": self.queue.qsize() if self.queue is not None else 0,
            "queue_max": MAX_QUEUE,
            "rejected": self.rejected,
            "address": settings.GATEWAY_GRPC,
        }

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        connected = False
        while True:
            try:
                async with grpc.aio.insecure_channel(settings.GATEWAY_GRPC, options=CHANNEL_OPTIONS) as channel:
                    await channel.channel_ready()
                    queue = asyncio.Queue(MAX_QUEUE)
                    self.queue = queue
                    self.connected_at, self.lost_at = now_ms(), None
                    resent = await run(master.resend_open)
                    logger.info("gateway %s connected, session %d, %d open detection(s) resent",
                                settings.GATEWAY_GRPC, master.outbox.session, resent)
                    connected = True
                    call = gw_rpc.FrameIngressStub(channel).StreamFrames(self._requests(queue))
                    async for reply in call:
                        if not reply.accepted:
                            self.rejected += 1
                            logger.warning("gateway rejected message %d: %s", reply.id, reply.error)
                        entry = master.feed.replied(reply.id, reply.accepted)
                        if entry is not None:
                            worker.submit(master.on_reply, entry)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if connected:
                    logger.warning("gateway %s lost: %s", settings.GATEWAY_GRPC,
                                   e.details() if isinstance(e, grpc.aio.AioRpcError) else e)
            if connected:
                self.lost_at, self.connected_at = now_ms(), None
            connected = False
            self.queue = None
            master.feed.lost()
            await asyncio.sleep(settings.GATEWAY_RETRY_SEC)


link = GatewayLink()
master.outbox.send = link.submit
