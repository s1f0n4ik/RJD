#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys

import grpc
import httpx
import peripherals_pb2 as pb
import peripherals_pb2_grpc as rpc

HTTP = os.environ.get("PERIPHERALS_HTTP", "http://127.0.0.1:8006")
GRPC = os.environ.get("PERIPHERALS_GRPC", "127.0.0.1:50053")


async def main() -> None:
    package = {
        "active": "kgf",
        "devices": {
            "test-board": {
                "kind": "descriptor",
                "name": "Проверочное устройство",
                "channels": [{"id": "temperature", "name": "Температура", "unit": "°C", "type": "number", "frequency_hz": 1}],
            }
        },
    }
    revision = hashlib.sha256(json.dumps(package, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    transition = "lifecycle-check"
    async with httpx.AsyncClient(base_url=HTTP, timeout=5) as client:
        current = (await client.get("/runtime")).json()
        stopped = (await client.put("/runtime", json={
            "action": "stop",
            "transition_id": transition,
            "previous_transition_id": current["transition_id"],
            "modules": ["peripherals"],
            "revision": revision,
        })).json()
        assert stopped["state"] == "stopped", stopped
        loaded = (await client.put("/config", json={**package, "transition_id": transition, "revision": revision})).json()
        assert loaded["revision"] == revision, loaded
        started = (await client.put("/runtime", json={
            "action": "start", "transition_id": transition, "modules": ["peripherals"], "revision": revision,
        })).json()
        assert started["state"] == "running", started

    async with grpc.aio.insecure_channel(GRPC) as channel:
        reply = await rpc.PeripheralsStub(channel).Describe(pb.DescribeRequest(), timeout=5)
        assert [device.id for device in reply.devices] == ["test-board"], reply

    print("peripherals lifecycle: OK")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        print(f"peripherals lifecycle: FAILED: {error}", file=sys.stderr)
        raise
