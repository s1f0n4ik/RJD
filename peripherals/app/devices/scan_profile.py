from __future__ import annotations

import math
from typing import Any


def _number(config: dict[str, Any], name: str, default: float) -> float:
    try:
        value = float(config.get(name, default))
    except (TypeError, ValueError):
        return default
    return value if math.isfinite(value) else default


def _denoise(points: list[tuple[float, float]], index: int, threshold: float) -> tuple[float, float]:
    point = points[index]
    if index == 0 or index >= len(points) - 1:
        return point
    expected = (points[index - 1][1] + points[index + 1][1]) / 2
    return (point[0], expected) if abs(expected - point[1]) > threshold else point


def _measure_shoulder(
    points: list[tuple[float, float]],
    sleeper_half: float,
    drop_height: float,
    drop_length: float,
    noise_threshold: float,
) -> float | None:
    if not points:
        return None
    ordered = sorted(points, key=lambda point: abs(point[0]))
    previous = ordered[0]
    accumulated = 0.0
    drop_start: float | None = None
    for index in range(len(ordered)):
        point = _denoise(ordered, index, noise_threshold)
        if abs(point[0]) < sleeper_half:
            previous = point
            continue
        if -point[1] > drop_height:
            accumulated += abs(point[0] - previous[0])
            if drop_start is None:
                drop_start = abs(previous[0])
            if accumulated > drop_length:
                return drop_start
        else:
            accumulated = 0.0
            drop_start = None
        previous = point
    return abs(previous[0])


def build_profile(scan: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    """Convert a polar scan to the calibrated cross-section used by KGF analytics."""
    roll = _number(config, "profile_roll_deg", 0.0)
    scale_x = _number(config, "profile_scale_x", 1.0)
    scale_y = _number(config, "profile_scale_y", 1.0)
    offset_x = _number(config, "profile_offset_x_m", 0.0)
    offset_y = _number(config, "profile_offset_y_m", 0.0)
    half_width = max(0.5, _number(config, "profile_working_half_width_m", 3.0))
    ceiling = _number(config, "profile_working_ceiling_m", 0.5)
    floor = min(ceiling - 0.1, _number(config, "profile_view_floor_m", -1.0))
    mirror_x = bool(config.get("profile_mirror_x", False))
    sleeper_length = max(0.5, _number(config, "sleeper_length_m", 2.7))
    expected_left = max(sleeper_length / 2, _number(config, "profile_expected_left_m", 1.9))
    expected_right = max(sleeper_length / 2, _number(config, "profile_expected_right_m", 1.9))
    calibrated = bool(config.get("profile_calibrated", False))

    transformed: list[tuple[float, float]] = []
    visible_runs: list[list[list[float]]] = []
    current_run: list[list[float]] = []
    for raw in scan.get("points", []):
        try:
            distance = float(raw["distance_mm"]) / 1000
            angle = math.radians(float(raw["angle_deg"]) + roll + 90)
        except (KeyError, TypeError, ValueError):
            continue
        x = math.sin(angle) * distance * scale_x + offset_x
        y = math.cos(angle) * distance * scale_y + offset_y
        if mirror_x:
            x = -x
        if abs(x) > half_width or y > ceiling:
            if current_run:
                visible_runs.append(current_run)
                current_run = []
            continue
        transformed.append((x, y))
        if y < floor:
            if current_run:
                visible_runs.append(current_run)
                current_run = []
            continue
        current_run.append([round(x, 4), round(y, 4)])
    if current_run:
        visible_runs.append(current_run)
    visible = max(visible_runs, key=len, default=[])

    left_points = [point for point in transformed if point[0] < 0]
    right_points = [point for point in transformed if point[0] >= 0]
    measure_args = (
        sleeper_length / 2,
        max(0.01, _number(config, "profile_drop_height_m", 0.1)),
        max(0.01, _number(config, "profile_drop_length_m", 0.2)),
        max(0.0, _number(config, "profile_noise_threshold_m", 0.3)),
    )
    left = _measure_shoulder(left_points, *measure_args) if calibrated else None
    right = _measure_shoulder(right_points, *measure_args) if calibrated else None
    return {
        "calibrated": calibrated,
        "points": visible,
        "half_width_m": half_width,
        "floor_m": floor,
        "ceiling_m": ceiling,
        "sleeper_length_m": sleeper_length,
        "expected_left_m": expected_left,
        "expected_right_m": expected_right,
        "left_m": round(left, 3) if left is not None else None,
        "right_m": round(right, 3) if right is not None else None,
        "left_violation": left is not None and left < expected_left,
        "right_violation": right is not None and right < expected_right,
    }


def enrich_scan(scan: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    scan["profile"] = build_profile(scan, config)
    return scan
