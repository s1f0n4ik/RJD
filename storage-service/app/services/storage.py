import logging
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Iterator, Optional

from app.config import settings

logger = logging.getLogger(__name__)

VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".ts"}

# Таймштамп в имени фрагмента: <camera>_YYYY-MM-DD_HH-MM-SS.mp4
FILENAME_TS = re.compile(r"(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})")

# Записи до появления потоков: лежат прямо в папке камеры
LEGACY_STREAM = "legacy"


class StorageService:
    """Инкапсулирует всё, что связано с корневым каталогом записей."""

    def __init__(self, root: Path):
        self.root = root

    def set_root(self, new_root: Path) -> None:
        """Сменить корневой каталог записей в рантайме."""
        self.root = new_root
        logger.info("Storage root changed to %s", new_root)

    def disk_usage(self):
        """Занятость диска, на котором лежит корень записей.
        Возвращает namedtuple с полями total, used, free либо None."""
        try:
            return shutil.disk_usage(self.root)
        except OSError as e:
            logger.warning("disk_usage failed for %s: %s", self.root, e)
            return None

    # ── Чтение ──

    def stream_dirs(self, camera_dir: Path) -> list:
        """Потоки камеры: подпапки плюс сама папка, если в ней лежат файлы."""
        if not camera_dir.is_dir():
            return []

        found = []
        has_flat = False

        for entry in sorted(camera_dir.iterdir()):
            if entry.is_dir():
                found.append((entry.name, entry))
            elif entry.is_file() and entry.suffix.lower() in VIDEO_EXTENSIONS:
                has_flat = True

        if has_flat:
            found.append((LEGACY_STREAM, camera_dir))

        return found

    def default_stream(self, camera_name: str) -> Optional[str]:
        """Поток с самой свежей записью."""
        newest_key = None
        newest_created = None

        for key, path in self.stream_dirs(self.root / camera_name):
            for item in self._collect_files(path):
                if newest_created is None or item["created"] > newest_created:
                    newest_created = item["created"]
                    newest_key = key

        return newest_key

    def stream_path(self, camera_name: str, stream: Optional[str]) -> Optional[Path]:
        """Каталог потока; для legacy и пустого значения — папка камеры."""
        camera_dir = self.root / camera_name
        if not camera_dir.is_dir():
            return None

        if not stream or stream == LEGACY_STREAM:
            return camera_dir

        if ".." in stream or "/" in stream or "\\" in stream:
            return None

        path = camera_dir / stream
        return path if path.is_dir() else None

    def list_streams(self, camera_name: str) -> list:
        """Ключи потоков камеры, у которых есть хотя бы один файл."""
        camera_dir = self.root / camera_name
        return [key for key, path in self.stream_dirs(camera_dir) if self._collect_files(path)]

    def list_all(self) -> dict:
        """Все записи, сгруппированные по камерам."""
        if not self.root.exists():
            logger.warning("Records path missing: %s", self.root)
            return {}

        result = {}
        for camera_dir in self.root.iterdir():
            if not camera_dir.is_dir():
                continue
            files = self._collect_camera(camera_dir)
            files.sort(key=lambda x: x["created"], reverse=True)
            result[camera_dir.name] = files
        return result

    def list_camera(self, camera_name: str, stream: Optional[str] = None) -> Optional[list]:
        camera_dir = self.root / camera_name
        if not camera_dir.is_dir():
            return None
        files = self._collect_camera(camera_dir, stream)
        files.sort(key=lambda x: x["created"], reverse=True)
        return files

    def resolve_file(self, camera_name: str, filename: str, stream: Optional[str] = None) -> Optional[Path]:
        """Безопасное разрешение пути с защитой от path traversal."""
        if ".." in filename or "/" in filename or "\\" in filename:
            return None
        if stream and (".." in stream or "/" in stream or "\\" in stream):
            return None

        camera_dir = self.root / camera_name

        if stream:
            candidates = [
                camera_dir / filename if stream == LEGACY_STREAM else camera_dir / stream / filename
            ]
        else:
            # Поток не указан — ищем по всем, начиная со старых записей
            candidates = [camera_dir / filename]
            candidates += [path / filename for key, path in self.stream_dirs(camera_dir)
                           if key != LEGACY_STREAM]

        for candidate in candidates:
            try:
                candidate.resolve().relative_to(self.root.resolve())
            except (ValueError, OSError):
                continue
            if candidate.is_file():
                return candidate

        return None

    # ── Очистка ──

    def total_size_bytes(self) -> int:
        """Суммарный размер всех файлов под root."""
        if not self.root.exists():
            return 0
        total = 0
        for p in self.root.rglob("*"):
            if p.is_file():
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
        return total

    def all_files_oldest_first(self) -> Iterator[Path]:
        """
        Перебор всех видеофайлов под всеми поддиректориями,
        отсортированных по времени создания (старые сначала).
        """
        if not self.root.exists():
            return
        files = []
        for p in self.root.rglob("*"):
            if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS:
                try:
                    files.append((p.stat().st_mtime, p))
                except OSError:
                    pass
        files.sort(key=lambda x: x[0])
        for _, path in files:
            yield path

    def remove_empty_subdirs(self) -> int:
        """Удалить пустые каталоги камер и их потоков; потоки первыми."""
        if not self.root.exists():
            return 0

        removed = 0
        for camera_dir in self.root.iterdir():
            if not camera_dir.is_dir():
                continue

            for stream_dir in camera_dir.iterdir():
                if stream_dir.is_dir() and not any(stream_dir.iterdir()):
                    try:
                        stream_dir.rmdir()
                        removed += 1
                        logger.info("Removed empty dir: %s", stream_dir)
                    except OSError as e:
                        logger.warning("Failed to remove %s: %s", stream_dir, e)

            if not any(camera_dir.iterdir()):
                try:
                    camera_dir.rmdir()
                    removed += 1
                    logger.info("Removed empty dir: %s", camera_dir)
                except OSError as e:
                    logger.warning("Failed to remove %s: %s", camera_dir, e)

        return removed

    # ── helpers ──

    @staticmethod
    def _created_iso(f: Path, ctime: float) -> str:
        """Начало фрагмента из имени файла: его пишет media-center по времени
        шлюза (уже в настроенном поясе). ctime файла — часы контейнера, они
        врут на пояс; остаются фоллбэком для файлов без таймштампа в имени."""
        m = FILENAME_TS.search(f.stem)
        if m:
            return f"{m.group(1)}T{m.group(2)}:{m.group(3)}:{m.group(4)}"
        return datetime.fromtimestamp(ctime).isoformat()

    def _collect_camera(self, camera_dir: Path, stream: Optional[str] = None) -> list:
        """Записи камеры с пометкой потока; stream сужает выборку до одного."""
        files = []

        for key, path in self.stream_dirs(camera_dir):
            if stream and key != stream:
                continue
            for item in self._collect_files(path):
                item["stream"] = key
                files.append(item)

        return files

    def _collect_files(self, camera_dir: Path) -> list:
        out = []
        for f in camera_dir.iterdir():
            if not f.is_file() or f.suffix.lower() not in VIDEO_EXTENSIONS:
                continue
            try:
                stat = f.stat()
                out.append({
                    "filename": f.name,
                    "size": stat.st_size,
                    "created": self._created_iso(f, stat.st_ctime),
                    "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                })
            except OSError as e:
                logger.warning("Skipping %s: %s", f, e)
        return out


storage = StorageService(Path(settings.RECORDS_PATH))