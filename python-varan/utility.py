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