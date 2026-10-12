#!/usr/bin/env python3
# Стенд Modbus АС КРСПС: ведущий на pty, заглушка бэкенда, одноразовый шлюз и сценарии
import argparse
import json
import os
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import tty
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROTO = HERE.parent.parent / "message-gateway" / "proto"

REST_PORT = 19090
GRPC_PORT = 15051
STUB_PORT = 18000
SLAVE = 20
TZ_MS = 180 * 60000
GW_NAME = "mbstand-gw"
HELPER_IMAGE = "varan/detection-service:latest"
MOSCOW = (55.752057, 37.626105)


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def adu(addr: int, pdu: bytes) -> bytes:
    frame = bytes([addr]) + pdu
    crc = crc16(frame)
    return frame + bytes([crc & 0xFF, crc >> 8])


def split_angle(v: float) -> list:
    t = round(abs(v) * 600000)
    return [t // 600000, t % 600000 // 10000, t % 10000]


# Регистры 0x2000–0x2007; по протоколу 0x2006 — E/W, 0x2007 — N/S, swap — наоборот, как у живого ведущего
def gps_regs(lat: float, lon: float, swap: bool = False) -> list:
    ns = ord("N") if lat >= 0 else ord("S")
    ew = ord("E") if lon >= 0 else ord("W")
    return split_angle(lat) + split_angle(lon) + ([ns, ew] if swap else [ew, ns])


def time_regs(unix_s: int) -> list:
    return [(unix_s >> (16 * i)) & 0xFFFF for i in range(4)]


def decode_record(r: list) -> dict:
    return {
        "length": r[0], "number": r[1], "type": r[2],
        "unix_s": r[3] | r[4] << 16 | r[5] << 32 | r[6] << 48,
        "lat": tuple(r[7:10]), "lon": tuple(r[10:13]), "ew": r[13], "ns": r[14],
        "code": r[15], "frame_id": r[16] | r[17] << 16, "mask": r[18], "zone": r[19], "count": r[20],
        "reserved": r[21:32],
    }


class Exc:
    # Ответ-исключение Modbus
    def __init__(self, code: int):
        self.code = code

    def __eq__(self, other):
        return isinstance(other, Exc) and other.code == self.code

    def __repr__(self):
        return f"Exc({self.code})"


class Bus:
    # Мастер-сторона pty; ведомую сторону открывает шлюз
    def __init__(self):
        self.fd, self.slave = os.openpty()
        tty.setraw(self.slave)
        self.path = os.ttyname(self.slave)

    def close(self):
        os.close(self.fd)
        os.close(self.slave)

    def drain(self) -> bytes:
        out = b""
        while select.select([self.fd], [], [], 0)[0]:
            out += os.read(self.fd, 4096)
        return out

    def write(self, raw: bytes):
        os.write(self.fd, raw)

    # Всё, что пришло до тишины timeout
    def quiet(self, timeout: float = 0.3) -> bytes:
        out = b""
        while select.select([self.fd], [], [], timeout)[0]:
            out += os.read(self.fd, 4096)
        return out

    # Один ответ ведомого: длина по коду функции
    def response(self, timeout: float = 1.0) -> bytes:
        out = b""
        need = 5
        deadline = time.monotonic() + timeout
        while len(out) < need:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([self.fd], [], [], left)[0]:
                break
            out += os.read(self.fd, 4096)
            if len(out) >= 2:
                fc = out[1]
                if fc & 0x80:
                    need = 5
                elif fc in (3, 4):
                    need = 5 + out[2] if len(out) >= 3 else 3
                else:
                    need = 8
        return out


class Master:
    # Ведущий АС КРСПС по протоколу v2.3
    def __init__(self, bus: Bus):
        self.bus = bus

    def transact(self, pdu: bytes, addr: int = SLAVE, timeout: float = 1.0) -> bytes:
        self.bus.drain()
        self.bus.write(adu(addr, pdu))
        rsp = self.bus.response(timeout)
        if len(rsp) < 5 or crc16(rsp[:-2]) != (rsp[-2] | rsp[-1] << 8) or rsp[0] != addr:
            raise AssertionError(f"bad response [{rsp.hex(' ')}] to [{adu(addr, pdu).hex(' ')}]")
        return rsp[1:-2]

    # Запрос без ответа: чужой адрес или широковещательный
    def silent(self, pdu: bytes, addr: int) -> bytes:
        self.bus.drain()
        self.bus.write(adu(addr, pdu))
        return self.bus.quiet()

    def read(self, start: int, count: int, fc: int = 4):
        body = self.transact(struct.pack(">BHH", fc, start, count))
        if body[0] & 0x80:
            return Exc(body[1])
        return list(struct.unpack(f">{body[1] // 2}H", body[2:]))

    def write_single(self, reg: int, value: int):
        body = self.transact(struct.pack(">BHH", 6, reg, value))
        return Exc(body[1]) if body[0] & 0x80 else True

    def write_multi(self, start: int, values: list, addr: int = SLAVE):
        pdu = struct.pack(">BHHB", 0x10, start, len(values), 2 * len(values)) + struct.pack(f">{len(values)}H", *values)
        if addr == 0:
            return self.silent(pdu, 0)
        body = self.transact(pdu, addr)
        return Exc(body[1]) if body[0] & 0x80 else True

    def write_time_gps(self, unix_s: int, lat: float = MOSCOW[0], lon: float = MOSCOW[1], swap: bool = False, addr: int = SLAVE):
        return self.write_multi(0x2000, gps_regs(lat, lon, swap) + time_regs(unix_s), addr)

    def mark(self, first: int, last: int):
        return self.write_multi(0x1000, [1, first, last])

    # Первые n записей окна, по три записи за запрос
    def records(self, n: int) -> list:
        regs = []
        while len(regs) < n * 32:
            regs += self.read(0x2000 + len(regs), min(96, n * 32 - len(regs)))
        return [decode_record(regs[i * 32:(i + 1) * 32]) for i in range(n)]


def neural(devices: list) -> dict:
    return {"data": {"devices": devices}}


def device(name: str = "Борт 1", state: str = "ok", slots=None) -> dict:
    return {"device_id": name, "device_name": name, "state": state,
            "slots": [slot()] if slots is None and state == "ok" else slots}


def slot(running: bool = True, tiles: tuple = ("ok", "ok"), stream: str = "front") -> dict:
    return {"stream_id": stream, "running": running, "error": "" if running else "loader stopped",
            "tiles": [{"camera": f"camera_{i + 1}", "state": t} for i, t in enumerate(tiles)]}


class Stub:
    # Заглушка GET /api/neural/status бэкенда
    def __init__(self, port: int):
        self.body = neural([device()])
        self.code = 200
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path != "/api/neural/status":
                    self.send_error(404)
                    return
                data = json.dumps(stub.body).encode()
                self.send_response(stub.code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


def rest(method: str, path: str, body=None, base: str = f"http://127.0.0.1:{REST_PORT}", timeout: float = 5):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, method=method, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def module() -> dict:
    return rest("GET", "/status")["modules"][0]


def wait_until(fn, timeout: float, step: float = 0.2) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if fn():
                return True
        except (OSError, AssertionError, KeyError, IndexError):
            pass
        time.sleep(step)
    return False


class Gateway:
    # Одноразовый шлюз в сети хоста; /data — рабочий каталог стенда
    def __init__(self, image: str, work: Path):
        self.image = image
        self.work = work

    def run(self):
        subprocess.run(["docker", "rm", "-f", GW_NAME], capture_output=True)
        subprocess.run([
            "docker", "run", "-d", "--name", GW_NAME, "--network", "host", "--user", f"{os.getuid()}:{os.getgid()}",
            "-v", "/dev/pts:/dev/pts", "-v", f"{self.work}:/data", self.image,
            "--rest-port", str(REST_PORT), "--grpc-port", str(GRPC_PORT), "--state-file", "/data/gateway-state.json",
            "--backend-url", f"http://127.0.0.1:{STUB_PORT}", "--can-enabled", "0", "--ws-host", "127.0.0.1", "--ws-port", "9",
        ], check=True, capture_output=True)
        self.wait()

    def stop(self):
        subprocess.run(["docker", "stop", "-t", "5", GW_NAME], check=True, capture_output=True)

    def start(self):
        subprocess.run(["docker", "start", GW_NAME], check=True, capture_output=True)
        self.wait()

    def restart(self):
        self.stop()
        self.start()

    def wait(self):
        if not wait_until(lambda: rest("GET", "/health", timeout=1)["status"] == "ok", 20):
            raise RuntimeError("gateway REST did not come up:\n" + self.logs())

    def remove(self):
        subprocess.run(["docker", "rm", "-f", GW_NAME], capture_output=True)

    def logs(self) -> str:
        return subprocess.run(["docker", "logs", "--tail", "60", GW_NAME], capture_output=True, text=True).stdout


class Sender:
    # Отправитель записей в образе мастера обнаружений: там есть grpc
    def __init__(self, image: str):
        self.proc = subprocess.Popen([
            "docker", "run", "--rm", "-i", "--network", "host", "-v", f"{PROTO}:/proto:ro", "-v", f"{HERE}:/stand:ro",
            "--entrypoint", "python", image, "-u", "/stand/sender.py", "--grpc", f"127.0.0.1:{GRPC_PORT}",
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        if not json.loads(self.proc.stdout.readline() or "{}").get("ready"):
            raise RuntimeError("sender did not start")

    def send(self, record=None) -> dict:
        self.proc.stdin.write(json.dumps({"record": record}) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(15)


# Запись 28163 без GPS: код 1, стоп-кадр = номер, камера 1, зона 3, один объект
def iskra_regs(number: int, utc_ms: int) -> list:
    regs = [0] * 32
    regs[0:3] = [32, number, 1]
    regs[3:7] = time_regs(utc_ms // 1000)
    regs[15:21] = [1, number, 0, 1, 3, 1]
    return regs


# Очередь в формате шлюза: заголовок MBQ2, затем записи: номер, скрыта, время, пакет, длина, регистры
def write_queue(path: Path, next_number: int, records: list, dropped: int = 0, packet: int = 28163):
    with open(path, "wb") as f:
        f.write(b"MBQ2" + struct.pack("<HqI", next_number, dropped, len(records)))
        for number, utc_ms, regs in records:
            f.write(struct.pack("<HBqHH", number, 0, utc_ms, packet, len(regs)) + struct.pack(f"<{len(regs)}H", *regs))


class Stand:
    def __init__(self, image: str, keep: bool):
        self.failures = []
        self.keep = keep
        self.work = Path(tempfile.mkdtemp(prefix="mbstand-"))
        self.bus = Bus()
        self.m = Master(self.bus)
        self.stub = Stub(STUB_PORT)
        self.gw = Gateway(image, self.work)
        self.sender = None

    def check(self, name: str, ok: bool, detail=None):
        print(("  ok    " if ok else "  FAIL  ") + name + ("" if ok or detail is None else f"  ->  {detail}"), flush=True)
        if not ok:
            self.failures.append(name)

    def section(self, title: str):
        print(f"\n== {title}", flush=True)

    def connected(self) -> bool:
        return wait_until(lambda: module()["connection"]["connected"], 15)

    def visible(self) -> int:
        return self.m.read(0x1006, 1)[0]

    def push(self, **record) -> dict:
        r = self.sender.send(record)
        if not r["accepted"]:
            self.check(f"запись {record.get('frame_id')} принята шлюзом", False, r)
        return r

    def master_now(self) -> int:
        return int(time.time()) + 3600

    def close(self):
        if self.sender:
            self.sender.close()
        if self.failures and self.keep:
            print("\n" + self.gw.logs())
        self.gw.remove()
        self.stub.close()
        self.bus.close()
        if not self.keep:
            shutil.rmtree(self.work, ignore_errors=True)

    def run(self):
        self.section("запуск")
        self.gw.run()
        items = rest("GET", "/integrations")["items"]
        iskra = next((i for i in items if i["id"] == "iskra"), None)
        self.check("в шлюзе есть конфигурация iskra с модулем modbus",
                   iskra is not None and [m["id"] for m in iskra["modules"]] == ["modbus"], items)
        rest("POST", "/integrations/select", {"id": "iskra"})
        rest("PUT", "/config/modbus", {"device": self.bus.path})
        self.check(f"шлюз открыл {self.bus.path}", self.connected(), module()["connection"])
        self.sender = Sender(HELPER_IMAGE)

        self.info()
        self.state()
        self.plain()
        self.hidden()
        self.time_gps()
        self.marks()
        self.exceptions()
        self.garbage()
        self.foreign()
        self.broadcast()
        self.restart()
        self.wrap()
        self.window()
        self.overflow()

    def info(self):
        self.section("блок состояния")
        v = self.m.read(0x1000, 8)
        self.check("0x1000–0x1005 = 20, 1, 32, 0x1000, 3, 1", v[:6] == [20, 1, 32, 0x1000, 3, 1], v)
        self.check("0x1002 = 32 — длина единственного пакета 28163", v[2] == 32 and module()["block"][2] == 32, v)
        self.check("0x1006 = 0", v[6] == 0, v)
        self.check("ведущий на связи", module()["master"]["online"], module()["master"])

    def state(self):
        self.section("регистр состояния 0x1007")
        cases = [
            ("все слоты и плитки в работе", neural([device(slots=[slot(), slot(tiles=("ok",), stream="rear")])]), 200, 1, "ok"),
            ("плата не в сети", neural([device(), device("Борт 2", state="offline")]), 200, 0, "device_offline"),
            ("на плате нет техзрения", neural([device(state="no_module")]), 200, 0, "no_module"),
            ("слот остановлен", neural([device(slots=[slot(running=False)])]), 200, 0, "slot_stopped"),
            ("плитка без камеры", neural([device(slots=[slot(tiles=("ok", "no_camera"))])]), 200, 0, "tile_fault"),
            ("нет плат с техзрением", neural([]), 200, 0, "no_devices"),
            ("бэкенд отвечает 503", {}, 503, 0, "backend_unavailable"),
            ("снова в работе", neural([device()]), 200, 1, "ok"),
        ]
        state = lambda: module()["state"]["registers"][0]
        for name, body, code, value, reason in cases:
            self.stub.body, self.stub.code = body, code
            ok = wait_until(lambda: self.m.read(0x1007, 1) == [value] and state()["code"] == reason, 9, 0.5)
            self.check(f"{name}: {value}, {reason}", ok, state())
        self.check("причина текстом: 1 плата, 1 слот, 2 камеры", state()["reason"] == ["1 плата", "1 слот", "2 камеры"], state())

    def plain(self):
        self.section("сообщение без записи")
        before = module()["queue"]["total"]
        r = self.sender.send(None)
        self.check("принято и в очередь не попало", r["accepted"] and module()["queue"]["total"] == before, r)

    def hidden(self):
        self.section("скрытые записи до времени ведущего")
        t0 = time.time()
        a = self.push(code=2, frame_id=70001, camera_mask=0b0101, zone=1, count=3)
        ts_b = int(time.time() * 1000) + TZ_MS - 60000
        b = self.push(code=4, frame_id=5, camera_mask=0b1000, zone=3, count=1, ts=ts_b, gps={"lat": -33.5, "lon": -70.25})
        self.check("записи приняты", a["accepted"] and b["accepted"], (a, b))
        self.check("0x1006 = 0, записи скрыты", self.visible() == 0)
        self.check("окно пустое", self.m.read(0x2000, 64) == [0] * 64)
        q = module()["queue"]
        self.check("в очереди 2 скрытых", q["hidden"] == 2 and q["visible"] == 0, q)

        master_s = self.master_now()
        self.check("ведущий пишет время и GPS", self.m.write_time_gps(master_s, swap=True) is True)
        self.check("0x1006 = 2 после первого времени", self.visible() == 2)
        ra, rb = self.m.records(2)
        self.check("номера 1 и 2, длина 32, тип 1", (ra["number"], rb["number"], ra["length"], ra["type"]) == (1, 2, 32, 1), (ra, rb))
        self.check("время скрытой записи сдвинуто на время ведущего", int(t0) + 3600 - 1 <= ra["unix_s"] <= int(t0) + 3600 + 2, ra["unix_s"] - int(t0))
        exp_b = (ts_b - TZ_MS) // 1000 + 3600
        self.check("время из записи переведено в UTC и сдвинуто", exp_b - 1 <= rb["unix_s"] <= exp_b + 1, rb["unix_s"] - exp_b)
        self.check("поля 28163 записи 1", (ra["code"], ra["frame_id"], ra["mask"], ra["zone"], ra["count"]) == (2, 70001, 5, 1, 3), ra)
        self.check("без GPS у записи и шлюза — нули", ra["lat"] == (0, 0, 0) and ra["lon"] == (0, 0, 0) and ra["ew"] == 0 and ra["ns"] == 0, ra)
        self.check("GPS записи: 33°30' S, 70°15' W", rb["lat"] == (33, 30, 0) and rb["lon"] == (70, 15, 0)
                   and rb["ew"] == ord("W") and rb["ns"] == ord("S"), rb)
        self.check("резерв нулями", ra["reserved"] == [0] * 11 and rb["reserved"] == [0] * 11)
        self.check("в статусе синхронизация", module()["time"]["synced"])

    def time_gps(self):
        self.section("время и GPS ведущего")
        t = rest("GET", "/time")
        self.check("источник времени и GPS — modbus", t["source"] == {"time": "modbus", "gps": "modbus"}, t["source"])
        self.check("координаты при буквах в обратном порядке", abs(t["gps"]["lat"] - MOSCOW[0]) < 1e-5
                   and abs(t["gps"]["lon"] - MOSCOW[1]) < 1e-5 and t["gps"]["valid"], t["gps"])
        self.check("время в поясе шлюза", abs(t["unix_ms"] - (self.master_now() * 1000 + TZ_MS)) < 3000, t["unix_ms"])
        self.m.write_time_gps(self.master_now(), lat=59.9375, lon=30.308611)
        t = rest("GET", "/time")
        self.check("буквы в порядке протокола", abs(t["gps"]["lat"] - 59.9375) < 1e-5 and abs(t["gps"]["lon"] - 30.308611) < 1e-5, t["gps"])
        self.m.write_time_gps(self.master_now(), lat=-12.0464, lon=-77.0428, swap=True)
        t = rest("GET", "/time")
        self.check("южная широта и западная долгота со знаком", abs(t["gps"]["lat"] + 12.0464) < 1e-5 and abs(t["gps"]["lon"] + 77.0428) < 1e-5, t["gps"])
        before = module()["gps"]["invalid"]
        regs = gps_regs(*MOSCOW)
        regs[6] = regs[7] = 0
        self.m.write_multi(0x2000, regs + time_regs(self.master_now()))
        t = rest("GET", "/time")
        self.check("без букв полушарий координаты не меняются", module()["gps"]["invalid"] == before + 1
                   and abs(t["gps"]["lat"] + 12.0464) < 1e-5, t["gps"])
        self.m.write_time_gps(self.master_now())

    def marks(self):
        self.section("отметка прочитанных")
        self.push(code=1, frame_id=42, camera_mask=2, zone=2, count=1)
        self.check("новая запись сразу видна", self.visible() == 3)
        rc = self.m.records(3)[2]
        self.check("номер 3, время ведущего", rc["number"] == 3 and abs(rc["unix_s"] - self.master_now()) <= 2, rc)
        self.check("координаты шлюза от ведущего: 55°45.1234' N, 37°37.5663' E",
                   rc["lat"] == tuple(split_angle(MOSCOW[0])) and rc["lon"] == tuple(split_angle(MOSCOW[1]))
                   and rc["ew"] == ord("E") and rc["ns"] == ord("N"), rc)
        rejected = module()["counters"]["marks_rejected"]
        for first, last in ((2, 3), (5, 5), (1, 0), (1, 5)):
            self.m.mark(first, last)
        self.check("отметки с неверными номерами отвергнуты", self.visible() == 3
                   and module()["counters"]["marks_rejected"] == rejected + 4)
        self.m.mark(1, 2)
        self.check("отметка 1..2 снимает с головы", self.visible() == 1 and self.m.records(1)[0]["number"] == 3)
        self.m.write_single(0x1001, 3)
        self.m.write_single(0x1002, 3)
        self.m.write_single(0x1000, 1)
        self.check("отметка одиночными записями 0x06", self.visible() == 0 and self.m.read(0x2000, 32) == [0] * 32)
        statuses = {r["number"]: r["status"] for r in module()["queue"]["recent"]}
        self.check("записи 1–3 прочитаны", statuses == {1: "read", 2: "read", 3: "read"}, statuses)

    def exceptions(self):
        self.section("исключения")
        before = module()["counters"]["exceptions"]
        cases = [
            ("0x03 — недопустимая функция", lambda: self.m.read(0x1000, 1, fc=3), Exc(1)),
            ("чтение 0 регистров", lambda: self.m.read(0x1000, 0), Exc(3)),
            ("чтение 126 регистров", lambda: self.m.read(0x1000, 126), Exc(3)),
            ("чтение 0x0FFF", lambda: self.m.read(0x0FFF, 2), Exc(2)),
            ("чтение за 0x2FFF", lambda: self.m.read(0x2FFF, 2), Exc(2)),
            ("запись в 0x8000", lambda: self.m.write_multi(0x8000, [0x2580, 0]), Exc(2)),
            ("неизвестная команда", lambda: self.m.write_single(0x1000, 2), Exc(3)),
            ("запись в 0x0FFF", lambda: self.m.write_single(0x0FFF, 1), Exc(2)),
        ]
        for name, fn, expected in cases:
            got = fn()
            self.check(f"{name}: {expected}", got == expected, got)
        body = self.m.transact(struct.pack(">BHHB", 0x10, 0x1001, 2, 3) + b"\x00\x01\x00")
        self.check("байт счёта не равен двум числам регистров: Exc(3)", body[0] == 0x90 and body[1] == 3, body.hex(" "))
        self.check("счётчик исключений +9", module()["counters"]["exceptions"] == before + 9, module()["counters"])

    def garbage(self):
        self.section("мусор и CRC")
        c0 = module()["counters"]
        self.bus.drain()
        self.bus.write(b"\xAA\x55\xAA\x55\xFF")
        self.check("на мусор ответа нет", self.bus.quiet() == b"")
        self.check("после мусора запрос обслужен", self.m.read(0x1000, 2) == [20, 1])
        bad = bytearray(adu(SLAVE, struct.pack(">BHH", 4, 0x1000, 2)))
        bad[-1] ^= 0xFF
        self.bus.drain()
        self.bus.write(bytes(bad))
        self.check("на неверный CRC ответа нет", self.bus.quiet() == b"")
        self.bus.drain()
        self.bus.write(b"\x13\x37" + adu(SLAVE, struct.pack(">BHH", 4, 0x1000, 2)))
        rsp = self.bus.response()
        self.check("мусор вплотную перед запросом: ответ есть", rsp[:3] == bytes([SLAVE, 4, 4]), rsp.hex(" "))
        c1 = module()["counters"]
        self.check("ошибок CRC +1", c1["crc_errors"] == c0["crc_errors"] + 1, (c0["crc_errors"], c1["crc_errors"]))
        self.check("мусорные байты посчитаны", c1["garbage_bytes"] >= c0["garbage_bytes"] + 7, (c0["garbage_bytes"], c1["garbage_bytes"]))

    def foreign(self):
        self.section("чужой адрес")
        c0 = module()["counters"]
        self.check("запрос ведомому 21 без ответа", self.m.silent(struct.pack(">BHH", 4, 0x1000, 2), 21) == b"")
        self.bus.write(adu(21, bytes([4, 4, 0, 7, 0, 1])))
        self.check("запись ведомому 21 без ответа", self.m.silent(struct.pack(">BHH", 6, 0x1000, 0), 21) == b"")
        self.bus.write(adu(21, struct.pack(">BHH", 6, 0x1000, 0)))
        time.sleep(0.2)
        c1 = module()["counters"]
        self.check("чужие запросы посчитаны, адрес 21", c1["foreign"] == c0["foreign"] + 2 and c1["foreign_last"] == 21, c1)
        self.check("ответы чужого ведомого не ошибки", c1["crc_errors"] == c0["crc_errors"] and c1["garbage_bytes"] == c0["garbage_bytes"], (c0, c1))
        self.check("свой запрос после чужих обслужен", self.m.read(0x1000, 2) == [20, 1])

    def broadcast(self):
        self.section("широковещательная запись")
        before = module()["counters"]["broadcasts"]
        target = int(time.time()) + 7200
        self.check("ответа нет", self.m.write_time_gps(target, addr=0) == b"")
        t = rest("GET", "/time")
        self.check("время ведущего применено", abs(t["unix_ms"] - (target * 1000 + TZ_MS)) < 3000, t["unix_ms"] - (target * 1000 + TZ_MS))
        self.check("счётчик широковещательных +1", module()["counters"]["broadcasts"] == before + 1)
        self.m.write_time_gps(self.master_now())

    def restart(self):
        self.section("перезапуск шлюза")
        self.push(code=5, frame_id=100, camera_mask=1, zone=1, count=1)
        self.push(code=6, frame_id=101, camera_mask=1, zone=2, count=2)
        before = self.m.records(2)
        self.check("две видимые записи 4 и 5", self.visible() == 2 and [r["number"] for r in before] == [4, 5])
        self.gw.restart()
        self.check("порт открыт после перезапуска", self.connected())
        after = self.m.records(2)
        self.check("видимые записи подняты из файла и видны сразу", self.visible() == 2 and [r["number"] for r in after] == [4, 5])
        self.check("время видимых записей не изменилось", [r["unix_s"] for r in after] == [r["unix_s"] for r in before], (before, after))
        self.check("времени ведущего после перезапуска нет, /time — часы платы",
                   not module()["time"]["synced"] and rest("GET", "/time")["source"]["time"] == "server")
        t0 = time.time()
        self.push(code=7, frame_id=102, camera_mask=1, zone=3, count=1)
        q = module()["queue"]
        self.check("новая запись скрыта до времени ведущего", self.visible() == 2 and q["hidden"] == 1, q)
        self.gw.restart()
        self.check("порт открыт после второго перезапуска", self.connected())
        q = module()["queue"]
        self.check("скрытая запись пережила перезапуск", q["hidden"] == 1 and q["visible"] == 2, q)
        self.m.write_time_gps(self.master_now())
        recs = self.m.records(3)
        self.check("после времени ведущего видно 3, номера 4–6", self.visible() == 3 and [r["number"] for r in recs] == [4, 5, 6], recs)
        self.check("время скрытой записи сдвинуто после перезапуска", int(t0) + 3600 - 1 <= recs[2]["unix_s"] <= int(t0) + 3600 + 2, recs[2]["unix_s"] - int(t0))
        self.m.mark(4, 6)
        self.check("очередь пуста", self.visible() == 0)

    def wrap(self):
        self.section("номер 65535 -> 0")
        self.gw.stop()
        write_queue(self.work / "modbus-queue.bin", 65534, [])
        self.gw.start()
        self.check("порт открыт", self.connected())
        self.m.write_time_gps(self.master_now())
        for i in range(3):
            self.push(code=1, frame_id=200 + i, camera_mask=1, zone=1, count=1)
        numbers = [r["number"] for r in self.m.records(3)]
        self.check("номера 65534, 65535, 0", numbers == [65534, 65535, 0], numbers)
        self.m.mark(65534, 0)
        self.check("отметка через переход снимает все три", self.visible() == 0)

    def window(self):
        self.section("окно из целых записей")
        self.gw.stop()
        utc = int(time.time() * 1000)
        write_queue(self.work / "modbus-queue.bin", 131, [(n, utc, [40, n] + [n] * 38) for n in range(1, 131)], packet=1)
        self.gw.start()
        self.check("порт открыт", self.connected())
        self.check("подняты 130 записей по 40 регистров", self.visible() == 130 and module()["queue"]["window"] == 102,
                   module()["queue"]["window"])
        self.check("0x1002 = 0 — в очереди записи не той длины, что у пакета", self.m.read(0x1002, 1) == [0]
                   and module()["block"][2] == 0, module()["block"])
        self.check("102-я запись — последняя в окне", self.m.read(0x2000 + 101 * 40, 3) == [40, 102, 102])
        self.check("хвост окна за 102 записями — нули", self.m.read(0x2000 + 102 * 40, 16) == [0] * 16)
        self.m.mark(1, 103)
        self.check("отметка 103 записей, больше окна, отвергнута", self.visible() == 130)
        self.m.mark(1, 102)
        self.check("отметка 102 записей снимает окно целиком", self.visible() == 28 and self.m.read(0x2000, 2) == [40, 103])
        self.check("0x1002 = 0, пока остались записи по 40", self.m.read(0x1002, 1) == [0])
        self.m.mark(103, 130)
        self.check("очередь пуста — 0x1002 снова 32", self.visible() == 0 and self.m.read(0x1002, 1) == [32])

    def overflow(self):
        self.section("переполнение очереди")
        self.gw.stop()
        utc = int(time.time() * 1000)
        write_queue(self.work / "modbus-queue.bin", 1, [(n, utc, iskra_regs(n, utc)) for n in range(1, 65536)])
        self.gw.start()
        self.check("порт открыт", self.connected())
        self.check("подняты 65535 видимых", self.visible() == 65535)
        self.m.write_time_gps(self.master_now())
        self.push(code=3, frame_id=300, camera_mask=1, zone=1, count=1)
        q = module()["queue"]
        self.check("старейшая выброшена, всего 65535", q["total"] == 65535 and q["dropped"] == 1, {k: q[k] for k in ("total", "dropped", "next_number")})
        self.check("в окне первая — №2", self.m.records(1)[0]["number"] == 2)
        last = q["recent"][0] if q["recent"] else {}
        self.check("новая запись получила №1", last.get("number") == 1 and last.get("status") == "queued", last)
        self.gw.stop()
        (self.work / "modbus-queue.bin").unlink()


def serve(base: str):
    # Ведущий АС КРСПС для живого шлюза: цикл протокола раз в 5 с
    if rest("GET", "/integrations", base=base)["active"] != "iskra":
        sys.exit("active gateway configuration is not iskra")
    bus = Bus()
    m = Master(bus)
    rest("PUT", "/config/modbus", {"device": bus.path}, base=base)
    print(f"master on {bus.path}, Ctrl+C to stop", flush=True)
    try:
        while True:
            started = time.monotonic()
            try:
                m.write_time_gps(int(time.time()), swap=True)
                info = m.read(0x1000, 6)
                count, state = m.read(0x1006, 2)
                numbers = []
                if count:
                    recs = m.records(min(count, 3))
                    numbers = [r["number"] for r in recs]
                    m.mark(numbers[0], numbers[-1])
                print(time.strftime("%H:%M:%S"), f"id {info[0]} v{info[1]} state {state} records {count} read {numbers}", flush=True)
            except AssertionError as e:
                print(time.strftime("%H:%M:%S"), e, flush=True)
            time.sleep(max(0.0, 5 - (time.monotonic() - started)))
    except KeyboardInterrupt:
        pass
    finally:
        bus.close()


def main():
    parser = argparse.ArgumentParser(description="Modbus АС КРСПС: сценарии на одноразовом шлюзе или ведущий для живого")
    parser.add_argument("--image", default="varan/message-gateway:latest", help="образ шлюза для сценариев")
    parser.add_argument("--keep", action="store_true", help="не удалять рабочий каталог, при ошибках — лог шлюза")
    parser.add_argument("--serve", metavar="REST", help="ведущий для живого шлюза, напр. http://127.0.0.1:9090")
    args = parser.parse_args()
    if args.serve:
        serve(args.serve.rstrip("/"))
        return
    stand = Stand(args.image, args.keep)
    try:
        stand.run()
    except Exception as e:
        stand.check("стенд дошёл до конца", False, repr(e))
    finally:
        stand.close()
    print(f"\n{'FAILED: ' + str(len(stand.failures)) if stand.failures else 'ALL PASSED'}")
    sys.exit(1 if stand.failures else 0)


if __name__ == "__main__":
    main()
