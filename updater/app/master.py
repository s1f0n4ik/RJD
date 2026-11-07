from __future__ import annotations

import copy
import logging
import shutil
import threading
import time
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Optional

from app import package
from app.common import Config, StepError, fmt_size, read_json, release_key, release_label, write_json
from app.web import Cancelled, HttpError, Request, Routes, Unreachable, call, put_file

logger = logging.getLogger(__name__)
# Фазы, в которых система занята обновлением: мастер запрещает смену профиля и запись паспорта
BUSY = ("delivery", "install", "master", "rollback")
STEPS = ("delivery", "install", "master", "check")
STARTED = ("run", "ok", "fail")
OLDER = "Файл не новее установленной версии"
OP_TEXT = {"prepare": "доставки", "install": "установки", "restore": "отката", "discard": "удаления файлов"}


class BoardLost(StepError):
    pass


class Aborted(Exception):
    pass


def _check(level: str, title: str, detail: str = "") -> dict:
    return {"level": level, "title": title, "detail": detail}


def _minutes(seconds: float) -> str:
    return f"{max(1, round(seconds / 60))} мин"


# Обновление всей системы: файл, проверки, раскатка по платам, общий откат и возврат пропавших плат
class Master:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.lock = threading.RLock()
        self.upload_dir = cfg.state_dir / "upload"
        self.rollout_file = cfg.state_dir / "rollout.json"
        self.pending_file = cfg.state_dir / "pending.json"
        self.file = read_json(self.upload_dir / "file.json")
        self.rollout = read_json(self.rollout_file)
        # Платы, пропавшие во время установки: вернутся на прежнюю версию, когда появятся
        self.pending: dict = read_json(self.pending_file) or {}
        self.uploading = False
        self.cancel = threading.Event()
        self.abort = threading.Event()
        self.restorer: Optional[threading.Thread] = None
        self.worker: Optional[threading.Thread] = None
        self._resume()

    def routes(self) -> Routes:
        return {
            ("GET", "/state"): self.state,
            ("GET", "/lock"): self.lock_state,
            ("PUT", "/file"): self.upload,
            ("DELETE", "/file"): self.remove_file,
            ("POST", "/start"): self.start,
            ("POST", "/cancel"): self.cancel_update,
            ("POST", "/revert"): self.revert,
            ("GET", "/board-log"): self.board_log,
        }

    def lock_state(self, request: Optional[Request] = None) -> dict:
        # Для блокировок мастера и плашки в верхней панели: без опроса плат
        with self.lock:
            rollout = self.rollout or {}
            return {"busy": self.busy(), "phase": rollout.get("phase"), "kind": rollout.get("kind")}

    def busy(self) -> bool:
        # Поток раскатки ещё рассылает завершение платам после done: новый запуск подождёт его
        with self.lock:
            return bool(self.rollout) and self.rollout.get("phase") in BUSY or bool(self.worker and self.worker.is_alive())

    # ── Платы ──

    def registry(self) -> list[dict]:
        devices = (read_json(self.cfg.devices_file()) or {}).get("devices") or []
        return [{"id": d["id"], "ip": d.get("ip") or "", "name": d.get("name") or d["id"]}
                for d in devices if isinstance(d, dict) and d.get("id")]

    def mc_alive(self, ip: str) -> bool:
        try:
            call("GET", f"http://{ip}:{self.cfg.mc_port}/system/info", timeout=2)
            return True
        except (Unreachable, HttpError):
            return False

    def probe(self, device: dict) -> dict:
        board = {**device, "online": False, "updater": False, "roles": [], "versions": {}, "prevs": {},
                 "op": None, "disk": None, "updater_version": None}
        try:
            status = call("GET", self.cfg.board_url(device["ip"], False) + "/status", timeout=3)
            board.update(online=True, updater=True, roles=status.get("roles") or [], versions=status.get("versions") or {},
                         prevs=status.get("prev") or {}, op=status.get("op"), disk=status.get("disk"),
                         updater_version=status.get("updater"))
        except (Unreachable, HttpError):
            board["online"] = self.mc_alive(device["ip"])
        board["master"] = "master" in board["roles"]
        board["url"] = self.cfg.board_url(device["ip"], board["master"])
        board["version"] = board["versions"].get("minion") or board["versions"].get("master")
        board["prev"] = board["prevs"].get("minion") or board["prevs"].get("master")
        return board

    def poll(self) -> list[dict]:
        devices = self.registry()
        if not devices:
            return []
        with ThreadPoolExecutor(max_workers=min(16, len(devices))) as pool:
            return list(pool.map(self.probe, devices))

    @staticmethod
    def system(boards: list[dict]) -> dict:
        master = next((b for b in boards if b["master"]), None) or {}
        version, prev = master.get("version"), master.get("prev")
        return {"version": version, "label": release_label(version), "prev": prev, "prev_label": release_label(prev) if prev else None}

    @staticmethod
    def _board_view(board: dict) -> dict:
        view = {key: board[key] for key in ("id", "name", "ip", "online", "updater", "master", "roles", "version", "prev")}
        return {**view, "label": release_label(board["version"]) if board["updater"] else None,
                "busy": (board["op"] or {}).get("state") == "running"}

    # ── Состояние для экрана ──

    def state(self, request: Optional[Request] = None) -> dict:
        boards = self.poll()
        with self.lock:
            busy = self.busy()
            info = self.file
            rollout = copy.deepcopy(self.rollout)
            for row in (rollout or {}).get("boards") or []:
                row.pop("url", None)
            pending = [{"id": key, "name": item["name"]} for key, item in self.pending.items()]
            result = {"system": self.system(boards), "boards": [self._board_view(b) for b in boards],
                      "file": self._file_view(info), "rollout": rollout, "pending": pending,
                      "busy": busy, "uploading": self.uploading, "now": time.time()}
        result["checks"] = self.checks(boards) if info and not busy else []
        return result

    @staticmethod
    def _file_view(info: Optional[dict]) -> Optional[dict]:
        if not info:
            return None
        manifest = info["manifest"]
        components = manifest.get("components") or []
        base = manifest["base"] or None
        return {"name": info.get("name") or "", "size": info["size"], "size_label": fmt_size(info["size"]),
                "uploaded": info["uploaded"], "tag": manifest["tag"], "label": release_label(manifest["tag"]),
                "base": base, "base_label": release_label(base) if base else None, "kind": "delta" if base else "full",
                "changed": sum(1 for c in components if c.get("changed")), "total": len(components)}

    def _transition(self) -> Optional[dict]:
        try:
            status = call("GET", self.cfg.fastapi_url + "/api/config/status", timeout=3)
        except (Unreachable, HttpError):
            return _check("err", "Мастер не отвечает", "Не удалось проверить, идёт ли смена профиля.")
        transition = status.get("transition") or {}
        if transition and transition.get("phase") != "complete":
            return _check("err", "Идёт смена профиля", "Обновление можно запустить, когда смена профиля закончится.")
        return None

    def checks(self, boards: list[dict]) -> list[dict]:
        manifest = self.file["manifest"]
        base = manifest["base"]
        system = self.system(boards)
        online = [b for b in boards if b["online"]]
        ready = [b for b in online if b["updater"]]
        out = []
        if system["version"] and release_key(manifest["tag"]) <= release_key(system["version"]):
            out.append(_check("warn", OLDER, "Запуск попросит подтверждения"))
        if base:
            # Дельта от постоянной базы встаёт на базу и любой более новый выпуск: их неизменные слои совпадают с базой
            wrong = [b for b in ready if any(release_key(b["versions"].get(role)) < release_key(base) for role in b["roles"])]
            if wrong:
                names = ", ".join(f"«{b['name']}»" for b in wrong)
                versions = ", ".join(sorted({release_label(b["version"]) for b in wrong}))
                out.append(_check("err", "Дельта не подходит к этой системе",
                                  f"Файл собран от {release_label(base)}, а {names} на более старой версии {versions}. Нужен полный файл."))
            else:
                out.append(_check("ok", "Базовая версия подходит", f"Все платы в сети на {release_label(base)} или новее"))
        else:
            out.append(_check("ok", "Полный файл", "Подходит к любой версии плат"))
        missing = [b for b in online if not b["updater"]]
        for b in missing:
            out.append(_check("err", f"«{b['name']}» без службы обновления",
                              "Поставьте пакет на плату вручную через install.sh, после этого запуск откроется."))
        if not ready:
            out.append(_check("err", "Нет плат для обновления", "Ни одна плата не отвечает службой обновления."))
        elif not missing:
            out.append(_check("ok", "Служба обновления есть на всех платах в сети"))
        if ready and not any(b["master"] for b in ready):
            out.append(_check("err", "Плата мастера не найдена", "В реестре устройств нет платы, на которой установлена часть мастера."))
        for b in ready:
            if (b["op"] or {}).get("state") == "running":
                out.append(_check("err", f"«{b['name']}» занята", "На плате ещё идёт операция обновления или отката."))
        transition = self._transition()
        if transition:
            out.append(transition)
        # Упакованные части плюс распакованные образы — примерно вдвое больше файла
        need = {b["id"]: 2 * sum(p["size"] for p in package.parts_for(manifest, b["roles"])) for b in ready}
        short = [b for b in ready if b["disk"] and need[b["id"]] > b["disk"]["free"]]
        for b in short:
            out.append(_check("warn", f"Нужно {fmt_size(need[b['id']])} на «{b['name']}»",
                              "Архив освободит место по своим правилам: уйдут самые старые записи."))
        if ready and not short:
            out.append(_check("ok", "Места хватает", f"До {fmt_size(max(need.values()))} на плате, архив не затрагивается"))
        for b in boards:
            if not b["online"]:
                out.append(_check("skip", f"«{b['name']}» офлайн, будет пропущена", "Обновить её можно позже"))
        return out

    # ── Файл обновления ──

    def upload(self, request: Request) -> dict:
        with self.lock:
            if self.busy():
                raise HttpError(409, "An update is running")
            if self.uploading:
                raise HttpError(409, "Another file is being uploaded")
            self.uploading = True
        incoming = self.upload_dir / "incoming"
        try:
            if request.length <= 0:
                raise HttpError(411, "Content-Length is required")
            self.upload_dir.mkdir(parents=True, exist_ok=True)
            shutil.rmtree(incoming, ignore_errors=True)
            free = shutil.disk_usage(self.upload_dir).free
            if request.length > free:
                raise HttpError(507, f"Not enough disk space: the file takes {request.length} bytes, {free} free")
            try:
                manifest = package.unpack(request.read, incoming)
            except package.PackageError as e:
                raise HttpError(400, str(e)) from None
            info = {"name": urllib.parse.unquote(request.headers.get("X-File-Name") or ""), "size": request.length,
                    "uploaded": time.time(), "manifest": manifest}
            with self.lock:
                if self.busy():
                    raise HttpError(409, "An update is running")
                shutil.rmtree(self.upload_dir / "current", ignore_errors=True)
                incoming.rename(self.upload_dir / "current")
                write_json(self.upload_dir / "file.json", info)
                self.file = info
        finally:
            shutil.rmtree(incoming, ignore_errors=True)
            with self.lock:
                self.uploading = False
        logger.info(f"Update file {manifest['tag']} accepted ({request.length} bytes)")
        return self.state()

    def _drop_file(self) -> None:
        shutil.rmtree(self.upload_dir / "current", ignore_errors=True)
        (self.upload_dir / "file.json").unlink(missing_ok=True)
        self.file = None

    def remove_file(self, request: Request) -> dict:
        with self.lock:
            if self.busy():
                raise HttpError(409, "An update is running")
            self._drop_file()
        return self.state()

    def board_log(self, request: Request) -> dict:
        device = next((d for d in self.registry() if d["id"] == request.query.get("id")), None)
        if not device:
            raise HttpError(404, "Unknown board")
        try:
            return call("GET", self.cfg.board_url(device["ip"], False) + "/log", timeout=5)
        except Unreachable as e:
            raise HttpError(502, f"Board is unreachable: {e}") from None

    # ── Запуск ──

    def start(self, request: Request) -> dict:
        body = request.json()
        boards = self.poll()
        checks = self.checks(boards) if self.file else []
        with self.lock:
            if self.busy():
                raise HttpError(409, "An update is already running")
            if not self.file:
                raise HttpError(409, "No update file")
            if any(c["level"] == "err" for c in checks):
                raise HttpError(409, "Pre-start checks failed")
            if any(c["title"] == OLDER for c in checks) and not body.get("confirm"):
                raise HttpError(409, "Confirmation required: the file is not newer than the system")
            manifest = self.file["manifest"]
            roles = package.roles_of(manifest)
            self._begin("update", manifest["tag"], boards, lambda b: {role: manifest["tag"] for role in b["roles"] if role in roles})
        return self.state()

    def revert(self, request: Request) -> dict:
        boards = self.poll()
        transition = self._transition()
        with self.lock:
            if self.busy():
                raise HttpError(409, "An update is already running")
            ready = [b for b in boards if b["online"]]
            if any(not b["updater"] for b in ready):
                raise HttpError(409, "Some online boards have no update service")
            if transition:
                raise HttpError(409, "A profile transition is in progress or the master does not answer")
            if not any(b["master"] for b in ready):
                raise HttpError(409, "The master board is not found")
            missing = [b["name"] for b in ready if any(not b["prevs"].get(role) for role in b["roles"])]
            if missing:
                raise HttpError(409, f"No previous version on: {', '.join(missing)}")
            self._begin("revert", self.system(boards)["prev"], boards, lambda b: dict(b["prevs"]))
        return self.state()

    def cancel_update(self, request: Request) -> dict:
        with self.lock:
            if not self.rollout or self.rollout.get("phase") != "delivery":
                raise HttpError(409, "Cancel is possible only during delivery")
            self.cancel.set()
            self.abort.set()
        self._event("Отмена обновления по кнопке")
        return self.state()

    def _begin(self, kind: str, target: Optional[str], boards: list[dict], targets: Callable[[dict], dict]) -> None:
        system = self.system(boards)
        rows = []
        for b in boards:
            joined = b["online"] and b["updater"]
            steps = {"delivery": "wait" if kind == "update" else "na", "install": "wait",
                     "master": "wait" if b["master"] else "na", "check": "wait"}
            rows.append({"id": b["id"], "name": b["name"], "ip": b["ip"], "url": b["url"], "roles": b["roles"],
                         "master": b["master"], "skipped": not joined, "from": dict(b["versions"]) if joined else {},
                         "to": targets(b) if joined else {}, "steps": steps if joined else None,
                         "progress": None, "error": None, "lost": False})
        self.rollout = {"id": uuid.uuid4().hex, "kind": kind, "phase": "delivery" if kind == "update" else "install",
                        "target": target, "target_label": release_label(target), "from": system["version"],
                        "from_label": system["label"], "started": time.time(), "finished": None, "boards": rows, "events": []}
        self.cancel.clear()
        self.abort.clear()
        self._save()
        self.worker = threading.Thread(target=self._run, daemon=True)
        self.worker.start()

    # ── Ход обновления ──

    def _save(self) -> None:
        write_json(self.rollout_file, self.rollout)

    def _event(self, text: str, level: str = "") -> None:
        logger.info(text)
        with self.lock:
            self.rollout["events"].append({"t": time.time(), "text": text, "level": level})
            self._save()

    def _step(self, row: dict, step: str, value: str) -> None:
        with self.lock:
            row["steps"][step] = value
            self._save()

    def _phase(self, phase: str, finished: bool = False) -> None:
        with self.lock:
            self.rollout["phase"] = phase
            if finished:
                self.rollout["finished"] = time.time()
            self._save()

    def _participants(self) -> list[dict]:
        return [row for row in self.rollout["boards"] if not row["skipped"]]

    def _run(self) -> None:
        try:
            if self.rollout["kind"] == "update":
                self._run_update()
            else:
                self._event(f"Возврат на предыдущую версию {self.rollout['target_label']} по кнопке", "run")
                self._skipped()
                self._install_all()
        except Exception as e:
            logger.exception("Rollout failed")
            self._event(f"Внутренняя ошибка службы обновления: {e}", "err")
            if self.rollout["phase"] in ("install", "master"):
                self._rollback()
            elif self.rollout["phase"] in BUSY:
                self._phase("failed", True)

    def _skipped(self) -> None:
        for row in self.rollout["boards"]:
            if row["skipped"]:
                self._event(f"«{row['name']}» офлайн, пропущена")

    def _run_update(self) -> None:
        rows = self._participants()
        self._event(f"Запуск обновления до {self.rollout['target_label']}", "run")
        self._skipped()
        delivered = self._parallel(self._deliver, rows)
        with self.lock:
            cancelled = self.cancel.is_set()
            if delivered and not cancelled:
                self.rollout["phase"] = "install"
                self._save()
        if cancelled or not delivered:
            self._parallel(self._discard, rows)
            if cancelled:
                self._event("Обновление отменено, доставленные файлы удалены")
                self._phase("cancelled", True)
            else:
                self._event("Доставка не удалась, на платах ничего не изменилось", "err")
                self._phase("failed", True)
            return
        if self._install_all():
            # Своя плата последней и без ожидания: самообновление перезапустит и эту службу
            for row in sorted(rows, key=lambda r: r["master"]):
                try:
                    call("POST", row["url"] + "/finish", {}, timeout=15)
                    if not row["master"]:
                        self._wait_op(row, "finish", 120)
                except (StepError, Unreachable, HttpError) as e:
                    logger.warning(f"Finish on {row['id']} failed: {e}")

    def _install_all(self) -> bool:
        rows = self._participants()
        update = self.rollout["kind"] == "update"
        self._phase("install")
        self._event(f"{'Установка' if update else 'Возврат'} на платах: {len(rows)}", "run")
        if not self._parallel(lambda row: self._install(row, "minion"), rows):
            self._rollback()
            return False
        master = [row for row in rows if row["master"] and row["to"].get("master")]
        if master:
            self._phase("master")
            self._event("Часть мастера: перезапуск служб, связь пропадёт на несколько секунд", "run")
            if not self._parallel(lambda row: self._install(row, "master"), master):
                self._rollback()
                return False
        label = self.rollout["target_label"]
        with self.lock:
            self._event(f"Все платы прошли проверку, система на {label}" if update else f"Все платы в сети на {label}", "ok")
            if update:
                self._drop_file()
            self._phase("done", True)
        return True

    def _parallel(self, fn: Callable[[dict], None], rows: list[dict]) -> bool:
        if not rows:
            return True
        with ThreadPoolExecutor(max_workers=len(rows)) as pool:
            return all(list(pool.map(lambda row: self._guarded(fn, row), rows)))

    def _guarded(self, fn: Callable[[dict], None], row: dict) -> bool:
        try:
            fn(row)
            return True
        except (Cancelled, Aborted):
            return False
        except StepError as e:
            self._fail(row, str(e), isinstance(e, BoardLost))
        except Exception as e:
            logger.exception(f"Step failed on {row['id']}")
            self._fail(row, f"внутренняя ошибка службы: {e}", False)
        return False

    def _fail(self, row: dict, reason: str, lost: bool) -> None:
        with self.lock:
            for step in STEPS:
                if row["steps"][step] == "run":
                    row["steps"][step] = "fail"
            row.update(error=reason, lost=lost)
            self._save()
        self._event(f"«{row['name']}»: {reason}", "err")
        self.abort.set()

    def _call(self, row: dict, method: str, path: str, body: Optional[dict] = None, wait_idle: float = 0) -> dict:
        # wait_idle: сколько ждать, пока плата закончит прежнюю операцию (ответ 409)
        deadline = time.monotonic() + wait_idle
        while True:
            try:
                return call(method, row["url"] + path, body, timeout=15)
            except Unreachable as e:
                raise BoardLost(f"нет связи с платой: {e}") from None
            except HttpError as e:
                if e.status != 409 or time.monotonic() > deadline:
                    raise StepError(f"плата отказала: {e}") from None
            time.sleep(self.cfg.poll_every)

    def _wait_op(self, row: dict, name: str, timeout: float, interruptible: bool = False) -> None:
        deadline = time.monotonic() + timeout
        seen = time.monotonic()
        while True:
            if interruptible and self.cancel.is_set():
                raise Cancelled()
            if interruptible and self.abort.is_set():
                raise Aborted()
            now = time.monotonic()
            try:
                op = call("GET", row["url"] + "/status", timeout=3).get("op") or {}
                seen = now
                if op.get("op") != name:
                    raise StepError(f"плата выполняет другую операцию: {op.get('op')}")
                if op.get("state") == "ok":
                    return
                if op.get("state") == "failed":
                    raise StepError(op.get("error") or f"сбой {OP_TEXT.get(name, name)}")
            except (Unreachable, HttpError):
                if now - seen > self.cfg.lost_after:
                    raise BoardLost(f"связь пропала во время {OP_TEXT.get(name, name)}") from None
            if now > deadline:
                raise StepError(f"{OP_TEXT.get(name, name).capitalize()} не закончилась за {_minutes(timeout)}")
            time.sleep(self.cfg.poll_every)

    def _deliver(self, row: dict) -> None:
        manifest = self.file["manifest"]
        self._step(row, "delivery", "run")
        reply = self._call(row, "PUT", "/package", {"manifest": manifest}, wait_idle=60)
        sizes = {part["path"]: part["size"] for part in manifest["parts"]}
        paths = [path for path in reply.get("parts") or [] if path in sizes]
        with self.lock:
            row["progress"] = {"sent": 0, "total": sum(sizes[path] for path in paths)}

        def sent(count: int) -> None:
            if self.abort.is_set() and not self.cancel.is_set():
                raise Aborted()
            with self.lock:
                row["progress"]["sent"] += count

        for path in paths:
            url = f"{row['url']}/package/part?path={urllib.parse.quote(path, safe='')}"
            try:
                put_file(url, self.upload_dir / "current" / path, sent, self.cancel)
            except Unreachable as e:
                raise BoardLost(f"связь пропала во время доставки: {e}") from None
            except HttpError as e:
                raise StepError(f"плата отвергла {path}: {e}") from None
        self._call(row, "POST", "/package/prepare", {})
        self._wait_op(row, "prepare", 1800, interruptible=True)
        self._step(row, "delivery", "ok")
        self._event(f"«{row['name']}»: файл доставлен", "ok")

    def _install(self, row: dict, role: str) -> None:
        update = self.rollout["kind"] == "update"
        tag = row["to"].get(role)
        if not tag:
            return
        step = "master" if role == "master" else "install"
        self._step(row, step, "run")
        if update:
            self._call(row, "POST", "/install", {"roles": [role]})
        else:
            self._call(row, "POST", "/restore", {"to": {role: tag}, "fresh": role == "minion"})
        self._wait_op(row, "install" if update else "restore", 1800)
        word = "установлена" if update else "возвращена"
        if role == "master":
            self._step(row, "master", "ok")
            self._step(row, "check", "run")
            self._wait_health(row, ["minion", "master"], config=True)
            self._step(row, "check", "ok")
        elif row["master"]:
            self._wait_health(row, ["minion"])
            self._step(row, "install", "ok")
            self._event(f"«{row['name']}»: {word}")
        else:
            self._step(row, "install", "ok")
            self._step(row, "check", "run")
            self._event(f"«{row['name']}»: {word}, идёт проверка")
            self._wait_health(row, ["minion"])
            self._step(row, "check", "ok")

    def _wait_health(self, row: dict, roles: list[str], config: bool = False) -> None:
        deadline = time.monotonic() + self.cfg.health_timeout
        seen = time.monotonic()
        reason = "проверка не пройдена"
        while True:
            if self.abort.is_set():
                raise Aborted()
            now = time.monotonic()
            try:
                health = call("GET", row["url"] + "/status?health=1", timeout=10).get("health") or {}
                seen = now
                containers = health.get("containers") or {}
                pending = [name for role in roles for name in containers.get(role, [f"часть {role}"])]
                if pending:
                    reason = f"не поднялись контейнеры за {_minutes(self.cfg.health_timeout)}: {', '.join(pending)}"
                elif not health.get("mc"):
                    reason = f"ядро не ответило за {_minutes(self.cfg.health_timeout)}"
                elif not config:
                    return
                else:
                    problem = self._config_problem()
                    if not problem:
                        return
                    reason = problem
            except (Unreachable, HttpError):
                if now - seen > self.cfg.lost_after:
                    raise BoardLost("связь пропала во время проверки") from None
            if now > deadline:
                raise StepError(reason)
            time.sleep(self.cfg.poll_every)

    def _config_problem(self) -> Optional[str]:
        # Применение конфигурации мастера: снимок запуска без смены профиля и без сбоев уровня платы
        try:
            snapshot = call("GET", self.cfg.fastapi_url + "/api/config/runtime", timeout=15)
        except (Unreachable, HttpError):
            return f"мастер не ответил за {_minutes(self.cfg.health_timeout)}"
        transition = snapshot.get("transition") or {}
        if transition and transition.get("phase") != "complete":
            return "конфигурация не применена: идёт смена профиля"
        names = {row["id"]: row["name"] for row in self._participants()}
        bad = sorted({names[p["device"]] for p in (snapshot.get("summary") or {}).get("problems") or []
                      if p.get("kind") == "device" and p.get("device") in names})
        return f"конфигурация не применена: {', '.join(bad)}" if bad else None

    # ── Откат ──

    def _discard(self, row: dict) -> None:
        try:
            reply = self._call(row, "DELETE", "/package", wait_idle=1800)
            if reply.get("op"):
                self._wait_op(row, "discard", 600)
        except StepError as e:
            logger.warning(f"Discard on {row['id']} failed: {e}")

    @staticmethod
    def _restore_targets(row: dict) -> dict:
        roles = [role for role, step in (("minion", "install"), ("master", "master")) if row["steps"][step] in STARTED]
        return {role: row["from"][role] for role in roles if row["from"].get(role)}

    def _restore(self, row: dict) -> None:
        targets = self._restore_targets(row)
        if targets:
            self._call(row, "POST", "/restore", {"to": targets}, wait_idle=1800)
            self._wait_op(row, "restore", 1800)
            with self.lock:
                if not row["error"]:
                    for step in ("install", "master"):
                        if row["steps"][step] in ("run", "ok"):
                            row["steps"][step] = "back"
                    if row["steps"]["check"] in ("run", "ok"):
                        row["steps"]["check"] = "wait"
                self._save()
        self._discard(row)

    def _rollback(self) -> None:
        self._phase("rollback")
        label = self.rollout["from_label"]
        self._event(f"Общий откат на {label}", "back")
        rows = self._participants()

        def restore(row: dict) -> None:
            if row["lost"]:
                return
            try:
                self._restore(row)
            except BoardLost:
                with self.lock:
                    row["lost"] = True
            except StepError as e:
                self._event(f"«{row['name']}»: откат не удался: {e}", "err")

        with ThreadPoolExecutor(max_workers=max(1, len(rows))) as pool:
            list(pool.map(restore, rows))
        lost = [row for row in rows if row["lost"]]
        with self.lock:
            for row in lost:
                self.pending[row["id"]] = {"name": row["name"], "url": row["url"], "to": self._restore_targets(row),
                                           "label": label}
            write_json(self.pending_file, self.pending)
        if lost:
            names = ", ".join(f"«{row['name']}»" for row in lost)
            self._event(f"Платы в сети возвращены на {label}, {names} вернётся сама, когда появится в сети", "back")
        else:
            self._event(f"Все платы в сети возвращены на {label}", "back")
        self._phase("rolled_back", True)
        self._ensure_restorer()

    def _ensure_restorer(self) -> None:
        with self.lock:
            if self.pending and not (self.restorer and self.restorer.is_alive()):
                self.restorer = threading.Thread(target=self._restore_pending, daemon=True)
                self.restorer.start()

    def _restore_pending(self) -> None:
        while True:
            with self.lock:
                items = dict(self.pending)
            if not items:
                return
            for device_id, item in items.items():
                row = {"id": device_id, "url": item["url"]}
                try:
                    op = call("GET", item["url"] + "/status", timeout=3).get("op") or {}
                    if op.get("state") == "running":
                        continue
                    if item["to"]:
                        call("POST", item["url"] + "/restore", {"to": item["to"]}, timeout=15)
                        self._wait_op(row, "restore", 1800)
                    reply = call("DELETE", item["url"] + "/package", timeout=15)
                    if reply.get("op"):
                        self._wait_op(row, "discard", 600)
                except (StepError, Unreachable, HttpError) as e:
                    logger.info(f"Pending restore of {device_id} not done yet: {e}")
                    continue
                with self.lock:
                    self.pending.pop(device_id, None)
                    write_json(self.pending_file, self.pending)
                    for board in (self.rollout or {}).get("boards") or []:
                        if board["id"] == device_id:
                            board["lost"] = False
                if self.rollout:
                    self._event(f"«{item['name']}» снова в сети и возвращена на {item['label']}", "back")
            time.sleep(self.cfg.poll_every * 10)

    def _resume(self) -> None:
        phase = (self.rollout or {}).get("phase")
        if phase in BUSY:
            def resume() -> None:
                if phase == "delivery":
                    self._parallel(self._discard, self._participants())
                    self._event("Служба обновления перезапустилась, доставка прервана, на платах ничего не изменилось", "err")
                    self._phase("failed", True)
                else:
                    self._event("Служба обновления перезапустилась во время установки", "err")
                    self._rollback()

            self.worker = threading.Thread(target=resume, daemon=True)
            self.worker.start()
        self._ensure_restorer()
