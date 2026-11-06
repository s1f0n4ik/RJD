from __future__ import annotations

import logging
import re
import shutil
import threading
import time
import urllib.request
from pathlib import Path
from typing import Callable, Optional

from app import package
from app.common import ROLES, Config, OpLog, Runner, StepError, fmt_size, read_env, read_json, read_text, release_label, write_json
from app.web import HttpError, Request, Routes

logger = logging.getLogger(__name__)
ROLE_TEXT = {"minion": "исполнителя", "master": "мастера"}
# install.sh и rollback.sh в этом режиме ничего не спрашивают
UNATTENDED = {"VARAN_UNATTENDED": "1"}


def _healthy(status: str) -> bool:
    return status.startswith("Up") and "(unhealthy)" not in status and "(health: starting)" not in status


# Служба на плате: приём файла, установка и откат по командам мастера
class Minion:
    def __init__(self, cfg: Config, run: Optional[Runner] = None):
        self.cfg = cfg
        self.run = run or Runner()
        self.lock = threading.Lock()
        self.package_dir = cfg.state_dir / "package"
        self.state_file = cfg.state_dir / "minion.json"
        self.log = OpLog(cfg.state_dir / "board.log")
        self.op = read_json(self.state_file) or {}
        # Сколько частей принимается прямо сейчас: пока идёт приём, остальные операции ждут
        self.receiving = 0
        if self.op.get("state") == "running":
            self.op.update(state="failed", error="операция прервана перезапуском службы", finished=time.time())
            write_json(self.state_file, self.op)

    def routes(self) -> Routes:
        return {
            ("GET", "/status"): self.status,
            ("GET", "/log"): lambda request: {"lines": self.log.lines()},
            ("PUT", "/package"): self.begin,
            ("PUT", "/package/part"): self.put_part,
            ("POST", "/package/prepare"): self.prepare,
            ("DELETE", "/package"): self.discard,
            ("POST", "/install"): self.install,
            ("POST", "/restore"): self.restore,
            ("POST", "/finish"): self.finish,
        }

    # ── Сведения о плате ──

    def roles(self) -> list[str]:
        return [role for role in ROLES if (self.cfg.role_dir(role) / ".env").is_file()]

    def master_ip(self) -> Optional[str]:
        # Адрес мастера уже записан во флагах ядра: туда плата шлёт обнаружения
        match = re.search(r"--detection-ip[= ]([^\s'\"]+)", read_text(self.cfg.mc_defaults))
        return match.group(1) if match else None

    def _allow(self, request: Request) -> None:
        if request.client not in ("127.0.0.1", "::1") and request.client != self.master_ip():
            raise HttpError(403, f"Commands are accepted only from the master ({self.master_ip() or 'unknown'}), not {request.client}")

    def mc_alive(self) -> bool:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.cfg.mc_port}/system/info", timeout=2) as response:
                return response.status == 200
        except OSError:
            return False

    def health(self, roles: list[str]) -> dict:
        code, out = self.run.capture(["docker", "ps", "--format", "{{.Names}}\t{{.Status}}"])
        running = dict(line.split("\t", 1) for line in out.splitlines() if "\t" in line) if code == 0 else {}
        containers = {}
        for role in roles:
            names = re.findall(r"^\s*container_name:\s*(\S+)", read_text(self.cfg.role_dir(role) / "docker-compose.yml"), re.M)
            containers[role] = [name for name in names if not _healthy(running.get(name, ""))]
        return {"containers": containers, "mc": self.mc_alive()}

    def status(self, request: Request) -> dict:
        roles = self.roles()
        manifest = read_json(self.package_dir / "manifest.json")
        usage = shutil.disk_usage(self.cfg.state_dir)
        result = {
            "updater": self.cfg.version,
            "roles": roles,
            "versions": {role: read_env(self.cfg.role_dir(role) / ".env", "TAG") or None for role in roles},
            "prev": {role: read_env(self.cfg.role_dir(role) / ".env", "PREV_TAG") or None for role in roles},
            "op": dict(self.op) or None,
            "staged": (manifest or {}).get("tag"),
            "master_ip": self.master_ip(),
            "disk": {"free": usage.free, "total": usage.total},
        }
        if request.query.get("health"):
            result["health"] = self.health(roles)
        return result

    # ── Операции: выполняются в фоне, мастер следит за ними через /status ──

    def _idle(self) -> None:
        if self.op.get("state") == "running":
            raise HttpError(409, f"Operation {self.op.get('op')} is running")
        if self.receiving:
            raise HttpError(409, "A part is being received")

    def _start(self, name: str, tag: Optional[str], work: Callable[[], None], fresh: bool = False) -> dict:
        with self.lock:
            self._idle()
            if fresh:
                self.log.reset()
            self.op = {"op": name, "tag": tag, "state": "running", "error": None, "started": time.time(), "finished": None}
            write_json(self.state_file, self.op)
        threading.Thread(target=self._work, args=(work,), daemon=True).start()
        return dict(self.op)

    def _work(self, work: Callable[[], None]) -> None:
        error = None
        try:
            work()
        except StepError as e:
            error = str(e)
        except Exception as e:
            logger.exception("Operation failed")
            error = f"внутренняя ошибка службы: {e}"
        if error:
            self.log.write(f"ошибка: {error}")
        with self.lock:
            self.op.update(state="failed" if error else "ok", error=error, finished=time.time())
            write_json(self.state_file, self.op)

    def _script(self, script: Path, args: list[str], title: str) -> None:
        self.log.write(title)
        if not script.is_file():
            raise StepError(f"нет {script}")
        code = self.run(["bash", str(script), *args], self.log.write, UNATTENDED)
        if code != 0:
            raise StepError(f"{script.name} {' '.join(args)} завершился с кодом {code}".replace("  ", " "))

    def _remove_package(self) -> None:
        # Повтор, пока каталог не исчезнет: файл может держать открытым соседний запрос /status
        for _ in range(50):
            shutil.rmtree(self.package_dir, ignore_errors=True)
            if not self.package_dir.exists():
                return
            time.sleep(0.1)
        raise StepError(f"не удалось удалить {self.package_dir}")

    def _staged(self) -> dict:
        manifest = read_json(self.package_dir / "manifest.json")
        if not manifest:
            raise HttpError(409, "No update package on this board")
        return manifest

    def _package_roles(self, manifest: dict) -> list[str]:
        return [role for role in self.roles() if role in package.roles_of(manifest)]

    # ── Доставка ──

    def begin(self, request: Request) -> dict:
        self._allow(request)
        try:
            manifest = package.check_manifest(request.json().get("manifest"))
        except package.PackageError as e:
            raise HttpError(400, str(e)) from None
        with self.lock:
            self._idle()
            self._remove_package()
            self.package_dir.mkdir(parents=True)
            write_json(self.package_dir / "manifest.json", manifest)
            self.log.reset()
        self.log.write(f"приём выпуска {manifest['tag']} ({release_label(manifest['tag'])}), роли платы: {', '.join(self.roles()) or 'нет'}")
        return {"parts": [part["path"] for part in package.parts_for(manifest, self.roles())]}

    def put_part(self, request: Request) -> dict:
        self._allow(request)
        path = request.query.get("path", "")
        # Пакет проверяется под той же блокировкой, что и удаление: иначе приём воскресит удалённый каталог
        with self.lock:
            manifest = self._staged()
            part = next((p for p in package.parts_for(manifest, self.roles()) if p["path"] == path), None)
            if part is None:
                raise HttpError(400, f"Part {path!r} is not expected on this board")
            if self.op.get("state") == "running":
                raise HttpError(409, f"Operation {self.op.get('op')} is running")
            self.receiving += 1
        try:
            package.receive(request.read, request.length, self.package_dir / path, part)
        except package.PackageError as e:
            self.log.write(f"часть {path} отвергнута: {e}")
            raise HttpError(400, str(e)) from None
        finally:
            with self.lock:
                self.receiving -= 1
        self.log.write(f"получено {path}, {fmt_size(part['size'])}, sha256 совпадает")
        return {"ok": True}

    def prepare(self, request: Request) -> dict:
        self._allow(request)
        manifest = self._staged()
        missing = [p["path"] for p in package.parts_for(manifest, self.roles()) if not (self.package_dir / p["path"]).is_file()]
        if missing:
            raise HttpError(409, f"Parts not received: {', '.join(missing)}")

        # Подготовка ничего не останавливает: образы загружаются рядом с работающими, ядро проверяется во временном каталоге
        def work() -> None:
            for role in self._package_roles(manifest):
                self._script(self.package_dir / role / "install.sh", ["--prepare"], f"подготовка части {ROLE_TEXT[role]}")
            (self.package_dir / ".prepared").write_text(manifest["tag"], encoding="utf-8")

        return self._start("prepare", manifest["tag"], work)

    def discard(self, request: Request) -> dict:
        self._allow(request)
        manifest = read_json(self.package_dir / "manifest.json")
        if not manifest:
            with self.lock:
                self._idle()
            self._remove_package()
            return {"ok": True, "op": None}

        def work() -> None:
            if (self.package_dir / ".prepared").is_file():
                for role in self._package_roles(manifest):
                    self._script(self.package_dir / role / "install.sh", ["--discard"], f"удаление подготовленной части {ROLE_TEXT[role]}")
            self._remove_package()
            self.log.write("доставленные файлы удалены")

        return {"ok": True, "op": self._start("discard", manifest["tag"], work)}

    # ── Установка и откат ──

    def install(self, request: Request) -> dict:
        self._allow(request)
        manifest = self._staged()
        roles = request.json().get("roles") or []
        if not roles or any(role not in self._package_roles(manifest) for role in roles):
            raise HttpError(400, f"Roles {roles} are not in the package for this board")
        if not (self.package_dir / ".prepared").is_file():
            raise HttpError(409, "The package is not prepared")

        def work() -> None:
            for role in roles:
                self._script(self.package_dir / role / "install.sh", [], f"установка части {ROLE_TEXT[role]}")

        return self._start("install", manifest["tag"], work)

    def restore(self, request: Request) -> dict:
        self._allow(request)
        body = request.json()
        targets = body.get("to") or {}
        if not targets or any(role not in self.roles() or not isinstance(tag, str) or not tag for role, tag in targets.items()):
            raise HttpError(400, f"Bad restore targets: {targets}")

        def work() -> None:
            for role in (r for r in ROLES if r in targets):
                tag = targets[role]
                self._script(self.cfg.role_dir(role) / "rollback.sh", [f"--to={tag}"], f"возврат части {ROLE_TEXT[role]} на {tag} ({release_label(tag)})")

        return self._start("restore", targets.get("minion") or targets.get("master"), work, fresh=bool(body.get("fresh")))

    def finish(self, request: Request) -> dict:
        self._allow(request)
        manifest = read_json(self.package_dir / "manifest.json") or {}

        # Служба обновления ставится последней и отдельным юнитом: перезапуск своего юнита не должен оборвать dpkg
        def work() -> None:
            deb = self.package_dir / "updater.deb"
            upgrade = deb.is_file() and manifest.get("updater_version") not in (None, self.cfg.version)
            target = self.cfg.state_dir / "updater.deb"
            if upgrade:
                shutil.copyfile(deb, target)
            self._remove_package()
            self.log.write("файлы выпуска удалены")
            if upgrade:
                self.log.write(f"обновление службы обновления {self.cfg.version} -> {manifest['updater_version']}")
                unit = f"varan-updater-upgrade-{int(time.time())}"
                code = self.run(["systemd-run", f"--unit={unit}", "--collect", "dpkg", "-i", str(target)], self.log.write)
                if code != 0:
                    raise StepError(f"systemd-run завершился с кодом {code}")

        return self._start("finish", manifest.get("tag"), work)
