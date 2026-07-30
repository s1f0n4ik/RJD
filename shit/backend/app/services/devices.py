"""Реестр устройств (media-center'ов) и их фоновый опрос.

Устройство — одноплатник с media-center на порту 7777; его паспорт и
телеметрию отдаёт ручка GET /system/info. Реестр хранится в devices.json
на bind-mount томе и переживает пересборку контейнеров.
"""

import asyncio
import ipaddress
import json
import logging
import socket
import time
from pathlib import Path
from typing import Any, Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# Соответствие ECameraType (C++) → слот таблицы маршрутизации.
# VIRTUAL (4) не маршрутизируется: виртуальные потоки создают сами модули.
CAMERA_TYPE_GENERAL = 1
CAMERA_TYPE_NEURAL = 2
CAMERA_TYPE_BIRDVIEW = 3

EMPTY_ROUTING: dict[str, Any] = {
    "birdview": None,
    "neural": None,
    "camera_types": {},
}


class DeviceRegistry:
    """Список известных устройств + runtime-состояние (телеметрия, кэш камер)."""

    def __init__(self, path: str):
        self._path = Path(path)
        self._lock = asyncio.Lock()
        self._devices: dict[str, dict] = {}
        self._routing: dict[str, Any] = json.loads(json.dumps(EMPTY_ROUTING))
        # Runtime-состояние не сохраняется на диск
        self._state: dict[str, dict] = {}
        self._poll_task: Optional[asyncio.Task] = None
        self._client: Optional[httpx.AsyncClient] = None
        self._load()

    # ── Персистентность ──

    def _load(self) -> None:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            self._devices = {d["id"]: d for d in raw.get("devices", [])}
            self._routing = {**json.loads(json.dumps(EMPTY_ROUTING)), **raw.get("routing", {})}
            logger.info(f"Loaded {len(self._devices)} devices from {self._path}")
        except FileNotFoundError:
            logger.info(f"No devices file at {self._path}, starting empty")
        except Exception as e:
            logger.error(f"Failed to load {self._path}: {e}")

    def _save(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"devices": list(self._devices.values()), "routing": self._routing}
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self._path)
        except Exception as e:
            logger.error(f"Failed to save {self._path}: {e}")

    # ── HTTP-клиент ──

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0))
        return self._client

    async def close(self) -> None:
        if self._poll_task:
            self._poll_task.cancel()
        if self._client:
            await self._client.aclose()

    # ── CRUD устройств ──

    def get(self, device_id: str) -> Optional[dict]:
        return self._devices.get(device_id)

    async def add(self, device_id: str, ip: str, name: str, modules: list[str]) -> dict:
        async with self._lock:
            device = {"id": device_id, "ip": ip, "name": name, "modules": modules}
            self._devices[device_id] = device
            self._autofill_routing(device)
            self._save()
        # Первый опрос сразу, чтобы UI не ждал цикла поллера
        await self._poll_device(device)
        return device

    async def rename(self, device_id: str, name: str) -> Optional[dict]:
        async with self._lock:
            device = self._devices.get(device_id)
            if not device:
                return None
            device["name"] = name
            self._save()
            return device

    async def remove(self, device_id: str) -> bool:
        async with self._lock:
            if device_id not in self._devices:
                return False
            del self._devices[device_id]
            self._state.pop(device_id, None)
            # Ссылки маршрутов на удалённое устройство очищаются
            if self._routing.get("birdview") == device_id:
                self._routing["birdview"] = None
            if self._routing.get("neural") == device_id:
                self._routing["neural"] = None
            self._routing["camera_types"] = {
                k: v for k, v in self._routing.get("camera_types", {}).items() if v != device_id
            }
            self._save()
            return True

    # ── Таблица маршрутизации ──

    def get_routing(self) -> dict:
        return self._routing

    async def set_routing(self, routing: dict) -> dict:
        async with self._lock:
            self._routing = {
                "birdview": routing.get("birdview"),
                "neural": routing.get("neural"),
                "camera_types": {str(k): v for k, v in (routing.get("camera_types") or {}).items()},
            }
            self._save()
            return self._routing

    def _autofill_routing(self, device: dict) -> None:
        """Пустые слоты заполняются по модулям устройства; занятые не трогаем."""
        modules = device.get("modules", [])
        types = self._routing.setdefault("camera_types", {})

        if "birdview" in modules:
            if not self._routing.get("birdview"):
                self._routing["birdview"] = device["id"]
            types.setdefault(str(CAMERA_TYPE_BIRDVIEW), device["id"])
        if "neural" in modules:
            if not self._routing.get("neural"):
                self._routing["neural"] = device["id"]
            types.setdefault(str(CAMERA_TYPE_NEURAL), device["id"])
        # Обычные камеры — на устройство без тяжёлых модулей
        if not modules:
            types.setdefault(str(CAMERA_TYPE_GENERAL), device["id"])

    def device_for_module(self, module: str) -> Optional[dict]:
        device_id = self._routing.get(module)
        return self._devices.get(device_id) if device_id else None

    # ── Snapshot для UI ──

    def snapshot(self) -> list[dict]:
        result = []
        for device in self._devices.values():
            state = self._state.get(device["id"], {})
            result.append({
                **device,
                "status": state.get("status", "unknown"),
                "last_seen": state.get("last_seen"),
                "telemetry": state.get("telemetry"),
                "ping_ms": state.get("ping_ms"),
                "net_rx_bps": state.get("net_rx_bps"),
                "net_tx_bps": state.get("net_tx_bps"),
            })
        return result

    def cached_camera_data(self, device_id: str) -> dict:
        """Форма как у GET /camera: {"cameras": {id: {...}}, "virtual": [...]}."""
        return self._state.get(device_id, {}).get("camera_data", {})

    # ── Фоновый опрос ──

    def start_polling(self) -> None:
        if not self._poll_task:
            self._poll_task = asyncio.create_task(self._poll_loop())

    async def _poll_loop(self) -> None:
        while True:
            try:
                devices = list(self._devices.values())
                if devices:
                    await asyncio.gather(*(self._poll_device(d) for d in devices))
            except Exception as e:
                logger.error(f"Device poll loop error: {e}")
            await asyncio.sleep(settings.DEVICE_POLL_INTERVAL)

    async def _poll_device(self, device: dict) -> None:
        state = self._state.setdefault(device["id"], {})
        base = f"http://{device['ip']}:{settings.DEVICE_MC_PORT}"
        try:
            started = time.monotonic()
            response = await self.client.get(f"{base}/system/info")
            response.raise_for_status()
            info = response.json().get("data", {})

            state["status"] = "online"
            state["last_seen"] = time.time()
            state["telemetry"] = info
            # Пинг — RTT опроса ручки: отражает доступность именно сервиса
            state["ping_ms"] = round((time.monotonic() - started) * 1000, 1)
            self._update_net_rates(state, info)

            # Набор модулей мог смениться при перезапуске media-center
            modules = info.get("modules")
            if isinstance(modules, list) and modules != device.get("modules"):
                device["modules"] = modules
                self._save()

            await self._refresh_cameras(device, base)
        except Exception:
            state["status"] = "offline"

    @staticmethod
    def _update_net_rates(state: dict, info: dict) -> None:
        """Скорость сети по дельте кумулятивных счётчиков между опросами."""
        rx = sum(i.get("rx_bytes", 0) for i in info.get("network", []))
        tx = sum(i.get("tx_bytes", 0) for i in info.get("network", []))
        now = time.monotonic()

        prev = state.get("_net_prev")
        if prev:
            dt = now - prev["t"]
            # Счётчики сбрасываются при ребуте устройства — отрицательные дельты глушим
            if dt > 0 and rx >= prev["rx"] and tx >= prev["tx"]:
                state["net_rx_bps"] = round((rx - prev["rx"]) / dt)
                state["net_tx_bps"] = round((tx - prev["tx"]) / dt)
        state["_net_prev"] = {"t": now, "rx": rx, "tx": tx}

    async def _refresh_cameras(self, device: dict, base: str) -> None:
        """Кэш камер: отдаётся для offline-устройств и как fallback агрегации."""
        try:
            response = await self.client.get(f"{base}/camera")
            response.raise_for_status()
            data = response.json().get("data")
            if isinstance(data, dict):
                self._state[device["id"]]["camera_data"] = data
        except Exception as e:
            logger.debug(f"Camera cache refresh failed for {device['id']}: {e}")

    # ── Discovery ──

    async def scan(self) -> list[dict]:
        """TCP-обход /24 подсетей мастера по порту media-center."""
        candidates = _local_subnet_hosts()
        found_ips: list[str] = []

        semaphore = asyncio.Semaphore(64)

        async def probe(ip: str) -> None:
            async with semaphore:
                try:
                    _, writer = await asyncio.wait_for(
                        asyncio.open_connection(ip, settings.DEVICE_MC_PORT), timeout=0.5
                    )
                    writer.close()
                    found_ips.append(ip)
                except Exception:
                    pass

        await asyncio.gather(*(probe(ip) for ip in candidates))

        results = []
        for ip in found_ips:
            try:
                response = await self.client.get(
                    f"http://{ip}:{settings.DEVICE_MC_PORT}/system/info"
                )
                response.raise_for_status()
                info = response.json().get("data", {})
                device_id = info.get("device_id")
                if not device_id:
                    continue

                known = self._devices.get(device_id)
                # Смена IP по DHCP: известное устройство нашлось по новому адресу
                if known and known["ip"] != ip:
                    async with self._lock:
                        known["ip"] = ip
                        self._save()

                results.append({
                    "id": device_id,
                    "ip": ip,
                    "hostname": info.get("hostname"),
                    "version": info.get("version"),
                    "modules": info.get("modules", []),
                    "platform": info.get("platform"),
                    "known": known is not None,
                })
            except Exception as e:
                logger.debug(f"Probe of {ip} failed: {e}")

        return results


