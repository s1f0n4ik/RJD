import hashlib
import io
import json
import os
import sys
import tarfile
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import package
from app.common import Config, fmt_size, read_env, release_key, release_label
from app.master import Master
from app.minion import Minion
from app.web import HttpError, call, put_file, serve

OLD = "2026-10-23-2495dda"
BASE = "2026-11-06-0900-4f2c9e1"
NEW = "2026-11-20-1430-a81b3f0"
NEWER = "2026-11-21-1000-b72c0d1"
NEWEST = "2026-11-22-0800-c00ffee"
LAST = "2026-11-23-0800-d00d00d"
CONTAINERS = {"minion": ["signaling-server", "storage-service"], "master": ["fastapi", "frontend"]}


def set_env(path: Path, key: str, value: str) -> None:
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if not line.startswith(key + "=")]
    path.write_text("\n".join(lines + [f"{key}={value}"]) + "\n", encoding="utf-8")


class FakeRunner:
    # install.sh и rollback.sh платы: меняют TAG/PREV_TAG так же, как настоящие скрипты
    def __init__(self, board: "Board"):
        self.board = board
        self.calls: list[list[str]] = []

    def __call__(self, cmd, log, env=None) -> int:
        self.calls.append(cmd)
        if cmd[0] == "systemd-run":
            return 0
        assert env == {"VARAN_UNATTENDED": "1"}, env
        script, args = Path(cmd[1]), cmd[2:]
        role = script.parent.name.replace("varan-", "")
        hook = self.board.hooks.get((script.name, args[0] if args else "", role))
        if hook and hook():
            return 1
        env_file = self.board.opt / f"varan-{role}" / ".env"
        current, prev = read_env(env_file, "TAG"), read_env(env_file, "PREV_TAG")
        if script.name == "install.sh" and not args:
            tag = json.loads((script.parents[1] / "manifest.json").read_text(encoding="utf-8"))["tag"]
            if current != tag:
                set_env(env_file, "PREV_TAG", current)
            set_env(env_file, "TAG", tag)
        elif script.name == "rollback.sh":
            target = args[0].split("=", 1)[1]
            if target == prev:
                set_env(env_file, "TAG", prev)
                set_env(env_file, "PREV_TAG", current)
            elif target != current:
                return 1
        log(f"fake {script.name} {' '.join(args)}")
        return 0

    def capture(self, cmd, timeout=20):
        lines = []
        for role, names in CONTAINERS.items():
            tag = read_env(self.board.opt / f"varan-{role}" / ".env", "TAG")
            state = "Up 1 minute (unhealthy)" if tag in self.board.unhealthy else "Up 1 minute (healthy)"
            lines += [f"{name}\t{state}" for name in names]
        return 0, "\n".join(lines)


class Board:
    def __init__(self, root: Path, name: str, roles: list[str]):
        self.dir = root / name
        self.opt = self.dir / "opt"
        for role in roles:
            (self.opt / f"varan-{role}").mkdir(parents=True)
            (self.opt / f"varan-{role}" / ".env").write_text(f"TAG={BASE}\nPREV_TAG={OLD}\n", encoding="utf-8")
            (self.opt / f"varan-{role}" / "rollback.sh").write_text("# подменяется FakeRunner\n", encoding="utf-8")
            compose = "services:\n" + "".join(f"  {n}:\n    container_name: {n}\n" for n in CONTAINERS[role])
            (self.opt / f"varan-{role}" / "docker-compose.yml").write_text(compose, encoding="utf-8")
        (self.dir / "media-center").write_text('MC_ARGS="--rest-port=7777 --detection-ip=127.0.0.1 --modules=neural"\n', encoding="utf-8")
        cfg = Config(state_dir=self.dir / "state", opt_dir=self.opt, mc_defaults=self.dir / "media-center")
        cfg.state_dir.mkdir(parents=True)
        self.mc = True
        self.unhealthy: set[str] = set()
        self.hooks: dict = {}
        self.runner = FakeRunner(self)
        self.minion = Minion(cfg, self.runner)
        self.minion.mc_alive = lambda: self.mc
        self.port = 0
        self.start()

    def start(self) -> None:
        self.server = serve(self.minion.routes(), "127.0.0.1", self.port)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def tag(self, role: str = "minion") -> str:
        return read_env(self.opt / f"varan-{role}" / ".env", "TAG")

    def prev(self, role: str = "minion") -> str:
        return read_env(self.opt / f"varan-{role}" / ".env", "PREV_TAG")

    def staged(self) -> bool:
        return (self.dir / "state" / "package").exists()


