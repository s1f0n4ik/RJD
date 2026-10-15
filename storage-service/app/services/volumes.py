import asyncio
import json
import logging
import os
import re
import shutil
import threading
import time
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from app.config import settings
from app.services import exports
from app.services.journal import journal
from app.services.segments import FVolumeView, index

logger = logging.getLogger(__name__)

# Без метки ФС автомонтирование называет каталог UUID тома
UUID_NAME = re.compile(r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4})$")

# fuseblk в MEDIA_ROOT монтирует только varan-media, и это exFAT: ядро платы без exfat
SUITABLE_FS = {"ext4", "exfat", "fuseblk"}

# Страховка media-center: выше этого он не пишет
STUCK_PERCENT = 99.0

MIN_HIGH = 50.0
MAX_HIGH = 98.0
MIN_GAP = 5.0

# Каталог архивов устройств на внешнем томе
DEVICES_DIR = "varan"


@dataclass(frozen=True)
class FMount:
    path: str
    fstype: str
    source: str
    readonly: bool


def _now_ms() -> int:
    return int(time.time() * 1000)


def _unescape(value: str) -> str:
    # В mountinfo пробелы и спецсимволы записаны восьмеричными кодами
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), value)


def media_mounts() -> list[FMount]:
    try:
        text = Path("/proc/self/mountinfo").read_text(encoding="utf-8")
    except OSError as e:
        logger.warning("Cannot read mountinfo: %s", e)
        return []
    return _parse_mounts(text, settings.MEDIA_ROOT.rstrip("/"))


def _parse_mounts(text: str, root: str) -> list[FMount]:
    found: dict[str, FMount] = {}
    for line in text.splitlines():
        left, _, right = line.partition(" - ")
        fields, tail = left.split(), right.split()
        if len(fields) < 6 or len(tail) < 2:
            continue
        path = _unescape(fields[4])
        if os.path.dirname(path) != root:
            continue
        # Ошибка ext4 с errors=remount-ro видна только в опциях суперблока
        options = fields[5].split(",") + (tail[2].split(",") if len(tail) > 2 else [])
        found[path] = FMount(path, tail[0], tail[1], "ro" in options)
    return list(found.values())


def _device_present(source: str) -> bool:
    # ponytail: проверяются только /dev/sdX и /dev/nvmeX, device-mapper считается живым
    if not source.startswith("/dev/") or source.startswith("/dev/mapper/"):
        return True
    return os.path.exists(f"/sys/class/block/{os.path.basename(source)}")