def _local_subnet_hosts() -> list[str]:
    """Адреса /24 вокруг всех локальных IP мастера."""
    local_ips: set[str] = set()

    # UDP-connect не шлёт пакетов — работает и в закрытом контуре
    for target in ("10.255.255.255", "192.168.255.255", "172.31.255.255"):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((target, 1))
            local_ips.add(s.getsockname()[0])
            s.close()
        except Exception:
            pass

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            local_ips.add(info[4][0])
    except Exception:
        pass

    if settings.DEVICE_SCAN_SUBNETS:
        subnets = [s.strip() for s in settings.DEVICE_SCAN_SUBNETS.split(",") if s.strip()]
    else:
        subnets = [
            str(ipaddress.ip_network(f"{ip}/24", strict=False))
            for ip in local_ips
            if not ip.startswith("127.")
        ]

    hosts: list[str] = []
    for subnet in set(subnets):
        try:
            hosts.extend(str(h) for h in ipaddress.ip_network(subnet).hosts())
        except ValueError:
            logger.warning(f"Invalid scan subnet: {subnet}")

    # Локальный минион на той же машине слушает и на собственных IP мастера
    hosts.extend(ip for ip in local_ips if not ip.startswith("127."))
    return list(dict.fromkeys(hosts))


registry = DeviceRegistry(settings.DEVICES_FILE)
