import asyncio
import os
import sys
import tempfile
from pathlib import Path

os.environ["DEBUG"] = "false"
os.environ["DEVICES_FILE"] = str(Path(tempfile.mkdtemp()) / "devices.json")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

from app.services import websocket_manager as module
from app.services.devices import registry


class Network:
    # Две платы и шлюз по протоколу мастера; down — плата молчит
    def __init__(self):
        self.down: set[str] = set()
        self.rx = 1000

    def handle(self, request: httpx.Request) -> httpx.Response:
        host, path = request.url.host, request.url.path
        if host in self.down:
            raise httpx.ConnectError("board offline", request=request)
        if host == "127.0.0.1" and path == "/status":
            return httpx.Response(200, json={"modules": [{"connection": {"connected": True}}, {"connection": {"connected": False}}]})
        if path == "/system/info":
            net = [{"iface": "eth0", "rx_bytes": self.rx, "tx_bytes": self.rx}]
            return httpx.Response(200, json={"data": {"modules": ["neural", "birdview"], "network": net}})
        if path == "/camera":
            return httpx.Response(200, json={"data": {"cameras": {f"cam-{host}": {"streams": {"stream_1": {"status": 3}}}}}})
        if path == "/neural/summary":
            return httpx.Response(200, json={"data": {"slots": 2, "running": 2, "failed": 0}})
        if path == "/linker/status":
            return httpx.Response(200, json={"data": {"running": True, "view_mode": "surround", "dual_output": False}})
        return httpx.Response(404)


class Socket:
    def __init__(self):
        self.sent: list[dict] = []

    async def send_json(self, message: dict):
        self.sent.append(message)


async def main():
    network = Network()
    registry._client = httpx.AsyncClient(transport=httpx.MockTransport(network.handle))
    for device_id, ip in (("a", "10.0.0.1"), ("b", "10.0.0.2")):
        registry._devices[device_id] = {"id": device_id, "ip": ip, "name": device_id, "modules": ["neural", "birdview"]}
    registry._routing["birdview"] = "a"

    async def poll():
        await asyncio.gather(*(registry._poll_device(d) for d in list(registry._devices.values())))

    await poll()
    network.rx += 5000
    await poll()

    manager = module.ConnectionManager()
    state = await manager.collect_state()
    assert set(state["cameras"]) == {"cam-10.0.0.1", "cam-10.0.0.2"}, state["cameras"].keys()
    assert not any(c.get("offline") for c in state["cameras"].values())
    assert [d["status"] for d in state["devices"]] == ["online", "online"]
    assert state["devices"][0]["net_rx_bps"] is not None
    assert state["neural"]["running"] == 4 and state["neural"]["ok"] == 2, state["neural"]
    assert state["gateway"] == {"modules": 2, "connected": 1}, state["gateway"]
    assert state["linker"] == {"running": True, "view_mode": "surround", "dual_output": False}, state["linker"]
    assert state["routing"]["birdview"] == "a"

    # Одиночный сбой платы: ещё в сети, камеры из кэша без пометки offline
    network.down.add("10.0.0.2")
    await poll()
    state = await manager.collect_state()
    assert state["devices"][1]["status"] == "online"
    assert not state["cameras"]["cam-10.0.0.2"].get("offline")

    # Второй сбой подряд: не в сети, камеры помечены, скорость сети сброшена
    await poll()
    state = await manager.collect_state()
    assert state["devices"][1]["status"] == "offline"
    assert state["devices"][1]["net_rx_bps"] is None and state["devices"][1]["net_tx_bps"] is None
    assert state["cameras"]["cam-10.0.0.2"]["offline"] is True
    assert not state["cameras"]["cam-10.0.0.1"].get("offline")
    payload = module._build_state_payload(state, "status_update")
    assert payload["data"]["summary"] == {"cameras_total": 2, "cameras_running": 1}, payload["data"]["summary"]

    # Возвращение платы: первая скорость после простоя не усредняется по нему
    network.down.clear()
    await poll()
    state = await manager.collect_state()
    assert state["devices"][1]["status"] == "online"
    assert state["devices"][1]["net_rx_bps"] is None
    assert not state["cameras"]["cam-10.0.0.2"].get("offline")

    # Без изменений уходит пульс, при изменении полное состояние
    socket = Socket()
    manager.active_connections.append(socket)
    await manager.broadcast_status_update()
    await manager.broadcast_status_update()
    network.down.add("10.0.0.1")
    await poll()
    await poll()
    await manager.broadcast_status_update()
    kinds = [m["type"] for m in socket.sent]
    assert kinds == ["status_update", "pulse", "status_update"], kinds
    assert all(isinstance(m["ts"], float) for m in socket.sent)

    await registry.close()
    print("state-feed-check: ok")


asyncio.run(main())