def read_marker(root: str) -> Optional[str]:
    try:
        data = json.loads(Path(root, settings.VOLUME_MARKER).read_text(encoding="utf-8"))
        return str(data["id"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _write_durable(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def write_marker(root: str) -> Optional[str]:
    volume_id = uuid.uuid4().hex
    try:
        _write_durable(Path(root, settings.VOLUME_MARKER), json.dumps({"id": volume_id}))
    except OSError as e:
        logger.warning("Cannot write volume marker at %s: %s", root, e)
        return None
    return volume_id


def _usage(path: str):
    try:
        return shutil.disk_usage(path)
    except OSError:
        return None


def _percent(path: str) -> Optional[float]:
    usage = _usage(path)
    if usage is None or not usage.total:
        return None
    return usage.used / usage.total * 100


def internal_usage(fresh: bool = False) -> Optional[dict]:
    # Занятость /storage с учётом выгрузок и незанятого резерва журнала; fresh — кадры журнала обойти заново
    usage = _usage(settings.INTERNAL_ROOT)
    if usage is None:
        return None
    exported = exports.dir_size(exports.root())
    reserve = journal.reserve_bytes()
    journal_used = journal.journal_bytes(fresh)
    withheld = max(0, reserve - journal_used) if reserve else 0
    return {
        "used": max(0, usage.used - exported) + withheld,
        "free": max(0, usage.free + exported - withheld),
        "total": usage.total,
        "journal_bytes": journal_used,
        "journal_reserve_bytes": reserve,
    }


def _fetch_device_id() -> Optional[str]:
    try:
        with urllib.request.urlopen(settings.MEDIA_CENTER_URL + "/system/info", timeout=2) as response:
            return (json.load(response).get("data") or {}).get("device_id") or None
    except (OSError, ValueError, AttributeError):
        return None


def _dir_size(path: Path) -> int:
    total = 0
    for dirpath, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(dirpath, name)).st_size
            except OSError:
                continue
    return total


class VolumePool:
    def __init__(self, path: Path):
        self._path = path
        self._lock = threading.RLock()
        self._data: dict = {"device_id": None, "next_number": 1, "volumes": []}
        # Подключённые внешние тома: id → точка монтирования
        self._live: dict[str, FMount] = {}
        self._unsuitable: list[dict] = []
        self._target: Optional[dict] = None
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()

    # ── хранение ──

    def _load(self) -> None:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as e:
            logger.warning("Cannot read pool %s: %s", self._path, e)
            return
        if isinstance(data, dict) and isinstance(data.get("volumes"), list):
            self._data.update(data)

    def _save(self) -> None:
        try:
            _write_durable(self._path, json.dumps(self._data, ensure_ascii=False, indent=2))
        except OSError as e:
            logger.warning("Cannot save pool %s: %s", self._path, e)

    # ── тома ──

    def _entry(self, volume_id: str) -> Optional[dict]:
        return next((e for e in self._data["volumes"] if e["id"] == volume_id), None)

    def _internal(self) -> dict:
        return next(e for e in self._data["volumes"] if e.get("internal"))

    def _externals(self) -> list[dict]:
        return [e for e in self._data["volumes"] if not e.get("internal")]

    @staticmethod
    def _name(entry: dict) -> str:
        if entry.get("internal"):
            return "Внутренний"
        return entry.get("name") or entry.get("label") or f"Диск {entry.get('number', 0)}"

    @staticmethod
    def _defaults() -> dict:
        high = settings.MAX_USED_PERCENT or 90.0
        return {"high": high, "low": round(high * settings.CLEANUP_TARGET_RATIO, 1)}

    def _ensure_internal(self) -> None:
        root = settings.INTERNAL_ROOT
        volume_id = read_marker(root) or write_marker(root) or "internal"
        entry = next((e for e in self._data["volumes"] if e.get("internal")), None)
        if entry is None:
            entry = {"id": volume_id, "internal": True, "enabled": True, "path": root, **self._defaults()}
            self._data["volumes"].insert(0, entry)
            self._save()
        elif entry["id"] != volume_id:
            logger.warning("Internal volume marker changed: %s -> %s", entry["id"], volume_id)
            entry["id"] = volume_id
            self._save()

    def _records_dir(self, mount: FMount) -> Optional[Path]:
        device_id = self._data.get("device_id")
        return Path(mount.path, DEVICES_DIR, device_id) if device_id else None

    def _write_set(self) -> list[tuple[dict, FMount]]:
        if not self._data.get("device_id"):
            return []
        return [
            (e, self._live[e["id"]]) for e in self._externals()
            if e["enabled"] and e["id"] in self._live and not self._live[e["id"]].readonly
        ]

    # ── опрос ──

    def tick(self) -> None:
        with self._lock:
            changed = False

            if not self._data.get("device_id"):
                device_id = _fetch_device_id()
                if device_id:
                    self._data["device_id"] = device_id
                    changed = True
                    logger.info("Device id resolved: %s", device_id)

            live: dict[str, FMount] = {}
            unsuitable: list[dict] = []

            for mount in media_mounts():
                if mount.fstype not in SUITABLE_FS:
                    unsuitable.append({"path": mount.path, "fstype": mount.fstype, "reason": "fs"})
                    continue
                if not _device_present(mount.source):
                    continue
                volume_id = read_marker(mount.path)
                if volume_id is None:
                    volume_id = None if mount.readonly else write_marker(mount.path)
                    if volume_id is None:
                        unsuitable.append({"path": mount.path, "fstype": mount.fstype, "reason": "marker"})
                        continue
                if volume_id in live or volume_id == self._internal()["id"]:
                    continue
                live[volume_id] = mount
                changed |= self._attach(volume_id, mount)

            now = _now_ms()
            for entry in self._externals():
                if entry["id"] in live:
                    entry["seen_ms"] = now
                elif entry["id"] in self._live:
                    logger.warning("Volume %s detached from %s", entry["id"], entry.get("path"))
                    changed = True

            self._live = live
            self._unsuitable = unsuitable
            if changed:
                self._save()

            self._publish()
            self._choose_target()

    def _attach(self, volume_id: str, mount: FMount) -> bool:
        name = os.path.basename(mount.path)
        label = "" if UUID_NAME.match(name) else name
        entry = self._entry(volume_id)

        if entry is None:
            self._data["volumes"].append({
                "id": volume_id, "internal": False, "name": "", "label": label,
                "number": self._data["next_number"], "enabled": True,
                "path": mount.path, "seen_ms": _now_ms(), **self._defaults(),
            })
            self._data["next_number"] += 1
            logger.info("New volume %s accepted at %s", volume_id, mount.path)
            return True

        changed = entry.get("label") != label
        entry["label"] = label

        if entry.get("path") != mount.path:
            moved = index.move_volume(volume_id, entry["path"], mount.path)
            logger.info("Volume %s moved from %s to %s, %d rows updated", volume_id, entry["path"], mount.path, moved)
            entry["path"] = mount.path
            changed = True

        if volume_id not in self._live:
            logger.info("Volume %s attached at %s", volume_id, mount.path)
            changed = True
        return changed

    def _publish(self) -> None:
        internal = self._internal()
        present: dict[str, Optional[Path]] = {internal["id"]: Path(settings.RECORDS_PATH)}
        for volume_id, mount in self._live.items():
            present[volume_id] = self._records_dir(mount)
        offline = {e["id"]: self._name(e) for e in self._externals() if e["id"] not in self._live}
        index.view = FVolumeView(internal_id=internal["id"], present=present, offline=offline, alive=self.alive)

    def alive(self, volume_id: str) -> bool:
        root = index.view.present.get(volume_id)
        if root is None or not root.is_dir():
            return False
        if volume_id == index.view.internal_id:
            return True
        mount = self._live.get(volume_id)
        return mount is not None and _device_present(mount.source) and read_marker(mount.path) == volume_id

    def _choose_target(self) -> None:
        internal = self._internal()
        target, path, root = internal, settings.RECORDS_PATH, settings.INTERNAL_ROOT

        writable = self._write_set()
        if writable:
            # Неизмеримый диск считается полным
            percents = {e["id"]: p if (p := _percent(m.path)) is not None else 100.0 for e, m in writable}
            below = [(e, m) for e, m in writable if percents[e["id"]] < e["high"]]
            target, mount = below[0] if below else min(writable, key=lambda pair: percents[pair[0]["id"]])
            path, root = str(self._records_dir(mount)), mount.path

        payload = {"volume_id": target["id"], "path": path, "marker": str(Path(root, settings.VOLUME_MARKER))}
        try:
            # Корень цели создаёт служба: media-center создаёт внутри только камеру и поток
            Path(path).mkdir(parents=True, exist_ok=True)
            # media-center пишет не от root: каталоги устройства на внешнем диске открыты всем
            if target is not internal:
                for directory in (Path(path).parent, Path(path)):
                    if directory.stat().st_mode & 0o777 != 0o777:
                        os.chmod(directory, 0o777)
        except OSError as e:
            logger.warning("Cannot prepare records dir %s: %s", path, e)
        if payload == self._target:
            return
        try:
            _write_durable(Path(settings.WRITE_TARGET_PATH), json.dumps(payload))
        except OSError as e:
            logger.error("Cannot write target file %s: %s", settings.WRITE_TARGET_PATH, e)
            return
        logger.info("Write target -> volume %s at %s", payload["volume_id"], payload["path"])
        self._target = payload

    # ── для чистильщика ──

    def internal_entry(self) -> dict:
        with self._lock:
            return dict(self._internal())

    def ring(self) -> list[tuple[dict, str, Path]]:
        with self._lock:
            return [(dict(e), m.path, self._records_dir(m)) for e, m in self._write_set()]

    def capacity(self) -> Optional[dict]:
        """Ёмкость подключённых томов пула суммарно."""
        with self._lock:
            roots = [settings.INTERNAL_ROOT] + [m.path for m in self._live.values()]
        usages = [u for u in map(_usage, roots) if u is not None]
        if not usages:
            return None
        return {
            "total_bytes": sum(u.total for u in usages),
            "used_bytes": sum(u.used for u in usages),
            "free_bytes": sum(u.free for u in usages),
        }

    # ── снимок для интерфейса ──

    def snapshot(self) -> dict:
        stats = index.volume_stats()
        internal_measured = internal_usage()

        with self._lock:
            target_id = self._target["volume_id"] if self._target else None
            volumes = []

            for e in self._data["volumes"]:
                internal = bool(e.get("internal"))
                mount = self._live.get(e["id"])
                usage = _usage(settings.INTERNAL_ROOT if internal else mount.path) if (internal or mount) else None
                stat = stats.get(e["id"], {})
                volumes.append({
                    "id": e["id"],
                    "internal": internal,
                    "name": self._name(e),
                    "custom_name": e.get("name", ""),
                    "enabled": e["enabled"],
                    "high": e["high"],
                    "low": e["low"],
                    "path": e.get("path"),
                    "state": "online" if internal else ("offline" if mount is None else ("readonly" if mount.readonly else "online")),
                    "writing": e["id"] == target_id,
                    "seen_ms": None if internal else e.get("seen_ms"),
                    "total_bytes": usage.total if usage else None,
                    "used_bytes": usage.used if usage else None,
                    "free_bytes": usage.free if usage else None,
                    "records_bytes": stat.get("bytes", 0),
                    "segment_count": stat.get("segment_count", 0),
                    "first_ms": stat.get("first_ms"),
                    "last_ms": stat.get("last_ms"),
                })

            return {
                "device_id": self._data.get("device_id"),
                "target": self._target,
                "volumes": volumes,
                "unsuitable": list(self._unsuitable),
                "summary": self._summary(volumes, internal_measured),
            }

    def _summary(self, volumes: list[dict], internal_measured) -> dict:
        connected = [v for v in volumes if v["state"] != "offline" and v["total_bytes"]]
        writing = next((v for v in volumes if v["writing"]), None)

        state = "ok"
        ring = self._write_set()
        if ring:
            percents = [_percent(m.path) for _e, m in ring]
            if writing and writing["total_bytes"] and writing["used_bytes"] / writing["total_bytes"] * 100 >= STUCK_PERCENT:
                state = "stuck"
            elif all(p is not None and p >= e["high"] for (e, _m), p in zip(ring, percents)):
                state = "ring"
        elif internal_measured is not None:
            total = internal_measured["total"]
            percent = internal_measured["used"] / total * 100 if total else 0.0
            if percent >= STUCK_PERCENT:
                state = "stuck"
            elif percent >= self._internal()["high"]:
                state = "ring"

        return {
            "state": state,
            "total_bytes": sum(v["total_bytes"] for v in connected),
            "used_bytes": sum(v["used_bytes"] for v in connected),
            "free_bytes": sum(v["free_bytes"] for v in connected),
            "records_bytes": sum(v["records_bytes"] for v in connected),
            "journal_bytes": internal_measured["journal_bytes"] if internal_measured else 0,
            "journal_reserve_bytes": internal_measured["journal_reserve_bytes"] if internal_measured else 0,
            "disk_count": sum(1 for v in connected if not v["internal"]),
            "writing": writing["name"] if writing else None,
            "offline": [v["name"] for v in volumes if v["state"] == "offline"],
        }

    # ── правка пула ──

    def update(self, volume_id: str, patch: dict) -> None:
        with self._lock:
            entry = self._entry(volume_id)
            if entry is None:
                raise KeyError(volume_id)

            if entry.get("internal") and ("name" in patch or "enabled" in patch):
                raise ValueError("Internal volume cannot be renamed or disabled")

            high = float(patch.get("high", entry["high"]))
            low = float(patch.get("low", entry["low"]))
            if not MIN_HIGH <= high <= MAX_HIGH:
                raise ValueError(f"high must be within {MIN_HIGH:g}..{MAX_HIGH:g}")
            if not 0 < low <= high - MIN_GAP:
                raise ValueError(f"low must be positive and at least {MIN_GAP:g} below high")

            if "name" in patch:
                entry["name"] = str(patch["name"] or "").strip()[:64]
            if "enabled" in patch:
                entry["enabled"] = bool(patch["enabled"])
            entry["high"], entry["low"] = high, low

            self._save()
            self._publish()
            self._choose_target()

    def reorder(self, ids: list[str]) -> None:
        with self._lock:
            externals = self._externals()
            if sorted(ids) != sorted(e["id"] for e in externals):
                raise ValueError("ids must list every external volume exactly once")
            by_id = {e["id"]: e for e in externals}
            self._data["volumes"] = [self._internal()] + [by_id[i] for i in ids]
            self._save()
            self._choose_target()

    def forget(self, volume_id: str) -> int:
        with self._lock:
            entry = self._entry(volume_id)
            if entry is None:
                raise KeyError(volume_id)
            if entry.get("internal") or volume_id in self._live:
                raise ValueError("Only a detached external volume can be forgotten")
            self._data["volumes"].remove(entry)
            self._save()
            self._publish()

        removed = index.forget_volume(volume_id)
        logger.warning("Volume %s forgotten, %d segment rows removed", volume_id, removed)
        return removed

    def _foreign_root(self, volume_id: str) -> tuple[Path, str]:
        with self._lock:
            mount = self._live.get(volume_id)
            device_id = self._data.get("device_id")
        if mount is None:
            raise ValueError("Volume is not attached")
        if not device_id:
            raise ValueError("Device id is unknown yet")
        return Path(mount.path, DEVICES_DIR), device_id

    def foreign(self, volume_id: str) -> list[dict]:
        root, own = self._foreign_root(volume_id)
        if not root.is_dir():
            return []
        return [
            {"device_id": entry.name, "bytes": _dir_size(Path(entry.path))}
            for entry in sorted(os.scandir(root), key=lambda e: e.name)
            if entry.is_dir(follow_symlinks=False) and entry.name != own
        ]

    def clear_foreign(self, volume_id: str, device_id: str) -> None:
        root, own = self._foreign_root(volume_id)
        if device_id == own or not device_id or "/" in device_id or device_id.startswith("."):
            raise ValueError("Not a foreign device archive")
        target = root / device_id
        if not target.is_dir():
            raise KeyError(device_id)
        shutil.rmtree(target)
        logger.warning("Foreign archive of device %s removed from volume %s", device_id, volume_id)

    # ── фоновый опрос ──

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        with self._lock:
            self._load()
            self._ensure_internal()
        # Первый опрос до сверки и чистки: им нужен вид пула
        try:
            await loop.run_in_executor(None, self.tick)
        except Exception:
            logger.exception("Initial volume pool tick failed")
        logger.info(
            "Volume pool started: media=%s, write target=%s, interval=%ss",
            settings.MEDIA_ROOT, settings.WRITE_TARGET_PATH, settings.POOL_INTERVAL_SEC,
        )
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            await self._task

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=settings.POOL_INTERVAL_SEC)
            except asyncio.TimeoutError:
                pass
            if self._stop.is_set():
                break
            try:
                await loop.run_in_executor(None, self.tick)
            except Exception:
                logger.exception("Volume pool tick failed")


pool = VolumePool(Path(settings.POOL_PATH))
