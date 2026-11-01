import asyncio
import copy
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
temporary = tempfile.TemporaryDirectory(prefix="service-lifecycle-check-")
os.environ["CONFIG_DB"] = str(Path(temporary.name) / "config.db")
os.environ["CONFIG_ASSETS_DIR"] = str(Path(temporary.name) / "assets")
os.environ["DEBUG"] = "false"

import grpc
import detection_ingress_pb2 as pb
import detection_ingress_pb2_grpc as rpc
from app.config import settings
from app.services.config_store import get_store
from app.services.lifecycle import ProfileLifecycle
from app.routers.configurations import gateway_status


async def main():
    store = get_store()
    entities = {("integration", "rsm-2000"): {"modules": {"websocket": {"enabled": False}, "can": {"enabled": False}}},
                ("integration", "iskra"): {"modules": {"modbus": {"enabled": False}}},
                ("rules", "rsm-2000"): {"table": {"cameras": {"front": 1}}},
                ("rules", "iskra"): {"stitch": {"gap_s": 0}, "table": {"cameras": [{"bit": 1, "name": "front", "camera_id": "front"}]}}}
    for name in ("rsm-2000", "iskra"):
        store.create_version(name, name, {**copy.deepcopy(entities), ("machine", "settings"): {"active_integration": name}})
    broken = {**copy.deepcopy(entities), ("machine", "settings"): {"active_integration": "iskra"}}
    broken[("rules", "iskra")]["stitch"]["gap_s"] = -1
    store.create_version("broken", "broken", broken)
    lifecycle = ProfileLifecycle()
    client = lifecycle.client
    gateway = settings.GATEWAY_URL.rstrip("/")
    detection = settings.DETECTION_URL.rstrip("/")
    channel = grpc.aio.insecure_channel(os.environ["DETECTION_GRPC"])
    ingress = rpc.DetectionIngressStub(channel)
    device_id = Path(temporary.name).name
    session = int(time.time() * 1000)

    async def get(base, path):
        response = await client.get(base + path)
        response.raise_for_status()
        return response.json().get("data", response.json())

    async def switch(profile):
        await lifecycle.switch(profile)
        await lifecycle.advance()
        assert lifecycle.status()["phase"] == "complete", lifecycle.status()
        for base in (gateway, detection):
            state = await get(base, "/runtime")
            assert state["state"] == "running" and state["transition_id"] == lifecycle.status()["id"]

    async def send(number, track, event):
        async def messages():
            yield pb.DeviceMessage(packet=pb.Packet(id=number, device_id=device_id, session=session, config_id="model",
                camera_id="front", ts=int(time.time() * 1000), tracks=[pb.TrackRecord(track_id=track, event=event,
                state=pb.TRACK_STATE_CONFIRMED, class_id=0, class_name="person", box=[0, 0, 20, 20])]))
        replies = [reply async for reply in ingress.Stream(messages())]
        assert list(replies[0].packet_ids) == [number]

    async def wait_queue(count):
        for _ in range(30):
            status = await get(gateway, "/status")
            if status["modules"][0]["queue"]["total"] == count:
                return
            await asyncio.sleep(0.1)
        raise AssertionError(status)

    await switch("iskra")
    baseline = (await get(gateway, "/status"))["modules"][0]["queue"]["total"]
    await switch("rsm-2000")
    await send(1, 1, pb.TRACK_EVENT_CONFIRMED)
    for _ in range(20):
        status = await get(gateway, "/status")
        if status["modules"][1]["payload"]["count"] == 1:
            break
        await asyncio.sleep(0.1)
    assert status["modules"][1]["payload"]["count"] == 1
    await switch("iskra")
    count = (await get(gateway, "/status"))["modules"][0]["queue"]["total"]
    assert count == baseline
    await send(2, 2, pb.TRACK_EVENT_CONFIRMED)
    await send(3, 2, pb.TRACK_EVENT_REMOVED)
    await wait_queue(count + 1)
    await switch("rsm-2000")
    assert (await get(gateway, "/status"))["modules"][1]["payload"]["count"] == 0
    await switch("iskra")
    await wait_queue(count + 1)
    journal = await get(detection, "/api/journal/detections?device_id=" + device_id)
    assert len(journal["detections"]) == 2, journal
    assert all(item["ended_at"] is not None for item in journal["detections"])
    before = await get(gateway, "/runtime")
    inactive = await get(gateway, "/integrations/rsm-2000/status")
    assert inactive["id"] == "rsm-2000" and not any(module["connection"]["connected"] for module in inactive["modules"])
    assert await get(gateway, "/runtime") == before
    failed = await lifecycle.switch("broken")
    await lifecycle.advance()
    assert lifecycle.status()["phase"] == "loading" and lifecycle.status()["error"]
    assert "stitch.gap_s" in lifecycle.status()["error"]
    assert lifecycle.status()["previous_profile_id"] == "iskra"
    for base in (gateway, detection):
        assert (await get(base, "/runtime"))["state"] == "stopped"
    returned = await lifecycle.retry(failed["id"], "iskra")
    assert returned["id"] != failed["id"]
    await lifecycle.advance()
    assert lifecycle.status()["phase"] == "complete" and store.active_profile() == "iskra"
    failed = await lifecycle.switch("broken")
    await lifecycle.advance()
    assert lifecycle.status()["phase"] == "loading" and lifecycle.status()["error"]
    repair = await lifecycle.repair(failed["id"])
    await lifecycle.advance()
    assert lifecycle.status()["phase"] == "repairing"
    store.put("broken", "machine", "settings", {"active_integration": "rsm-2000"})
    source = copy.deepcopy(entities[("integration", "rsm-2000")])
    source["modules"]["websocket"].update(host="draft-host", enabled=True)
    store.put("broken", "integration", "rsm-2000", source)
    preview = await gateway_status()
    assert preview["repairing"] and preview["id"] == "rsm-2000"
    assert preview["modules"][0]["connection"]["host"] == "draft-host" and not preview["modules"][0]["connection"]["connected"]
    assert (await get(gateway, "/status"))["id"] == "iskra"
    assert (await get(gateway, "/runtime"))["state"] == "stopped"
    store.reset("broken", "machine", "settings")
    store.reset("broken", "integration", "rsm-2000")
    store.put("broken", "rules", "iskra", copy.deepcopy(entities[("rules", "iskra")]))
    await lifecycle.close()
    lifecycle = ProfileLifecycle()
    client = lifecycle.client
    await lifecycle.advance()
    assert lifecycle.status()["phase"] == "repairing"
    for base in (gateway, detection):
        runtime = await get(base, "/runtime")
        assert runtime["state"] == "stopped" and runtime["transition_id"] == repair["id"]
    repeated = await lifecycle.retry(repair["id"])
    assert repeated["id"] not in (failed["id"], repair["id"])
    await lifecycle.advance()
    assert lifecycle.status()["phase"] == "complete" and store.active_profile() == "broken"
    await wait_queue(count + 1)
    await channel.close()
    await lifecycle.close()
    store.close()
    print("services-check: OK")


asyncio.run(main())
