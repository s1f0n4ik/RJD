from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager, suppress

import frame_ingress_pb2 as gateway_pb
import frame_ingress_pb2_grpc as gateway_rpc
import grpc
import peripherals_pb2 as pb
import peripherals_pb2_grpc as rpc
from fastapi import FastAPI

from app.api import create_router
from app.config import settings
from app.lifecycle import Lifecycle
from app.models import GatewayTime
from app.registry import Registry

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

registry = Registry()
lifecycle = Lifecycle(registry)


def _channel_type(value: str) -> int:
    return {
        "number": pb.CHANNEL_NUMBER,
        "array": pb.CHANNEL_ARRAY,
        "scan": pb.CHANNEL_SCAN,
        "boolean": pb.CHANNEL_BOOLEAN,
    }.get(value, pb.CHANNEL_TYPE_UNSPECIFIED)


class PeripheralsService(rpc.PeripheralsServicer):
    async def Describe(self, request, context):
        reply = pb.DescribeReply()
        for device in registry.describe():
            target = reply.devices.add(id=device.id, kind=device.kind, name=device.name, state=device.state.value)
            target.message = device.message or ""
            for channel in device.channels:
                target.channels.add(
                    id=channel.id,
                    name=channel.name,
                    unit=channel.unit,
                    type=_channel_type(channel.type.value),
                    frequency_hz=channel.frequency_hz,
                )
        return reply

    async def Subscribe(self, request, context):
        selected = set(request.channel_ids)
        async for value in registry.subscribe_values():
            key = f"{value.device_id}/{value.channel_id}"
            if selected and key not in selected:
                continue
            yield pb.ChannelValue(
                device_id=value.device_id,
                channel_id=value.channel_id,
                json_value=json.dumps(value.value, ensure_ascii=False),
                unix_ms=int(value.captured_at.timestamp() * 1000),
                sequence=value.sequence,
            )

    async def Events(self, request, context):
        async for event in registry.subscribe_events():
            yield pb.Event(
                device_id=event.device_id,
                kind=event.kind,
                json_payload=json.dumps(event.payload, ensure_ascii=False),
                unix_ms=int(event.captured_at.timestamp() * 1000),
            )

    async def Status(self, request, context):
        return pb.StatusReply(
            state=lifecycle.state["state"],
            revision=lifecycle.state["revision"],
            devices=len(registry.describe()),
        )


async def poll_gateway() -> None:
    while True:
        try:
            async with grpc.aio.insecure_channel(settings.GATEWAY_GRPC) as channel:
                stub = gateway_rpc.FrameIngressStub(channel)
                response = await stub.GetTime(gateway_pb.TimeRequest(), timeout=3)
                registry.set_gateway_time(GatewayTime(
                    unix_ms=response.unix_ms,
                    lat=response.gps.lat,
                    lon=response.gps.lon,
                    alt=response.gps.alt,
                    gps_valid=response.gps.valid,
                    tz_offset_min=response.tz_offset_min,
                    can_time=response.can_time,
                    ntp_time=response.ntp_time,
                ))
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - недоступный шлюз не останавливает сервис
            logger.debug("gateway time unavailable: %s", error)
        await asyncio.sleep(settings.GATEWAY_POLL_SEC)


@asynccontextmanager
async def lifespan(_: FastAPI):
    server = grpc.aio.server()
    rpc.add_PeripheralsServicer_to_server(PeripheralsService(), server)
    server.add_insecure_port(f"0.0.0.0:{settings.GRPC_PORT}")
    await server.start()
    gateway_task = asyncio.create_task(poll_gateway(), name="gateway-time")
    logger.info("HTTP %s and gRPC %s started", settings.HTTP_PORT, settings.GRPC_PORT)
    try:
        yield
    finally:
        gateway_task.cancel()
        with suppress(asyncio.CancelledError):
            await gateway_task
        await registry.stop()
        await server.stop(grace=2)


app = FastAPI(title="RJD peripherals", version=settings.APP_VERSION, lifespan=lifespan)
app.include_router(create_router(registry, lifecycle))
