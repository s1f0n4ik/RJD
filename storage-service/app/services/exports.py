"""
Каталог результатов склейки. Живёт на диске записей, но под своей квотой:
чистильщик записей его не считает, а результаты вытесняются своим порядком.
"""

import logging
import shutil
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)


class NoRoom(RuntimeError):
    """Результат не помещается; текст показывается пользователю."""

    def __init__(self, need: int, room: int):
        self.need = need
        self.room = room
        super().__init__(
            f"Нужно {fmt_size(need)}, доступно {fmt_size(room)}. Выберите «Сегменты как есть»"
        )


def fmt_size(size: int) -> str:
    gb = size / 1024 ** 3
    if gb >= 1:
        return f"{gb:.1f} ГБ".replace(".", ",")
    return f"{size / 1024 ** 2:.0f} МБ"


def root() -> Path:
    path = Path(settings.EXPORTS_PATH)
    path.mkdir(parents=True, exist_ok=True)
    return path


def dir_size(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    for file in path.rglob("*"):
        try:
            if file.is_file():
                total += file.stat().st_size
        except OSError:
            continue
    return total


def quota_bytes() -> int:
    usage = shutil.disk_usage(root())
    return int(usage.total * settings.EXPORT_QUOTA_RATIO)


# Сколько байт результат может занять прямо сейчас: остаток квоты, но не больше
# свободного места за вычетом резерва под запись
def room() -> int:
    path = root()
    usage = shutil.disk_usage(path)
    reserve = int(usage.total * settings.EXPORT_RESERVE_RATIO)
    return max(0, min(quota_bytes() - dir_size(path), usage.free - reserve))


def check_room(need: int) -> None:
    available = room()
    if need > available:
        raise NoRoom(need, available)


# После перезапуска задач нет, значит и результаты никому не принадлежат
def sweep() -> int:
    path = root()
    removed = 0
    for entry in path.iterdir():
        try:
            if entry.is_dir():
                shutil.rmtree(entry)
            else:
                entry.unlink()
            removed += 1
        except OSError as e:
            logger.warning("Cannot remove export %s: %s", entry, e)
    if removed:
        logger.info("Exports directory swept: %d entries removed", removed)
    return removed
