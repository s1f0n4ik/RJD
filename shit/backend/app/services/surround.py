import copy
import math
import re
from typing import Any


def object_body(value: Any) -> dict:
    if not isinstance(value, dict):
        raise ValueError("Body must be an object")
    return value


def entity_id(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("Id allows only letters, digits, underscores and hyphens")
    return value


def filename(value: Any) -> str:
    if not isinstance(value, str) or not value or value in (".", "..") or ".." in value or any(c in value for c in "/\\\x00"):
        raise ValueError("Invalid filename")
    return value


def model_filename(value: Any) -> str:
    name = filename(value)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.glb", name):
        raise ValueError("Model filename must be a .glb name with letters, digits, dots, underscores and hyphens")
    return name


def number(value: Any, label: str, low: float = -math.inf, high: float = math.inf) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"Invalid {label}")
    return value


def points(value: Any, label: str) -> list:
    if not isinstance(value, list) or len(value) < 4:
        raise ValueError(f"{label} needs at least four points")
    for point in value:
        if not isinstance(point, list) or len(point) != 2:
            raise ValueError(f"Invalid {label}")
        for coordinate in point:
            number(coordinate, label)
    return value


def same_points(first: Any, second: Any) -> bool:
    points(first, "destination points")
    points(second, "destination points")
    return len(first) == len(second) and all(math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-4)
                                           for p, q in zip(first, second) for a, b in zip(p, q))


def calibration_entry(value: Any) -> dict:
    entry = copy.deepcopy(object_body(value))
    entity_id(entry.get("id"))
    for field in ("width", "height"):
        size = number(entry.get(field), field, 1, 16384)
        if int(size) != size:
            raise ValueError(f"{field} must be an integer")
    for field, count in (("camera_matrix", 9), ("distortion_coeffs", 4), ("new_K", 9)):
        if field not in entry:
            continue
        matrix = object_body(entry[field])
        rows, cols = matrix.get("rows"), matrix.get("cols")
        expected = (3, 3) if count == 9 else None
        if type(rows) is not int or type(cols) is not int or rows <= 0 or cols <= 0 or rows * cols != count or (expected and (rows, cols) != expected):
            raise ValueError(f"Invalid {field} shape")
        data = matrix.get("data")
        if matrix.get("type") != 6 or not isinstance(data, list) or len(data) != count:
            raise ValueError(f"Invalid {field} values")
        for coordinate in data:
            number(coordinate, field)
    correction = entry.get("correction")
    if correction is not None:
        correction = object_body(correction)
        kind = correction.get("type")
        if kind == "panorama":
            number(correction.get("radius"), "radius", 0.001)
        elif kind == "fov":
            number(correction.get("fov"), "fov", 0.001, 179.999)
        elif kind != "fisheye":
            raise ValueError("Unknown correction type")
    if "new_K" in entry or (correction or {}).get("type") == "fisheye":
        if not all(field in entry for field in ("camera_matrix", "distortion_coeffs", "new_K")):
            raise ValueError("Fisheye correction requires camera_matrix, distortion_coeffs and new_K")
    if "points_raw" in entry and not isinstance(entry["points_raw"], bool):
        raise ValueError("points_raw must be a bool")
    if entry.get("points_raw") and ("new_K" in entry or correction):
        raise ValueError("Raw points cannot have a correction")
    if ("camera_matrix" in entry) != ("distortion_coeffs" in entry):
        raise ValueError("camera_matrix and distortion_coeffs must be supplied together")
    for field in ("camera_matrix", "new_K"):
        if field in entry:
            data = entry[field]["data"]
            if data[0] <= 0 or data[4] <= 0 or data[6:] != [0, 0, 1]:
                raise ValueError(f"Invalid {field} intrinsics")
    for field in ("undist_map_x", "undist_map_y", "_assets", "place"):
        entry.pop(field, None)
    return entry


def merge_patch(before: dict, patch: dict) -> dict:
    result = copy.deepcopy(before)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = {**result[key], **copy.deepcopy(value)}
        else:
            result[key] = copy.deepcopy(value)
    return result


