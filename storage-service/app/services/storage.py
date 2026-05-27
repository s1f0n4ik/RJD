import logging
import shutil
from datetime import datetime
from pathlib import Path
from typing import Iterator, Optional

from app.config import settings

logger = logging.getLogger(__name__)

VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".ts"}


class StorageService:
    """Инкапсулирует всё, что связано с корневым каталогом записей."""

    def __init__(self, root: Path):
        self.root = root

    # ── Чтение ──

    def list_all(self) -> dict:
        """Все записи, сгруппированные по камерам."""
        if not self.root.exists():
            logger.warning("Records path missing: %s", self.root)
            return {}

        result = {}
        for camera_dir in self.root.iterdir():
            if not camera_dir.is_dir():
                continue
            files = self._collect_files(camera_dir)
            files.sort(key=lambda x: x["created"], reverse=True)
            result[camera_dir.name] = files
        return result

    def list_camera(self, camera_name: str) -> Optional[list]:
        camera_dir = self.root / camera_name
        if not camera_dir.is_dir():
            return None
        files = self._collect_files(camera_dir)
        files.sort(key=lambda x: x["created"], reverse=True)
        return files

    def resolve_file(self, camera_name: str, filename: str) -> Optional[Path]:
        """Безопасное разрешение пути с защитой от path traversal."""
        if ".." in filename or "/" in filename or "\\" in filename:
            return None
        candidate = self.root / camera_name / filename
        try:
            # Проверяем, что итоговый путь всё ещё под root
            candidate.resolve().relative_to(self.root.resolve())
        except (ValueError, OSError):
            return None
        if not candidate.is_file():
            return None
        return candidate

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
        """Удалить пустые подкаталоги в root. Возвращает количество удалённых."""
        if not self.root.exists():
            return 0
        removed = 0
        for subdir in self.root.iterdir():
            if subdir.is_dir() and not any(subdir.iterdir()):
                try:
                    subdir.rmdir()
                    removed += 1
                    logger.info("Removed empty dir: %s", subdir)
                except OSError as e:
                    logger.warning("Failed to remove %s: %s", subdir, e)
        return removed

    # ── helpers ──

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
                    "created": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                    "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                })
            except OSError as e:
                logger.warning("Skipping %s: %s", f, e)
        return out


storage = StorageService(Path(settings.RECORDS_PATH))