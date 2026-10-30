import copy
import re
from typing import Any

# Проверки повторяют разбор POST/PATCH /camera в media-center
STREAM_KEY_RE = re.compile(r"^stream_[1-9][0-9]*$")
PURPOSES = ("view", "record", "neural", "birdview")
CHANNELS = range(1, 7)
SUBSTREAMS = range(1, 7)
PRODUCTIONS = range(0, 4)
CAMERA_FIELDS = ("id", "ip_adress", "port", "user", "password", "production", "streams")
STREAM_FIELDS = ("substream", "purposes", "latency", "use_udp", "reconnect")


def _int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        raise ValueError(f"{field} must be an integer")
    return int(value)


def stream_entry(name: str, raw: Any) -> dict:
    if not STREAM_KEY_RE.match(name):
        raise ValueError(f"Stream key {name!r} must look like stream_N")
    if not isinstance(raw, dict):
        raise ValueError(f"Stream {name} is not an object")
    for field in STREAM_FIELDS:
        if field not in raw:
            raise ValueError(f"Stream {name} does not contain the required field <{field}>")
    channel = _int(raw.get("channel", 1), "channel")
    substream = _int(raw["substream"], "substream")
    if channel not in CHANNELS:
        raise ValueError(f"Stream {name}: channel is out of range 1...6")
    if substream not in SUBSTREAMS:
        raise ValueError(f"Stream {name}: substream is out of range 1...6")
    purposes = raw["purposes"]
    if not isinstance(purposes, list) or not purposes:
        raise ValueError(f"Stream {name}: purposes must be a non-empty array of strings")
    for purpose in purposes:
        if purpose not in PURPOSES:
            raise ValueError(f"Stream {name}: unknown purpose {purpose!r}")
    if len(set(purposes)) != len(purposes):
        raise ValueError(f"Stream {name}: a purpose is listed twice")
    if not isinstance(raw["use_udp"], bool):
        raise ValueError(f"Stream {name}: use_udp must be a boolean")
    record = "record" in purposes
    if record and ("record_path" not in raw or "segment" not in raw):
        raise ValueError(f"Stream {name}: record needs record_path and segment")
    return {
        "name": name,
        "channel": channel,
        "substream": substream,
        "purposes": list(purposes),
        "latency": _int(raw["latency"], "latency"),
        "use_udp": raw["use_udp"],
        "reconnect_delay": _int(raw["reconnect"], "reconnect"),
        "record_path": str(raw["record_path"]) if record else "",
        "segment_length": _int(raw["segment"], "segment") if record else 0,
    }


def camera_entry(payload: Any, place: str) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Invalid JSON body")
    for field in CAMERA_FIELDS:
        if field not in payload:
            raise ValueError(f"Missing field: {field}")
    production = _int(payload["production"], "production")
    if production not in PRODUCTIONS:
        raise ValueError("Not supported camera production!")
    if not isinstance(payload["streams"], dict):
        raise ValueError("Stream field is not json object!")
    return {
        "place": place,
        "camera": {
            "id": str(payload["id"]),
            "display_name": str(payload["display_name"]) if "display_name" in payload else "имя не установлено",
            "description": str(payload["description"]) if "description" in payload else "без описания",
            "ip_adress": str(payload["ip_adress"]),
            "port": str(payload["port"]),
            "user": str(payload["user"]),
            "password": str(payload["password"]),
            "production": production,
        },
        "streams": {name: stream_entry(name, raw) for name, raw in payload["streams"].items()},
    }


def patched_entry(entry: dict, body: Any) -> dict:
    if not isinstance(body, dict) or ("meta" not in body and "critical" not in body):
        raise ValueError("Empty PATCH: no meta or critical section provided")
    out = copy.deepcopy(entry)
    camera = out["camera"]
    meta = body.get("meta")
    if meta is not None:
        if not isinstance(meta, dict):
            raise ValueError("meta must be an object")
        if "display_name" not in meta and "description" not in meta:
            raise ValueError("No fields at meta block to update were provided")
        for field in ("display_name", "description"):
            if field in meta:
                camera[field] = str(meta[field])
    critical = body.get("critical")
    if critical is not None:
        if not isinstance(critical, dict):
            raise ValueError("critical must be an object")
        flat = {
            "id": camera["id"],
            "display_name": camera["display_name"],
            "description": camera["description"],
            "password": camera["password"],
            **{k: v for k, v in critical.items() if k not in ("id", "display_name", "description")},
        }
        out = camera_entry(flat, out["place"])
    return out
