"""
Zip без сжатия прямо в HTTP-ответ. Файлы читаются по одному и уходят клиенту
по мере чтения: на диске ничего не создаётся, размер ограничен только zip64.
Приёмник без seek заставляет zipfile писать data descriptors — так архив
пишется в один проход.
"""

import logging
import queue
import threading
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Iterable, Iterator

logger = logging.getLogger(__name__)

CHUNK = 1024 * 1024
# Сколько кусков может ждать отправки между чтением файлов и клиентом
BACKLOG = 4


class _Cancelled(Exception):
    pass


class _Pipe:
    """Приёмник для ZipFile: write кладёт куски в очередь, читает их генератор."""

    def __init__(self):
        self.queue: queue.Queue = queue.Queue(maxsize=BACKLOG)
        self.cancelled = False
        self.written = 0

    def write(self, data) -> int:
        if self.cancelled:
            raise _Cancelled()
        chunk = bytes(data)
        if chunk:
            self.queue.put(chunk)
            self.written += len(chunk)
        return len(chunk)

    # zipfile считает смещения через tell; seek отсутствует намеренно
    def tell(self) -> int:
        return self.written

    def flush(self) -> None:
        pass


def _date_time(path: Path) -> tuple:
    try:
        stamp = datetime.fromtimestamp(path.stat().st_mtime)
    except OSError:
        stamp = datetime.now()
    if stamp.year < 1980:
        stamp = datetime(1980, 1, 1)
    return (stamp.year, stamp.month, stamp.day, stamp.hour, stamp.minute, stamp.second)


def stream_zip(entries: Iterable[tuple[Path, str]]) -> Iterator[bytes]:
    """Генератор байтов архива; entries — пары «путь на диске, имя внутри архива»."""
    pipe = _Pipe()

    def produce() -> None:
        try:
            with zipfile.ZipFile(pipe, "w", zipfile.ZIP_STORED) as archive:
                for path, arcname in entries:
                    info = zipfile.ZipInfo(arcname, date_time=_date_time(path))
                    info.compress_type = zipfile.ZIP_STORED
                    with open(path, "rb") as src, archive.open(info, "w", force_zip64=True) as dst:
                        while True:
                            chunk = src.read(CHUNK)
                            if not chunk:
                                break
                            dst.write(chunk)
        except _Cancelled:
            logger.info("Zip stream cancelled by client")
        except Exception as e:
            logger.exception("Zip stream failed")
            pipe.queue.put(e)
        finally:
            pipe.queue.put(None)

    threading.Thread(target=produce, name="zip-stream", daemon=True).start()

    try:
        while True:
            item = pipe.queue.get()
            if item is None:
                return
            if isinstance(item, Exception):
                raise item
            yield item
    finally:
        # Клиент ушёл: писатель мог встать на полной очереди — разблокируем и даём выйти
        pipe.cancelled = True
        while True:
            try:
                item = pipe.queue.get(timeout=1)
            except queue.Empty:
                break
            if item is None:
                break
