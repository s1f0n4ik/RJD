import copy
from pathlib import PurePosixPath
from typing import Any, Callable, Optional

# Проверки повторяют прежнее сохранение в загрузчике media-center
CONFIG_DERIVED = ("model", "model_path", "model_file", "_assets")
CSize = Callable[[Optional[str]], Optional[tuple[int, int]]]


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def zones_error(cfg: dict) -> Optional[str]:
    if "zone_enter_frames" in cfg and (not _is_int(cfg["zone_enter_frames"]) or cfg["zone_enter_frames"] < 1):
        return "zone_enter_frames must be integer >= 1"
    leave = cfg.get("zone_leave_s")
    if "zone_leave_s" in cfg and (isinstance(leave, bool) or not isinstance(leave, (int, float)) or leave < 0):
        return "zone_leave_s must be number >= 0"
    if "zones" not in cfg:
        return None
    if not isinstance(cfg["zones"], list):
        return "zones must be array"
    ids = set()
    for zone in cfg["zones"]:
        if not isinstance(zone, dict):
            return "zone must be object"
        zone_id = zone.get("id")
        if not _is_int(zone_id) or zone_id < 1:
            return "zone id must be integer >= 1"
        if zone_id in ids:
            return f"duplicate zone id {zone_id}"
        ids.add(zone_id)
        threshold = zone.get("threshold")
        if "threshold" in zone and (isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not 0 <= threshold <= 1):
            return "zone threshold must be in 0..1"
    return None


def model_name(model_path: Any) -> str:
    return PurePosixPath(str(model_path or "")).name


def config_entry(config_id: str, cfg: Any, models: dict[str, str]) -> dict:
    if not isinstance(cfg, dict):
        raise ValueError(f"'{config_id}' not object")
    if "model_path" not in cfg:
        raise ValueError(f"missing model_path in {config_id}")
    if "classes" not in cfg:
        raise ValueError(f"missing classes in {config_id}")
    if error := zones_error(cfg):
        raise ValueError(f"{config_id}: {error}")
    name = model_name(cfg["model_path"])
    if name not in models:
        raise ValueError(f"{config_id}: model file {name!r} is not in the library")
    body = {k: copy.deepcopy(v) for k, v in cfg.items() if k not in CONFIG_DERIVED}
    body["model_file"] = name
    body["_assets"] = {name: models[name]}
    return body


def stream_entry(stream: Any, place: str, configs: dict[str, dict], size_of: CSize) -> dict:
    if not isinstance(stream, dict) or not stream.get("id"):
        raise ValueError("stream must be an object with id")
    body = {k: copy.deepcopy(v) for k, v in stream.items() if k != "place"}
    if not body.get("width") or not body.get("height"):
        body["width"], body["height"] = size_of(body.get("config_id")) or (640, 640)
    for config_id, per_camera in (body.get("zones") or {}).items():
        if config_id not in configs:
            raise ValueError(f"zones refer to unknown configuration {config_id!r}")
        catalog = {zone.get("id") for zone in configs[config_id].get("zones") or []}
        for camera, polygons in (per_camera or {}).items():
            for polygon in polygons or []:
                if polygon.get("zone") not in catalog:
                    raise ValueError(f"zone {polygon.get('zone')} on {camera} is not in the catalog of {config_id}")
    body["place"] = place
    return body


def slot_entries(descs: Any, place: str, streams: dict[str, dict], configs: dict[str, dict], size_of: CSize) -> dict[str, dict]:
    if not isinstance(descs, list):
        raise ValueError("state must be an array of slots")
    out: dict[str, dict] = {}
    for desc in descs:
        if not isinstance(desc, dict) or not desc.get("stream_id"):
            raise ValueError("empty stream_id")
        stream_id = desc["stream_id"]
        stream = streams.get(stream_id)
        if not stream:
            raise ValueError(f"stream '{stream_id}' not found")
        if stream.get("place") != place:
            raise ValueError(f"stream '{stream_id}' belongs to another place")
        # Слот без конфигурации берёт её у своего потока, как прежде
        config_id = desc.get("config_id") or stream.get("config_id")
        if not config_id:
            raise ValueError(f"slot on stream '{stream_id}' has no configuration")
        if config_id not in configs:
            raise ValueError(f"configuration '{config_id}' not found")
        size = size_of(config_id)
        canvas = (stream.get("width"), stream.get("height"))
        if size and size != canvas:
            raise ValueError(f"model of '{config_id}' expects {size[0]}x{size[1]}, stream '{stream_id}' canvas is {canvas[0]}x{canvas[1]}")
        key = f"{stream_id}|{config_id}"
        if key in out:
            raise ValueError(f"duplicate slot: stream '{stream_id}', configuration '{config_id}'")
        out[key] = {"place": place, **{k: copy.deepcopy(v) for k, v in desc.items() if k != "place"}, "config_id": config_id}
    return out
