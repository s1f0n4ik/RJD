import pytest

from app.devices.scan_profile import build_profile


def point(x: float, y: float) -> dict:
    # Обратное преобразование для roll=0: x=cos(a)*r, y=-sin(a)*r.
    import math
    distance = math.hypot(x, y)
    angle = math.degrees(math.atan2(-y, x))
    return {"angle_deg": angle, "distance_mm": distance * 1000}


def test_profile_keeps_metric_coordinates_and_requires_calibration():
    profile = build_profile({"points": [point(-1, 0), point(0, 0), point(1, 0)]}, {})
    assert profile["calibrated"] is False
    assert profile["left_m"] is None
    assert profile["points"] == [[-1.0, 0.0], [0.0, 0.0], [1.0, 0.0]]


def test_profile_measures_drop_after_sleeper_zone():
    xs = [-2.2, -2.0, -1.8, -1.6, -1.4, 0, 1.4, 1.6, 1.8, 2.0, 2.2]
    points = [point(x, 0 if abs(x) <= 1.8 else -0.25) for x in xs]
    profile = build_profile({"points": points}, {
        "profile_calibrated": True,
        "profile_noise_threshold_m": 1,
        "profile_drop_height_m": 0.1,
        "profile_drop_length_m": 0.15,
    })
    assert profile["left_m"] == pytest.approx(1.8)
    assert profile["right_m"] == pytest.approx(1.8)
    assert profile["left_violation"] is True
    assert profile["right_violation"] is True