def make_file(path: Path, tag: str, base: str) -> Path:
    blobs = {}
    for role in ("minion", "master"):
        blobs[f"{role}/images.tar.gz"] = (role, os.urandom(3 * 1024 * 1024 + 17))
        for name in ("docker-compose.yml", ".env.example", "install.sh", "rollback.sh"):
            blobs[f"{role}/{name}"] = (role, f"{role} {name} {tag}\n".encode())
    blobs["media-center.deb"] = ("minion", os.urandom(4096))
    blobs["updater.deb"] = ("all", os.urandom(2048))
    manifest = {
        "format": 1, "tag": tag, "base": base, "updater_version": "1.0.0+test",
        "components": [{"name": "fastapi", "changed": True}, {"name": "frontend", "changed": False}, {"name": "media-center", "changed": True}],
        "parts": [{"path": p, "role": r, "size": len(b), "sha256": hashlib.sha256(b).hexdigest()} for p, (r, b) in blobs.items()],
    }
    with tarfile.open(path, "w") as archive:
        for name, data in [("manifest.json", json.dumps(manifest).encode())] + [(f"./{p}", b) for p, (_, b) in blobs.items()]:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return path


def wait(predicate, timeout: float = 30, what: str = ""):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


def clean(boards: list, what: str) -> None:
    try:
        wait(lambda: not any(b.staged() for b in boards), 10, what)
    except AssertionError:
        left = [b for b in boards if b.staged()]
        detail = [(b.dir.name, sorted(str(p.relative_to(b.dir)) for p in (b.dir / "state" / "package").rglob("*")), b.minion.op, b.minion.log.lines()[-4:]) for b in left]
        raise AssertionError(f"{what}: package left on {detail}") from None