def settings_patch(value: Any, mode: str) -> dict:
    patch = copy.deepcopy(object_body(value))
    patch.pop("export_id", None)
    allowed = ({"machine", "bowl", "orbit", "model", "plate", "wireframe", "photometric", "plate_length", "plate_width", "resolution", "calibration"}
               if mode == "surround" else {"model", "plate", "photometric", "plate_length", "plate_width", "resolution", "calibration", "blend", "images"})
    if not patch or set(patch) - allowed:
        raise ValueError("Unknown or empty settings patch")
    groups = {
        "machine": {"length", "width", "height"},
        "bowl": {"floor", "outer", "wall", "plate", "blend", "corner"},
        "orbit": {"distance", "height", "pitch", "speed", "interactive"},
        "model": {"length", "width", "height", "alpha", "rotation", "source", "scale", "stretch"},
        "resolution": {"width", "height"},
    }
    flags = {"plate", "wireframe", "photometric", "interactive", "stretch", "visible"}
    for key, value in patch.items():
        values = object_body(value) if key in groups or key in ("calibration", "images") else {key: value}
        if key in groups and set(values) - groups[key]:
            raise ValueError(f"Unknown {key} field")
        for field, item in values.items():
            if key == "calibration":
                entity_id(item)
            elif key == "images":
                filename(field)
                for name, setting in object_body(item).items():
                    if name == "visible" and isinstance(setting, bool):
                        continue
                    if name not in ("width", "height"):
                        raise ValueError("Invalid image setting")
                    number(setting, name, 0.001)
            elif field in flags:
                if not isinstance(item, bool):
                    raise ValueError(f"{field} must be a bool")
            elif field == "source":
                if item:
                    model_filename(item)
                elif item != "":
                    raise ValueError("Invalid model source")
            else:
                positive = key in ("machine", "resolution") or field in ("scale", "distance", "blend") or (key == "bowl" and field not in ("outer", "corner"))
                low = 0.001 if positive else -math.inf if field in ("pitch", "rotation") else 0
                number(item, field, low, 1 if field == "alpha" else math.inf)
                if key == "resolution" and (type(item) is not int or not 256 <= item <= (3840 if field == "width" else 2160) or item % 16):
                    raise ValueError("Resolution must be aligned to 16 within 256x256..3840x2160")
    return patch


def preset_entry(value: Any, previous: dict | None = None) -> dict:
    entry = copy.deepcopy(object_body(value))
    canvas = object_body(entry.get("canvas"))
    for field in ("width", "height"):
        size = number(canvas.get(field), field, 1, 16384)
        if int(size) != size:
            raise ValueError("Canvas size must be an integer")
    cameras = object_body(entry.get("cameras"))
    for key, camera in cameras.items():
        entity_id(key)
        object_body(camera)
        points(camera.get("dst_points"), "destination points")
        if camera.get("src_points"):
            points(camera["src_points"], "source points")
        old = ((previous or {}).get("cameras") or {}).get(key) or {}
        if not camera.get("src_points") and old.get("src_points"):
            camera["src_points"] = copy.deepcopy(old["src_points"])
        for field in ("camera_id", "calibration"):
            if field not in camera and field in old:
                camera[field] = old[field]
    entry.pop("place", None)
    entry.pop("_assets", None)
    return entry


def attach_assets(entry: dict, available: dict[str, str], existing: dict | None = None) -> dict:
    assets = dict((existing or {}).get("_assets") or {})
    assets.update(entry.get("_assets") or {})
    names = []
    images = entry.get("images") or []
    if not isinstance(images, list):
        raise ValueError("Images must be an array")
    for image in images:
        object_body(image)
        image.pop("path", None)
        rect = image.get("rect")
        if not isinstance(rect, list) or len(rect) != 4:
            raise ValueError("Image rect needs four coordinates")
        for index, coordinate in enumerate(rect):
            number(coordinate, "image rect", 0.001 if index > 1 else -math.inf)
        names.append(filename(image.get("name")))
    for mode in ("surround", "top"):
        source = ((entry.get(mode) or {}).get("model") or {}).get("source")
        if source:
            names.append(filename(source))
    result = {}
    for name in names:
        sha = assets.get(name) or available.get(name)
        if not sha:
            raise ValueError(f"Asset <{name}> is not in the library")
        result[name] = sha
    if result:
        entry["_assets"] = result
    else:
        entry.pop("_assets", None)
    return entry
