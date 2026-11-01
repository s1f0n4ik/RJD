from __future__ import annotations

import asyncio
import copy
import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Body, HTTPException, status
from pydantic import BaseModel

from app.config import settings
from app.services.config_store import get_store
from app.services.config_sync import build_service_packages, sync
from app.services.lifecycle import lifecycle

router = APIRouter()
logger = logging.getLogger(__name__)


async def _get(client: httpx.AsyncClient, url: str) -> Optional[dict]:
    try:
        response = await client.get(url)
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(f"configurations: {url} unavailable: {e}")
        return None


def _module(summary: dict, live: Optional[dict]) -> dict:
    out = {"id": summary.get("id"), "title": summary.get("title"), "transport": summary.get("transport")}
    if live is not None:
        connection = live.get("connection") or {}
        out.update(connected=bool(connection.get("connected")), url=connection.get("url") or "", error=connection.get("error") or "")
    return out


@router.get("/configurations")
async def list_configurations() -> dict:
    gateway = settings.GATEWAY_URL.rstrip("/")
    async with httpx.AsyncClient(timeout=settings.GATEWAY_TIMEOUT) as client:
        integrations, gw_status, rules = await asyncio.gather(
            _get(client, f"{gateway}/integrations"),
            _get(client, f"{gateway}/status"),
            _get(client, f"{settings.DETECTION_URL.rstrip('/')}/rules"),
        )

    entities = get_store().effective()["entities"]
    active = entities.get("machine", {}).get("settings", {}).get("body", {}).get("active_integration") or ""
    live = {m.get("id"): m for m in (gw_status or {}).get("modules", [])} if gw_status and gw_status.get("id") == active else {}
    items = [
        {
            "id": item.get("id"),
            "title": item.get("title"),
            "description": item.get("description"),
            "active": item.get("id") == active,
            "modules": [_module(m, live.get(m.get("id")) if item.get("id") == active else None) for m in item.get("modules", [])],
        }
        for item in (integrations or {}).get("items", [])
    ]
    return {"gateway": integrations is not None, "active": active, "items": items, "master": rules,
            "transition": lifecycle.status(), "delivery": sync.status()}


class SelectRequest(BaseModel):
    id: str


@router.post("/configurations/select")
async def select_configuration(req: SelectRequest) -> dict:
    store = get_store()
    profile = store.active_profile()
    if not profile:
        raise HTTPException(409, "No active machine profile")
    await lifecycle.switch(profile, req.id)
    return await list_configurations()


async def _master(method: str, path: str, body: Optional[dict] = None) -> dict:
    url = f"{settings.DETECTION_URL.rstrip('/')}{path}"
    try:
        async with httpx.AsyncClient(timeout=settings.GATEWAY_TIMEOUT) as client:
            response = await client.request(method, url, json=body)
    except httpx.HTTPError as e:
        logger.warning(f"configurations: master {url} unavailable: {e}")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Detection master is unavailable")
    if response.is_error:
        try:
            detail = response.json().get("detail")
        except ValueError:
            detail = response.text[:200]
        raise HTTPException(status_code=response.status_code, detail=detail)
    return response.json()


@router.get("/configurations/link")
async def configuration_link() -> dict:
    return await _master("GET", "/link")


@router.get("/configurations/{config_id}/rules")
async def get_configuration_rules(config_id: str) -> dict:
    state = await _master("GET", f"/rules/{config_id}")
    store = get_store()
    entry = store.effective()["entities"].get("rules", {}).get(config_id)
    source = entry["body"] if entry else state["defaults"]
    state["settings"] = merge(state["defaults"], source) if store.is_repairing(store.active_profile()) else (
        await _master("POST", f"/rules/{config_id}/validate", source))
    override = store.passport(store.active_profile()).get(("rules", config_id)) if store.active_profile() else None
    state["saved_at"] = int(override["updated"] * 1000) if override else None
    return state


@router.put("/configurations/{config_id}/rules")
async def put_configuration_rules(config_id: str, body: dict = Body(...)) -> dict:
    store = get_store()
    profile = store.active_profile()
    if not profile:
        raise HTTPException(409, "No active machine profile")
    if config_id not in store.effective()["entities"].get("integration", {}):
        raise HTTPException(404, "Unknown integration")
    parsed = await _master("POST", f"/rules/{config_id}/validate", body)
    store.put(profile, "rules", config_id, parsed)
    error = await sync.push_checked()
    if error:
        raise HTTPException(502, f"Source saved; application failed: {error}")
    logger.info(f"configuration {config_id} rules saved")
    return await get_configuration_rules(config_id)