def main() -> None:
    assert release_label(NEW) == "20 нояб. 2026, 14:30", release_label(NEW)
    assert release_label("2026-08-04-de316348") == "4 авг. 2026"
    assert release_label(None) == "нет версии"
    assert release_key(NEW) > release_key(BASE) > release_key(OLD)
    assert fmt_size(10_500_000) == "10,0 МБ" and fmt_size(1_200_000_000) == "1,12 ГБ"
    try:
        package.check_manifest({"format": 1, "tag": NEW, "base": "", "parts": [{"path": "../x", "role": "all", "size": 1, "sha256": "0" * 64}]})
        raise AssertionError("path traversal accepted")
    except package.PackageError:
        pass

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        b1 = Board(root, "b1", ["minion", "master"])
        b2 = Board(root, "b2", ["minion"])
        b3 = Board(root, "b3", ["minion"])
        boards = [b1, b2, b3]
        dead = serve({}, "127.0.0.1", 0)
        threading.Thread(target=dead.serve_forever, daemon=True).start()

        # Команды на плату принимаются только от адреса мастера из флагов ядра
        (b2.dir / "media-center").write_text('MC_ARGS="--detection-ip=10.0.0.1"\n', encoding="utf-8")
        b2.minion._allow(SimpleNamespace(client="10.0.0.1"))
        try:
            b2.minion._allow(SimpleNamespace(client="10.0.0.9"))
            raise AssertionError("foreign master accepted")
        except HttpError as e:
            assert e.status == 403
        (b2.dir / "media-center").write_text('MC_ARGS="--detection-ip=127.0.0.1"\n', encoding="utf-8")

        varan = root / "varan"
        (varan / "settings").mkdir(parents=True)
        set_env(b1.opt / "varan-master" / ".env", "VARAN_ROOT", str(varan))
        devices = [{"id": f"b{i}", "ip": f"10.0.0.{i}", "name": f"Плата {i}", "modules": []} for i in range(1, 5)]
        (varan / "settings" / "devices.json").write_text(json.dumps({"devices": devices, "routing": {}}), encoding="utf-8")
        urls = {f"10.0.0.{i}": f"http://127.0.0.1:{b.port}" for i, b in enumerate(boards, 1)}
        urls["10.0.0.4"] = f"http://127.0.0.1:{dead.server_address[1]}"

        fastapi = {"transition": None, "problems": []}
        api = serve({
            ("GET", "/api/config/status"): lambda r: {"devices": [], "transition": fastapi["transition"]},
            ("GET", "/api/config/runtime"): lambda r: {"transition": fastapi["transition"], "summary": {"state": "ok", "problems": fastapi["problems"]}},
        }, "127.0.0.1", 0)
        threading.Thread(target=api.serve_forever, daemon=True).start()

        cfg = Config(state_dir=root / "master-state", opt_dir=b1.opt, fastapi_url=f"http://127.0.0.1:{api.server_address[1]}",
                     health_timeout=3, lost_after=1.5, poll_every=0.05,
                     board_url_override=lambda ip, local: urls[ip])
        cfg.state_dir.mkdir()
        master = Master(cfg)
        mc_online = set()
        master.mc_alive = lambda ip: ip in mc_online
        server = serve(master.routes(), "127.0.0.1", 0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_address[1]}"

        def state() -> dict:
            return call("GET", url + "/state", timeout=10)

        def upload(path: Path) -> dict:
            return put_file(url + "/file", path, lambda n: None, threading.Event())

        def finished(*phases: str) -> dict:
            return wait(lambda: (s := state())["rollout"] and s["rollout"]["phase"] in phases and not s["busy"] and s, 60, f"phases {phases}")

        def events(s: dict) -> str:
            return "\n".join(e["text"] for e in s["rollout"]["events"])

        # Не файл обновления отвергается целиком
        garbage = root / "garbage.tar"
        garbage.write_bytes(os.urandom(5000))
        try:
            upload(garbage)
            raise AssertionError("garbage accepted")
        except HttpError as e:
            assert e.status == 400, e

        # Дельта от текущей версии: проверки зелёные, офлайн-плата пропускается
        s = upload(make_file(root / "new.tar", NEW, BASE))
        assert s["file"]["kind"] == "delta" and s["file"]["label"] == "20 нояб. 2026, 14:30" and s["file"]["changed"] == 2, s["file"]
        assert s["system"]["version"] == BASE and not s["busy"]
        levels = {c["title"]: c["level"] for c in s["checks"]}
        assert "err" not in levels.values(), s["checks"]
        assert levels["Базовая версия совпадает"] == "ok" and levels["«Плата 4» офлайн, будет пропущена"] == "skip", levels
        assert [b["online"] for b in s["boards"]] == [True, True, True, False]

        call("POST", url + "/start", {})
        s = finished("done", "rolled_back", "failed")
        assert s["rollout"]["phase"] == "done", events(s)
        assert [b.tag() for b in boards] == [NEW] * 3 and b1.tag("master") == NEW and b1.prev("master") == BASE
        rows = {row["id"]: row for row in s["rollout"]["boards"]}
        assert rows["b1"]["steps"] == {"delivery": "ok", "install": "ok", "master": "ok", "check": "ok"}, rows["b1"]
        assert rows["b2"]["steps"] == {"delivery": "ok", "install": "ok", "master": "na", "check": "ok"}, rows["b2"]
        assert rows["b4"]["skipped"] and rows["b4"]["steps"] is None and "url" not in rows["b1"]
        assert s["file"] is None and "Все платы прошли проверку, система на 20 нояб. 2026, 14:30" in events(s)
        clean(boards, "finish on boards")
        wait(lambda: all(any(c[0] == "systemd-run" for c in b.runner.calls) for b in boards), 10, "updater self-update")
        assert any("получено minion/images.tar.gz" in line for line in call("GET", url + "/board-log?id=b2")["lines"])

        # Возврат по кнопке меняет версии местами
        call("POST", url + "/revert", {})
        s = finished("done", "rolled_back")
        assert s["rollout"]["phase"] == "done" and s["rollout"]["kind"] == "revert", events(s)
        assert [b.tag() for b in boards] == [BASE] * 3 and b1.tag("master") == BASE and b2.prev() == NEW
        assert s["system"]["label"] == "6 нояб. 2026, 09:00" and s["system"]["prev"] == NEW

        # Дельта от другой версии не запускается
        s = upload(make_file(root / "foreign.tar", NEWER, NEW))
        assert any(c["level"] == "err" and c["title"] == "Дельта не подходит к этой системе" for c in s["checks"]), s["checks"]
        try:
            call("POST", url + "/start", {})
            raise AssertionError("foreign delta started")
        except HttpError as e:
            assert e.status == 409

        # Плата не прошла проверку: общий откат всех плат, файл остаётся для повтора
        upload(make_file(root / "newer.tar", NEWER, BASE))
        b2.unhealthy = {NEWER}
        call("POST", url + "/start", {})
        s = finished("done", "rolled_back", "failed")
        assert s["rollout"]["phase"] == "rolled_back", events(s)
        assert [b.tag() for b in boards] == [BASE] * 3 and b1.tag("master") == BASE
        rows = {row["id"]: row for row in s["rollout"]["boards"]}
        assert "не поднялись контейнеры" in rows["b2"]["error"] and rows["b2"]["steps"]["check"] == "fail", rows["b2"]
        assert rows["b1"]["steps"]["install"] == "back" and rows["b1"]["steps"]["master"] == "wait", rows["b1"]
        assert "Общий откат на 6 нояб. 2026, 09:00" in events(s) and s["file"]["tag"] == NEWER
        clean(boards, "discard after rollback")

        # Повтор того же файла после исправления
        b2.unhealthy = set()
        call("POST", url + "/start", {})
        s = finished("done", "rolled_back", "failed")
        assert s["rollout"]["phase"] == "done" and [b.tag() for b in boards] == [NEWER] * 3, events(s)

        # Плата пропала во время установки: остальные откатываются, она вернётся сама, когда появится
        upload(make_file(root / "newest.tar", NEWEST, ""))

        def lose() -> bool:
            threading.Thread(target=b3.stop).start()
            time.sleep(2.5)
            return False

        b3.hooks[("install.sh", "", "minion")] = lose
        call("POST", url + "/start", {})
        s = finished("rolled_back", "done", "failed")
        assert s["rollout"]["phase"] == "rolled_back", events(s)
        assert b1.tag() == NEWER and b2.tag() == NEWER and b1.tag("master") == NEWER
        assert s["pending"] == [{"id": "b3", "name": "Плата 3"}] and "вернётся сама" in events(s), s["pending"]
        b3.hooks.clear()
        wait(lambda: b3.tag() == NEWEST, 10, "lost board finishing its install")
        b3.start()
        wait(lambda: not state()["pending"], 20, "pending restore")
        assert b3.tag() == NEWER and "«Плата 3» снова в сети" in events(state())

        # Отмена во время доставки: на платах ничего не меняется
        upload(make_file(root / "last.tar", LAST, ""))
        b2.hooks[("install.sh", "--prepare", "minion")] = lambda: time.sleep(1.5)
        call("POST", url + "/start", {})
        wait(lambda: state()["rollout"]["boards"][0]["steps"]["delivery"] == "ok", 20, "delivery on b1")
        call("POST", url + "/cancel", {})
        s = finished("cancelled", "failed", "done")
        assert s["rollout"]["phase"] == "cancelled", events(s)
        assert [b.tag() for b in boards] == [NEWER] * 3
        clean(boards, "discard after cancel")
        assert any(c[2:] == ["--discard"] for c in b1.runner.calls if len(c) > 2)

        # Сбой подготовки на одной плате: доставка не удалась, ничего не установлено
        b2.hooks[("install.sh", "--prepare", "minion")] = lambda: True
        call("POST", url + "/start", {})
        s = finished("failed", "cancelled", "done", "rolled_back")
        assert s["rollout"]["phase"] == "failed" and "Доставка не удалась" in events(s), events(s)
        assert [b.tag() for b in boards] == [NEWER] * 3
        clean(boards, "discard after failed delivery")
        b2.hooks.clear()

        # Плата в сети без службы обновления и смена профиля запрещают запуск
        mc_online.add("10.0.0.4")
        fastapi["transition"] = {"phase": "loading"}
        titles = {c["title"]: c["level"] for c in state()["checks"]}
        assert titles.get("«Плата 4» без службы обновления") == "err" and titles.get("Идёт смена профиля") == "err", titles
        try:
            call("POST", url + "/start", {})
            raise AssertionError("start with a board without updater")
        except HttpError as e:
            assert e.status == 409
        assert call("GET", url + "/lock") == {"busy": False}

        for item in (server, api, dead, *(b.server for b in boards)):
            item.shutdown()
            item.server_close()
    print("updater-check: OK")


main()
