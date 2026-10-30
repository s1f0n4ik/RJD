import asyncio
import logging
import time
from typing import Any, Callable, Optional

import httpx

from app.config import settings
from app.services.config_store import ConfigStore, digest, get_store
from app.services.devices import registry

logger = logging.getLogger(__name__)

def _cameras_part(bodies: dict[str, dict[str, Any]], place: str) -> list[dict]:
    return [
        {k: v for k, v in body.items() if k != "place"}
        for _, body in sorted(bodies.get("camera", {}).items())
        if body.get("place") == place
    ]






# Конфигурации — все, видеопотоки и слоты — своего места




# Части пакета платы по порядку применения: имя → сборщик из тел действующей конфигурации и места
PART_BUILDERS: dict[str, Callable[[dict[str, dict[str, Any]], str], Any]] = {
    "cameras": _cameras_part,
}
# Пауза перед повтором той же ревизии после ошибки
RETRY_AFTER_S = 60.0


def _asset_shas(part: Any) -> set[str]:
    found: set[str] = set()
    if isinstance(part, dict):
        for name, sha in (part.get("_assets") or {}).items():
            if sha:
                found.add(sha)
        for value in part.values():
            found |= _asset_shas(value)
    elif isinstance(part, list):
        for value in part:
            found |= _asset_shas(value)
    return found


def build_packages(store: ConfigStore) -> dict[str, dict]:
    eff = store.effective()
    if not eff["profile"]:
        return {}
    bodies = {kind: {key: e["body"] for key, e in items.items()} for kind, items in eff["entities"].items()}
    packages: dict[str, dict] = {}
    for place, binding in bodies.get("binding", {}).items():
        device_id = (binding or {}).get("device_id")
        if not device_id or place not in bodies.get("place", {}):
            continue
        parts = {name: build(bodies, place) for name, build in PART_BUILDERS.items()}
        parts = {name: part for name, part in parts.items() if part is not None}
        assets = sorted(_asset_shas(parts))
        packages[device_id] = {
            "place": place,
            "package": {"revision": digest({"parts": parts, "assets": assets}), "parts": parts, "assets": assets},
        }
    return packages


class ConfigSync:
    def __init__(self):
        self._status: dict[str, dict] = {}
        self._inflight: set[str] = set()
        self._client: Optional[httpx.AsyncClient] = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=3.0))
        return self._client

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()

    def status(self) -> list[dict]:
        return list(self._status.values())

    def on_polled(self, device: dict, info: dict) -> None:
        try:
            packages = build_packages(get_store())
        except Exception as e:
            logger.error(f"Config package build failed: {e}")
            return
        push = self._prepare(device, packages.get(device["id"]), info.get("config_revision") or "", retry=False)
        if push:
            asyncio.create_task(push)

    async def push_now(self) -> list[dict]:
        packages = build_packages(get_store())
        pushes = []
        for device_id, entry in packages.items():
            device = registry.get(device_id)
            if not device:
                continue
            applied = self._status.get(device_id, {}).get("applied", "")
            push = self._prepare(device, entry, applied, retry=True)
            if push:
                pushes.append(push)
        await asyncio.gather(*pushes)
        return [self._status[d] for d in packages if d in self._status]

    # Отправка сразу после правки; ошибка — только у устройства на связи
    async def push_checked(self) -> Optional[str]:
        for status in await self.push_now():
            device = registry.snapshot_one(status["device_id"]) or {}
            if status.get("state") == "error" and device.get("status") == "online":
                return status.get("error") or "unknown error"
        return None

    def _prepare(self, device: dict, entry: Optional[dict], applied: str, retry: bool):
        if not entry:
            self._status.pop(device["id"], None)
            return None
        expected = entry["package"]["revision"]
        status = self._status.setdefault(device["id"], {"device_id": device["id"]})
        status.update({"place": entry["place"], "expected": expected, "applied": applied})
        if applied == expected:
            status.update({"state": "ok", "error": None})
            return None
        if device["id"] in self._inflight:
            return None
        recent_failure = status.get("failed_revision") == expected and time.time() - status.get("failed_at", 0) < RETRY_AFTER_S
        if recent_failure and not retry:
            return None
        self._inflight.add(device["id"])
        return self._push(device, entry["package"], status)

    async def _push(self, device: dict, package: dict, status: dict) -> None:
        base = f"http://{device['ip']}:{settings.DEVICE_MC_PORT}"
        status.update({"state": "pending", "error": None})
        try:
            response = await self.client.put(f"{base}/config", json=package)
            if response.status_code == 409:
                for sha in response.json().get("missing_assets", []):
                    with open(get_store().asset_path(sha), "rb") as f:
                        upload = await self.client.put(
                            f"{base}/config/assets", params={"sha256": sha}, content=f.read()
                        )
                    upload.raise_for_status()
                response = await self.client.put(f"{base}/config", json=package)
            if response.status_code != 200:
                raise RuntimeError(response.json().get("error") or f"HTTP {response.status_code}")
            status.update({"state": "ok", "applied": package["revision"], "at": time.time()})
            status.pop("failed_revision", None)
            status.pop("failed_at", None)
            logger.info(f"Config {package['revision']} applied on {device['id']}")
        except Exception as e:
            status.update({
                "state": "error", "error": str(e), "at": time.time(),
                "failed_revision": package["revision"], "failed_at": time.time(),
            })
            logger.error(f"Config push to {device['id']} failed: {e}")
        finally:
            self._inflight.discard(device["id"])


sync = ConfigSync()