@router.put("/configurations/gateway/{module}")
async def put_gateway_module(module: str, body: dict = Body(...)) -> dict:
    store = get_store()
    profile = store.active_profile()
    if not profile:
        raise HTTPException(409, "No active machine profile")
    entities = store.effective()["entities"]
    active = entities.get("machine", {}).get("settings", {}).get("body", {}).get("active_integration") or ""
    entry = entities.get("integration", {}).get(active)
    if not entry or module not in entry["body"].get("modules", {}):
        raise HTTPException(404, "Unknown active integration module")
    source = copy.deepcopy(entry["body"])
    source["modules"][module] = merge(source["modules"][module], body)
    package = build_service_packages(store)["gateway"]
    package["integrations"][active] = source
    if not store.is_repairing(profile):
        try:
            async with httpx.AsyncClient(timeout=settings.GATEWAY_TIMEOUT) as client:
                validated = await client.post(settings.GATEWAY_URL.rstrip("/") + "/config/validate", json=package)
                validated.raise_for_status()
                source["modules"] = validated.json()["integrations"][active]["modules"]
        except httpx.HTTPStatusError as error:
            raise HTTPException(422, error.response.json().get("error", "Invalid gateway configuration"))
        except httpx.HTTPError:
            raise HTTPException(503, "Gateway validation is unavailable")
    store.put(profile, "integration", active, source)
    error = await sync.push_checked()
    if error:
        raise HTTPException(502, f"Source saved; application failed: {error}")
    return await gateway_status()


@router.get("/configurations/gateway/status")
async def gateway_status() -> dict:
    store = get_store()
    repairing = store.is_repairing(store.active_profile())
    package = build_service_packages(store).get("gateway") if repairing else None
    base = settings.GATEWAY_URL.rstrip("/")
    active = package["active"] if package else ""
    path = f"/integrations/{active}/status" if repairing and active else "/status"
    async with httpx.AsyncClient(timeout=settings.GATEWAY_TIMEOUT) as client:
        result = await _get(client, base + path)
        if result is None:
            raise HTTPException(503, "Gateway status is unavailable")
        if package and active:
            defaults = await client.post(base + "/config/validate", json={**package, "integrations": {}})
            if defaults.is_error:
                raise HTTPException(502, "Gateway defaults are unavailable")
            sources = defaults.json()["integrations"][active]["modules"]
            sources = merge(sources, package["integrations"].get(active, {}).get("modules", {}))
            source_status(result, sources)
            result["repairing"] = True
    return result


def source_status(result: dict, sources: dict) -> None:
    connection_fields = {"websocket": ("enabled", "host", "port", "target"),
                         "can": ("enabled", "mode", "iface", "device", "bitrate"),
                         "modbus": ("enabled", "device", "baud", "parity", "data_bits", "stop_bits")}
    for module in result.get("modules", []):
        source = sources.get(module["id"], {})
        module["connection"].update({key: source[key] for key in connection_fields.get(module["id"], ()) if key in source})
        if module["id"] == "websocket":
            module.update({key: source[key] for key in ("heartbeat_sec", "heartbeat_enabled") if key in source})
            connection = module["connection"]
            connection["url"] = f"ws://{connection['host']}:{connection['port']}{connection['target']}"
        elif module["id"] == "can":
            tx_fields = {"continuous": "tx_continuous", "period_ms": "tx_period_ms", "dlc": "tx_dlc",
                         "ttl_enabled": "payload_ttl_enabled", "payload_ttl_ms": "payload_ttl_ms"}
            module["tx"].update({key: source[field] for key, field in tx_fields.items() if field in source})
            for message in module.get("messages", []):
                message.update(source.get(message["key"], {}))
                values = [message.get(key) for key in ("priority", "pgn", "addr", "dst_addr")]
                limits = (7, 65535, 255, 255)
                if all(type(value) is int and 0 <= value <= limit for value, limit in zip(values, limits)):
                    priority, pgn, address, destination = values
                    pf = pgn >> 8
                    ps = pgn & 255 if pf >= 240 else destination
                    message.update(id=f"0x{(priority << 26) | (pf << 16) | (ps << 8) | address:08X}",
                                   pgn_hex=f"0x{pgn:04X}", addr_hex=f"0x{address:02X}")
                else:
                    message["id"] = "—"
        elif module["id"] == "modbus":
            module["slave"].update({("address" if key == "slave" else key): source[key]
                                    for key in ("slave", "device_id", "version", "limit_records", "max_records") if key in source})


def merge(source: dict, patch: dict) -> dict:
    result = copy.deepcopy(source)
    for key, value in patch.items():
        result[key] = merge(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else copy.deepcopy(value)
    return result
