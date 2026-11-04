import logging
from typing import Any, Iterator

import httpx

from app.config import settings
from app.services.config_store import canon
from app.services.devices import registry

logger = logging.getLogger(__name__)

# Виды, которые паспорт принимает целиком; остальные правятся в своих модулях
PULL_KINDS = ("camera", "video_stream", "neural_slot", "neural_config", "surround_output", "projection")
# Сколько секунд ждём ответ платы
BOARD_TIMEOUT_S = 10.0
# Виды с полем place; в пакете платы оно вырезано
PLACED_KINDS = ("camera", "video_stream", "neural_slot", "projection")


def _changes(was: Any, now: Any, path: str = "") -> Iterator[dict]:
    if isinstance(was, dict) and isinstance(now, dict):
        for key in sorted(was.keys() | now.keys()):
            yield from _changes(was.get(key), now.get(key), f"{path}.{key}" if path else key)
    elif canon(was) != canon(now):
        yield {"path": path, "was": was, "now": now}


def package_entities(parts: dict, place: str, camera_keys: dict[str, str]) -> tuple[dict[tuple[str, str], Any], set[str]]:
    found: dict[tuple[str, str], Any] = {}
    covered: set[str] = set()
    if isinstance(parts.get("cameras"), list):
        covered.add("camera")
        for body in parts["cameras"]:
            camera_id = (body.get("camera") or {}).get("id")
            found[("camera", camera_keys.get(camera_id, camera_id))] = {**body, "place": place}
    neural = parts.get("neural")
    if isinstance(neural, dict):
        covered |= {"neural_config", "video_stream", "neural_slot"}
        for key, body in (neural.get("configurations") or {}).items():
            found[("neural_config", key)] = body
        for key, body in (neural.get("streams") or {}).items():
            found[("video_stream", key)] = {**body, "place": place}
        for body in neural.get("slots") or []:
            found[("neural_slot", f"{body.get('stream_id')}|{body.get('config_id')}")] = {**body, "place": place}
    surround = parts.get("surround")
    if isinstance(surround, dict):
        covered |= {"projection", "surround_output"}
        for key, body in (surround.get("projections") or {}).items():
            found[("projection", key)] = {**body, "place": place}
        if surround.get("output") is not None:
            found[("surround_output", place)] = surround["output"]
    return found, covered


def _label(kind: str, key: str, body: Any) -> str:
    if not isinstance(body, dict):
        return key
    if kind == "camera":
        return (body.get("camera") or {}).get("display_name") or key
    return body.get("name") or key


def diff_package(bodies: dict[str, dict[str, Any]], place: str, parts: dict) -> dict:
    camera_keys = {
        (body.get("camera") or {}).get("id"): key
        for key, body in bodies.get("camera", {}).items() if body.get("place") == place
    }
    found, covered = package_entities(parts, place, camera_keys)
    items, skipped = [], []
    for (kind, key), now in sorted(found.items()):
        if kind not in PULL_KINDS:
            continue
        was = bodies.get(kind, {}).get(key)
        changes = list(_changes(was, now)) if was is not None else []
        if was is not None and not changes:
            continue
        items.append({
            "kind": kind, "key": key, "name": _label(kind, key, now), "place": place,
            "state": "replace" if was is not None else "add", "changes": changes, "body": now,
        })
    for kind in PULL_KINDS:
        if kind not in covered:
            continue
        for key, body in sorted(bodies.get(kind, {}).items()):
            if (kind, key) in found or (kind in PLACED_KINDS and body.get("place") != place):
                continue
            if kind == "surround_output" and key != place:
                continue
            skipped.append({"kind": kind, "key": key, "name": _label(kind, key, body), "reason": "absent_on_board"})
    return {"items": items, "skipped": skipped}


async def board_diff(effective: dict, client: httpx.AsyncClient) -> dict:
    bodies = {kind: {key: entry["body"] for key, entry in entries.items()} for kind, entries in effective["entities"].items()}
    devices, items, skipped = [], [], []
    for place, binding in sorted(bodies.get("binding", {}).items()):
        device_id = (binding or {}).get("device_id")
        if not device_id or place not in bodies.get("place", {}):
            continue
        state: dict[str, Any] = {"device_id": device_id, "place": place, "state": "ok", "error": None}
        devices.append(state)
        device = registry.get(device_id)
        if not device:
            state.update({"state": "error", "error": f"Device {device_id} is not registered"})
            continue
        try:
            response = await client.get(f"http://{device['ip']}:{settings.DEVICE_MC_PORT}/config", timeout=BOARD_TIMEOUT_S)
            response.raise_for_status()
            applied = response.json().get("data") or {}
        except Exception as error:
            logger.warning(f"Board configuration read from {device_id} failed: {error}")
            state.update({"state": "error", "error": str(error) or type(error).__name__})
            continue
        parts = applied.get("parts")
        if not isinstance(parts, dict):
            state.update({"state": "error", "error": "Board has no applied configuration"})
            continue
        result = diff_package(bodies, place, parts)
        items += [{**item, "device_id": device_id} for item in result["items"]]
        skipped += [{**item, "device_id": device_id} for item in result["skipped"]]
    return {"devices": devices, "items": items, "skipped": skipped}
