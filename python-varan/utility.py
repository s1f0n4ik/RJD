import json
import time
import cv2
import numpy as np

from typing import Any

from main_config import YOLO_GRAY_Y


def pretty_json(obj: Any) -> str:
    """
    Преобразует dict или JSON-строку в читабельную многострочную строку.
    Если передана некорректная JSON-строка — вернёт исходное значение.
    """
    if obj is None:
        return ""
    if isinstance(obj, str):
        try:
            parsed = json.loads(obj)
        except json.JSONDecodeError:
            return obj  # не JSON — возвращаем как есть
    else:
        parsed = obj
    return json.dumps(parsed, indent=2, ensure_ascii=False)

def now_ms() -> int:
    return int(time.time_ns() // 1_000_000)

def nv12_to_rgb(y: np.ndarray, uv: np.ndarray, width: int, height: int) -> np.ndarray:
    """
    Преобразование из NV12 в RGB
    """
    y = y.astype(np.float32)

    if uv.ndim == 3 and uv.shape[2] == 2:
        uv = uv.reshape(uv.shape[0], uv.shape[1] * 2)

    uv = uv.astype(np.float32)

    # Разделяем UV на U и V каналы (ширина uv равна width, каждый второй элемент - U или V)
    u = uv[:, 0::2]
    v = uv[:, 1::2]

    # Расширяем u и v на каждый пиксель (каждый элемент повторяется по 2x2 блокам)
    u = np.repeat(np.repeat(u, 2, axis=0), 2, axis=1)
    v = np.repeat(np.repeat(v, 2, axis=0), 2, axis=1)

    # Обрезаем до размера изображения (на случай нечетных размеров)
    u = u[:height, :width]
    v = v[:height, :width]

    # Преобразование по стандарту BT.601
    c = y - 16
    d = u - 128
    e = v - 128

    r = 1.164 * c + 1.596 * e
    g = 1.164 * c - 0.392 * d - 0.813 * e
    b = 1.164 * c + 2.017 * d

    rgb = np.stack((r, g, b), axis=-1)
    np.clip(rgb, 0, 255, out=rgb)

    return rgb.astype(np.uint8)
