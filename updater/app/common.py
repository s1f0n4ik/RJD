from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)

# Месяцы как у Intl ru-RU в коротком виде, чтобы версии на экране и в журнале совпадали
MONTHS = ("янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек.")
ROLES = ("minion", "master")


# Сбой шага обновления; текст показывается оператору
class StepError(Exception):
    pass


@dataclass
class Config:
    state_dir: Path = Path("/var/lib/varan-updater")
    opt_dir: Path = Path("/opt")
    mc_defaults: Path = Path("/etc/default/media-center")
    mc_port: int = 7777
    minion_port: int = 8004
    master_port: int = 8005
    fastapi_url: str = "http://127.0.0.1:8000"
    health_timeout: float = 180
    lost_after: float = 30
    poll_every: float = 1
    version: str = "dev"
    # Подмена адресов плат для проверок: (ip, своя плата) -> базовый URL службы
    board_url_override: Optional[Callable[[str, bool], str]] = None

    def role_dir(self, role: str) -> Path:
        return self.opt_dir / f"varan-{role}"

    def board_url(self, ip: str, local: bool) -> str:
        if self.board_url_override:
            return self.board_url_override(ip, local)
        return f"http://{'127.0.0.1' if local else ip}:{self.minion_port}"

    def devices_file(self) -> Path:
        root = read_env(self.role_dir("master") / ".env", "VARAN_ROOT") or "/var/lib/varan"
        return Path(root) / "settings" / "devices.json"


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def read_env(path: Path, key: str) -> str:
    value = ""
    for line in read_text(path).splitlines():
        if line.startswith(key + "="):
            value = line[len(key) + 1:].strip()
    return value


def read_json(path: Path) -> Optional[dict]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def release_key(tag: Optional[str]) -> tuple:
    # Тег выпуска: ГГГГ-ММ-ДД-ЧЧММ-sha, у старых выпусков ГГГГ-ММ-ДД-sha
    parts = (tag or "").split("-")
    if len(parts) < 4 or not all(p.isdigit() for p in parts[:3]):
        return ("", "", "", "", tag or "")
    clock = parts[3] if len(parts) >= 5 and len(parts[3]) == 4 and parts[3].isdigit() else ""
    return (parts[0], parts[1], parts[2], clock, tag)


def release_label(tag: Optional[str]) -> str:
    if not tag:
        return "нет версии"
    year, month, day, clock, _ = release_key(tag)
    if not year or not 1 <= int(month) <= 12:
        return tag
    label = f"{int(day)} {MONTHS[int(month) - 1]} {year}"
    return f"{label}, {clock[:2]}:{clock[2:]}" if clock else label


def fmt_size(size: int) -> str:
    if size >= 1 << 30:
        return f"{size / (1 << 30):.2f} ГБ".replace(".", ",")
    if size >= 1 << 20:
        return f"{size / (1 << 20):.1f} МБ".replace(".", ",")
    return f"{max(1, round(size / 1024))} КБ"


# Журнал операций платы: его строки показываются в шторке «Журнал платы»
class OpLog:
    def __init__(self, path: Path, keep: int = 2000):
        self._path = path
        self._keep = keep
        self._lock = threading.Lock()

    def reset(self) -> None:
        with self._lock:
            self._path.write_text("", encoding="utf-8")

    def write(self, text: str) -> None:
        line = f"{time.strftime('%H:%M:%S')} {text}"
        logger.info(text)
        with self._lock:
            with self._path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")

    def lines(self) -> list[str]:
        with self._lock:
            return read_text(self._path).splitlines()[-self._keep:]


# Запуск внешних команд; в проверках подменяется
class Runner:
    def __call__(self, cmd: list[str], log: Callable[[str], None], env: Optional[dict] = None) -> int:
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                    errors="replace", env={**os.environ, **(env or {})})
        except OSError as e:
            log(f"не удалось запустить {cmd[0]}: {e}")
            return 127
        for line in proc.stdout:
            log(line.rstrip())
        return proc.wait()

    def capture(self, cmd: list[str], timeout: float = 20) -> tuple[int, str]:
        try:
            done = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as e:
            return 127, str(e)
        return done.returncode, done.stdout
