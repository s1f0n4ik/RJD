#!/usr/bin/env python3
# Эмулятор ведущего АС КРСПС по протоколу Modbus RTU v2.3: COM-порт, цикл обмена, страница
import argparse
import json
import logging
import queue
import random
import struct
import threading
import time
import traceback
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import serial
import serial.tools.list_ports
from flask import Flask, jsonify, render_template, request

HERE = Path(__file__).resolve().parent
SETTINGS_FILE = HERE / "settings.json"
MAX_READ = 125
MAX_WRITE = 123
LOST_AFTER = 3
GARBAGE = b"\xaa\x55\x00\xff"

DEFAULTS = {
    "device": "COM6", "baud": 115200, "parity": "N", "bytesize": 8, "stopbits": 1, "open": False,
    "slave": 20, "period_s": 5.0, "timeout_ms": 300, "running": False, "mark": True,
    "send_time": True, "time_mode": "pc", "time_offset_s": 0, "time_manual_s": 0, "time_manual_at": 0.0,
    "send_gps": True, "gps_mode": "fixed", "lat": 55.752057, "lon": 37.626105, "letters": "master",
}
COUNTERS = ("requests", "replies", "timeouts", "crc", "exceptions", "violations", "records", "marks", "gaps", "repeats")

# Словари пакета 28163 — как в detection-service/app/rules.py; коды с 1, 0 — пусто
CODES = ["Человек, не удалось распознать наличие СИЗ", "Человек в СИЗ", "Человек без СИЗа",
         "Легковая автомобильная техника", "Грузовая автомобильная техника", "Строительная техника",
         "Сыпучие отходы производства", "Твёрдые отходы производства", "Железнодорожная шпала (мусор)",
         "Граффити", "Борщевик"]
ZONES = ["", "На пути", "Опасная близость", "Полоса отвода"]
ROLES = ["дальняя", "ближняя", "левая", "правая"]
EXCEPTIONS = {1: "неверная функция", 2: "неверный адрес", 3: "неверное значение", 4: "сбой ведомого", 6: "ведомый занят"}
FUNCS = {3: "чтение Holding", 4: "чтение Input", 6: "запись", 0x10: "запись"}


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


# Регистры 0x2000–0x2007; master — как живой ведущий (0x2006 = N/S), protocol — по тексту v2.3 (0x2006 = E/W)
def gps_regs(lat: float, lon: float, letters: str) -> list:
    ns = ord("N") if lat >= 0 else ord("S")
    ew = ord("E") if lon >= 0 else ord("W")
    return split_angle(lat) + split_angle(lon) + ([ns, ew] if letters == "master" else [ew, ns])


def time_regs(unix_s: int) -> list:
    return [(unix_s >> (16 * i)) & 0xFFFF for i in range(4)]


def angle_text(r, letter: int) -> str:
    return f"{r[0]}°{r[1]:02d}.{r[2]:04d}′{chr(letter) if 32 < letter < 127 else '?'}"


def gps_text(lat: float, lon: float) -> str:
    return (f"{angle_text(split_angle(lat), ord('N') if lat >= 0 else ord('S'))} "
            f"{angle_text(split_angle(lon), ord('E') if lon >= 0 else ord('W'))}")


def utc_text(unix_s: int) -> str:
    try:
        return datetime.fromtimestamp(unix_s, timezone.utc).strftime("%d.%m.%Y %H:%M:%S")
    except (OverflowError, OSError, ValueError):
        return f"{unix_s} (вне диапазона)"


def clock() -> str:
    return datetime.now().strftime("%H:%M:%S.%f")[:-3]


def decode_record(r: list) -> dict:
    rec = {"length": r[0], "number": r[1], "regs": r}
    if len(r) < 21 or r[2] != 1:
        return rec
    unix_s = r[3] | r[4] << 16 | r[5] << 32 | r[6] << 48
    if unix_s >= 1 << 63:
        unix_s -= 1 << 64
    rec.update({
        "packet": "28163", "time": utc_text(unix_s),
        "lat": angle_text(r[7:10], r[14]) if r[14] else "—",
        "lon": angle_text(r[10:13], r[13]) if r[13] else "—",
        "code": r[15], "code_text": CODES[r[15] - 1] if 1 <= r[15] <= len(CODES) else "",
        "frame": r[16] | r[17] << 16, "mask": r[18],
        "cameras": ", ".join(ROLES[i] for i in range(4) if r[18] >> i & 1) or "—",
        "zone": r[19], "zone_text": ZONES[r[19]] if r[19] < len(ZONES) else "",
        "count": r[20],
    })
    return rec


class Master:
    # Ведущий: единственный владелец порта, цикл и ручные запросы в одном потоке
    def __init__(self, settings: dict):
        self.s = settings
        self.lock = threading.Lock()
        self.port = None
        self.port_key = None
        self.port_error = ""
        self.port_retry = 0.0
        self.jobs = queue.Queue()
        self.armed = {"crc": False, "garbage": False}
        self.point = (settings["lat"], settings["lon"])
        self.next_cycle = 0.0
        self.manual = False
        self.epoch = 0
        self.misses = 0
        self.last_reply = None
        self.clear()
        self.relink()

    def clear(self):
        with self.lock:
            self.epoch += 1
            self.seq = 0
            self.log = deque(maxlen=2000)
            self.records = deque(maxlen=500)
            self.counters = dict.fromkeys(COUNTERS, 0)
            self.last_number = None
            self.marked = None

    # Связь заново: блок 0x1000–0x1005 читается до всего остального
    def relink(self):
        self.info = None
        self.state = None
        self.online = False

    def add(self, kind: str, item: dict) -> dict:
        with self.lock:
            self.seq += 1
            item["seq"] = self.seq
            getattr(self, kind).append(item)
        return item

    def entry(self, direction: str, text: str, raw: bytes = b"", level: str = "ok", note: str = "", ms=None) -> dict:
        return self.add("log", {"ts": clock(), "dir": direction, "text": text, "hex": raw.hex(" ").upper(),
                                "level": level, "note": note, "ms": ms, "manual": self.manual})

    def violation(self, text: str):
        self.counters["violations"] += 1
        self.entry("!", text, level="warn")

    # Ответ ведомого: длина по коду функции; silent — слушать весь таймаут
    def reply(self, silent: bool):
        deadline = time.monotonic() + self.s["timeout_ms"] / 1000
        buf = b""
        need = 5
        while time.monotonic() < deadline and (silent or len(buf) < need):
            chunk = self.port.read(256 if silent else need - len(buf))
            if not chunk:
                continue
            buf += chunk
            if not silent and len(buf) >= 2:
                fc = buf[1]
                if fc & 0x80:
                    need = 5
                elif fc in (3, 4):
                    need = 5 + buf[2] if len(buf) >= 3 else 3
                else:
                    need = 8
        extra = b"" if silent or len(buf) < need else self.port.read(256)
        return buf, extra

    def send(self, pdu: bytes, addr=None, text: str = "", note: str = "", explain=None):
        if not self.manual:
            self.do_jobs()
        addr = self.s["slave"] if addr is None else addr
        frame = adu(addr, pdu)
        wire = frame
        silent = addr == 0
        flags = [note] if note else []
        if self.armed["crc"]:
            wire = wire[:-1] + bytes([wire[-1] ^ 0xFF])
            silent = True
            flags.append("битый CRC")
        if self.armed["garbage"]:
            wire = GARBAGE + wire
            flags.append("мусор перед кадром")
        self.armed = {"crc": False, "garbage": False}

        time.sleep(0.002)
        self.port.reset_input_buffer()
        self.port.write(wire)
        self.port.flush()
        self.counters["requests"] += 1
        self.entry("tx", text, wire, note=" · ".join(flags))
        started = time.monotonic()
        buf, extra = self.reply(silent)
        ms = round((time.monotonic() - started) * 1000)

        if silent:
            if buf:
                self.entry("rx", "ответ, где ведомый должен молчать", buf, "warn", ms=ms)
                self.violation("ответ на " + ("широковещательный запрос" if addr == 0 else "кадр с битым CRC"))
            return {"silent": True}
        if not buf:
            self.counters["timeouts"] += 1
            self.misses += 1
            self.entry("rx", f"таймаут {self.s['timeout_ms']} мс", level="err", ms=ms)
            if self.misses >= LOST_AFTER and (self.online or self.info):
                self.relink()
                self.entry("!", f"нет связи: {LOST_AFTER} таймаута подряд, блок 0x1000–0x1005 читается заново", level="err")
            return None
        if len(buf) < 5 or crc16(buf[:-2]) != buf[-2] | buf[-1] << 8:
            self.counters["crc"] += 1
            self.entry("rx", "неполный ответ" if len(buf) < 5 else "неверный CRC", buf + extra, "err", ms=ms)
            return None

        self.misses = 0
        self.online = True
        self.last_reply = time.time()
        self.counters["replies"] += 1
        fc = pdu[0]
        problems = []
        result = None
        level = "ok"
        if buf[0] != addr:
            problems.append(f"адрес {buf[0]} вместо {addr}")
        if buf[1] == fc | 0x80:
            self.counters["exceptions"] += 1
            text = f"исключение {buf[2]:02X} — {EXCEPTIONS.get(buf[2], 'неизвестное')}"
            result = {"exc": buf[2]}
            level = "err"
        elif buf[1] != fc:
            problems.append(f"функция {buf[1]:02X} вместо {fc:02X}")
            text = "чужая функция"
        elif fc in (3, 4):
            want = struct.unpack(">H", pdu[3:5])[0]
            n = (len(buf) - 5) // 2
            regs = list(struct.unpack(f">{n}H", buf[3:3 + 2 * n]))
            text = f"{n} рег."
            if buf[2] != 2 * want:
                problems.append(f"байт данных {buf[2]} вместо {2 * want}")
            else:
                result = {"regs": regs}
                meaning = explain(regs) if explain else ""
                text += f" · {meaning}" if meaning else ""
        elif fc == 6:
            text = "подтверждено"
            if buf[:-2] != frame[:-2]:
                problems.append("ответ не повторяет запрос")
            else:
                result = {"ok": True}
        else:
            text = "подтверждено"
            if buf[2:6] != pdu[1:5]:
                problems.append("в ответе другой адрес или число регистров")
            else:
                result = {"ok": True}
        if extra:
            problems.append(f"лишние байты после ответа: {len(extra)}")
        self.entry("rx", text, buf + extra, "warn" if problems else level, ms=ms)
        for p in problems:
            self.violation(p)
        return result

    def read(self, start: int, count: int, fc: int = 4, addr=None, explain=None):
        r = self.send(struct.pack(">BHH", fc, start, count), addr, f"{fc:02X} {FUNCS[fc]} 0x{start:04X} ×{count}",
                      explain=explain)
        return r.get("regs") if r else None

    def read_span(self, start: int, count: int, explain=None):
        regs = []
        while len(regs) < count:
            part = self.read(start + len(regs), min(MAX_READ, count - len(regs)), explain=explain)
            if part is None:
                return None
            regs += part
        return regs

    def write_single(self, reg: int, value: int, addr=None, note: str = "") -> bool:
        r = self.send(struct.pack(">BHH", 6, reg, value), addr, f"06 запись 0x{reg:04X} = {value}", note)
        return bool(r and ("ok" in r or "silent" in r))

    def write_multi(self, start: int, values: list, addr=None, note: str = "") -> bool:
        pdu = struct.pack(">BHHB", 0x10, start, len(values), 2 * len(values)) + struct.pack(f">{len(values)}H", *values)
        r = self.send(pdu, addr, f"10 запись 0x{start:04X} ×{len(values)}", note)
        return bool(r and ("ok" in r or "silent" in r))

    def master_time(self) -> int:
        if self.s["time_mode"] == "manual":
            return int(self.s["time_manual_s"] + time.time() - self.s["time_manual_at"])
        return int(time.time() + self.s["time_offset_s"])

    # Точка GPS; в режиме wander гуляет не дальше ±0.02° от заданной
    def gps_point(self):
        lat, lon = self.s["lat"], self.s["lon"]
        if self.s["gps_mode"] != "wander":
            self.point = (lat, lon)
            return self.point
        plat = min(lat + 0.02, max(lat - 0.02, self.point[0] + random.uniform(-0.0002, 0.0002)))
        plon = min(lon + 0.02, max(lon - 0.02, self.point[1] + random.uniform(-0.0002, 0.0002)))
        self.point = (plat, plon)
        return self.point

    def write_time_gps(self, addr=None) -> bool:
        if not self.s["send_time"] and not self.s["send_gps"]:
            return True
        parts = []
        regs = [0] * 8
        if self.s["send_gps"]:
            lat, lon = self.gps_point()
            regs = gps_regs(lat, lon, self.s["letters"])
            parts.append(gps_text(lat, lon))
        else:
            parts.append("GPS нулями")
        if self.s["send_time"]:
            unix_s = self.master_time()
            regs += time_regs(unix_s)
            parts.insert(0, f"время {utc_text(unix_s)} UTC")
        if addr == 0:
            parts.append("широковещательно")
        return self.write_multi(0x2000, regs, addr, " · ".join(parts))

    def read_info(self) -> bool:
        regs = self.read(0x1000, 6, explain=lambda r: f"идентификатор {r[0]} · версия {r[1]} · длина {r[2]} · "
                                                      f"окно {r[3]} · команд {r[4]} · состояний {r[5]}")
        if regs is None:
            return False
        self.info = dict(zip(("id", "version", "length", "window", "commands", "states"), regs))
        return True

    def poll_state(self):
        n = min(max(1, self.info["states"] if self.info else 1), MAX_READ - 1)
        regs = self.read(0x1006, 1 + n, explain=lambda r: f"записей {r[0]} · состояние {' '.join(map(str, r[1:]))}")
        if regs is None:
            return None
        self.state = {"count": regs[0], "regs": regs[1:]}
        return regs[0]

    # Номер записи против последнего полученного; таблица записей
    def accept(self, regs: list, L: int, window: int) -> bool:
        length, number = regs[0], regs[1]
        if not length and not number:
            self.violation("0x1006 > 0, а в 0x2000 нули")
            return False
        problems = []
        if length < 2 or length > window:
            problems.append(f"длина записи {length} вне 2…{window}")
        elif L and length != L:
            problems.append(f"длина записи {length}, а 0x1002 = {L}")
        tag = ""
        if self.last_number is not None:
            d = (number - self.last_number - 1) & 0xFFFF
            if d > 0x8000:
                tag = "repeat"
                self.counters["repeats"] += 1
                if self.s["mark"] and self.marked is not None and (self.marked - number) & 0xFFFF < 0x8000:
                    problems.append(f"№{number} уже отмечена прочитанной")
            elif d:
                tag = "gap"
                self.counters["gaps"] += 1
                problems.append(f"пропуск: ждали №{(self.last_number + 1) & 0xFFFF}, пришла №{number}")
            elif number == 0:
                tag = "wrap"
        if tag != "repeat":
            self.last_number = number
        for p in problems:
            self.violation(p)
        rec = decode_record(regs)
        rec.update(tag=tag, problems=problems, at=clock())
        self.counters["records"] += 1
        self.add("records", rec)
        return True

    # Целые записи из окна 0x2000: по L разом, иначе заголовок и данные
    def fetch(self, want: int) -> list:
        L, window = self.info["length"], self.info["window"]
        numbers = []
        if L:
            n = max(1, min(want, window // L, MAX_READ // L))
            explain = (lambda r: "№ " + ", ".join(str(r[i + 1]) for i in range(0, len(r) - 1, L))) \
                if n * L <= MAX_READ else None
            regs = self.read_span(0x2000, n * L, explain)
            if regs is None:
                return numbers
            for i in range(n):
                rec = regs[i * L:(i + 1) * L]
                if not self.accept(rec, L, window):
                    break
                numbers.append(rec[1])
            return numbers
        offset = 0
        while len(numbers) < want and offset + 2 <= window:
            head = self.read(0x2000 + offset, 2, explain=lambda r: f"длина {r[0]} · №{r[1]}")
            if head is None:
                break
            length = head[0]
            if offset and not length:
                break
            if length and (length < 2 or offset + length > window):
                self.violation(f"длина записи {length} при смещении {offset}, окно {window}")
                break
            data = self.read_span(0x2000 + offset + 2, length - 2) if length > 2 else []
            if data is None or not self.accept(head + data, L, window):
                break
            numbers.append(head[1])
            offset += length
        return numbers

    def cycle(self):
        if self.info is None and not self.read_info():
            return
        self.write_time_gps()
        if self.info is None:
            return
        count = self.poll_state()
        budget = count or 0
        while count and budget > 0:
            # Выборка дольше периода — время и GPS между порциями
            if time.monotonic() >= self.next_cycle:
                self.next_cycle = time.monotonic() + self.s["period_s"]
                self.write_time_gps()
            numbers = self.fetch(min(count, budget))
            if not numbers or not self.s["mark"]:
                return
            budget -= len(numbers)
            first, last = numbers[0], numbers[-1]
            if not self.write_multi(0x1000, [1, first, last], note=f"отметка №{first}..{last}"):
                return
            self.counters["marks"] += 1
            self.marked = last
            new = self.poll_state()
            if new is None:
                return
            if new >= count:
                self.violation(f"после отметки №{first}..{last} 0x1006 не уменьшилось: {count} → {new}")
            count = new

    def manual_mark(self, first: int, last: int):
        before = self.state["count"] if self.state else None
        if self.write_multi(0x1000, [1, first, last], note=f"отметка №{first}..{last} вручную"):
            after = self.poll_state()
            self.entry("•", f"0x1006: {before if before is not None else '?'} → {after if after is not None else '?'}")

    def manual_request(self, fn: int, addr: int, start: int, args: list):
        if fn in (3, 4):
            self.read(start, args[0], fn, addr, explain=lambda r: " ".join(map(str, r)))
        elif fn == 6:
            self.write_single(start, args[0], addr)
        else:
            self.write_multi(start, args, addr)

    def do_jobs(self):
        self.manual = True
        try:
            while True:
                try:
                    job = self.jobs.get_nowait()
                except queue.Empty:
                    return
                job()
        finally:
            self.manual = False

    def keep_port(self):
        key = (self.s["device"], self.s["baud"], self.s["parity"], self.s["bytesize"], self.s["stopbits"])
        if self.port and (not self.s["open"] or key != self.port_key):
            self.drop_port("")
        if self.port or not self.s["open"] or time.monotonic() < self.port_retry:
            return
        try:
            self.port = serial.Serial(key[0], key[1], bytesize=key[3], parity=key[2], stopbits=key[4], timeout=0.01)
        except (serial.SerialException, ValueError) as e:
            if str(e) != self.port_error:
                self.entry("•", f"порт {key[0]} не открылся: {e}", level="err")
            self.port_error = str(e)
            self.port_retry = time.monotonic() + 2
            return
        self.port_key = key
        self.port_error = ""
        self.entry("•", f"порт {key[0]} открыт · {key[1]} {key[3]}{key[2]}{key[4]}")

    def drop_port(self, error: str):
        if self.port:
            try:
                self.port.close()
            except (serial.SerialException, OSError):
                pass
            self.port = None
            self.entry("•", "порт закрыт" + (f": {error}" if error else ""), level="err" if error else "ok")
        self.port_error = error
        self.port_retry = time.monotonic() + 2
        self.relink()

    def run(self):
        while True:
            try:
                self.keep_port()
                if self.port is None:
                    while not self.jobs.empty():
                        self.jobs.get_nowait()
                        self.entry("•", "ручной запрос не отправлен: порт закрыт", level="err")
                    time.sleep(0.2)
                    continue
                self.do_jobs()
                if self.s["running"] and time.monotonic() >= self.next_cycle:
                    self.next_cycle = time.monotonic() + self.s["period_s"]
                    self.cycle()
                else:
                    time.sleep(0.02)
            except (serial.SerialException, OSError) as e:
                self.drop_port(str(e))
            except Exception as e:
                traceback.print_exc()
                self.entry("•", f"ошибка эмулятора: {e!r}", level="err")
                time.sleep(1)

    def snapshot(self, since: int, epoch: int) -> dict:
        fresh = epoch != self.epoch
        with self.lock:
            log = [e for e in self.log if fresh or e["seq"] > since]
            records = [r for r in self.records if fresh or r["seq"] > since]
            counters = dict(self.counters)
        s = self.s
        return {
            "epoch": self.epoch, "settings": s, "counters": counters, "armed": self.armed,
            "port": {"open": self.port is not None, "device": s["device"], "error": self.port_error,
                     "line": f"{s['baud']} {s['bytesize']}{s['parity']}{s['stopbits']}"},
            "link": {"online": self.online, "ago": time.time() - self.last_reply if self.last_reply else None},
            "info": self.info, "state": self.state,
            "next_in": max(0.0, self.next_cycle - time.monotonic()) if s["running"] else None,
            "sending": {"time": f"{utc_text(self.master_time())} UTC" if s["send_time"] else "не шлём",
                        "gps": gps_text(*self.point) if s["send_gps"] else "не шлём"},
            "log": log, "records": records,
        }


def load_settings() -> dict:
    s = dict(DEFAULTS)
    if SETTINGS_FILE.exists():
        saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        s.update({k: v for k, v in saved.items() if k in DEFAULTS})
    return s


def save_settings(s: dict):
    tmp = SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(SETTINGS_FILE)


def apply_patch(s: dict, patch: dict):
    for k, v in patch.items():
        if k == "time_manual":
            s["time_manual_s"] = int(datetime.fromisoformat(v).replace(tzinfo=timezone.utc).timestamp())
            s["time_manual_at"] = time.time()
            continue
        if k not in DEFAULTS:
            raise ValueError(f"нет такой настройки: {k}")
        v = type(DEFAULTS[k])(v)
        if (k == "parity" and v not in "NEO") or (k == "bytesize" and v not in (7, 8)) \
                or (k == "stopbits" and v not in (1, 2)) or (k == "slave" and not 1 <= v <= 247) \
                or (k == "period_s" and v < 0.2) or (k == "timeout_ms" and not 20 <= v <= 10000) \
                or (k == "baud" and v <= 0) or (k == "lat" and abs(v) > 90) or (k == "lon" and abs(v) > 180):
            raise ValueError(f"недопустимое значение {k} = {v}")
        s[k] = v


def make_app(master: Master) -> Flask:
    app = Flask(__name__)
    s = master.s

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/state")
    def state():
        return jsonify(master.snapshot(request.args.get("since", 0, int), request.args.get("epoch", 0, int)))

    @app.get("/api/ports")
    def ports():
        return jsonify([{"device": p.device, "name": p.description} for p in serial.tools.list_ports.comports()])

    @app.post("/api/settings")
    def settings():
        patch = request.get_json(force=True)
        try:
            apply_patch(s, patch)
        except (ValueError, TypeError) as e:
            return jsonify({"error": str(e)}), 400
        if patch.get("running"):
            master.next_cycle = 0.0
        if "lat" in patch or "lon" in patch:
            master.point = (s["lat"], s["lon"])
        save_settings(s)
        return jsonify(s)

    @app.post("/api/request")
    def manual_request():
        body = request.get_json(force=True)
        try:
            fn = int(body["fn"])
            addr = int(str(body.get("addr", s["slave"])), 0)
            start = int(str(body["start"]), 0)
            args = [int(x, 0) for x in str(body.get("args", "")).replace(",", " ").split()]
            if fn not in FUNCS or not 0 <= addr <= 247 or not 0 <= start <= 0xFFFF or not args \
                    or any(not 0 <= a <= 0xFFFF for a in args):
                raise ValueError
            if (fn in (3, 4) and not 1 <= args[0] <= MAX_READ) or (fn in (3, 4, 6) and len(args) != 1) \
                    or len(args) > MAX_WRITE or start + (args[0] if fn in (3, 4) else len(args)) > 0x10000:
                raise ValueError
        except (KeyError, ValueError):
            return jsonify({"error": "функция 03/04 — регистр и количество 1…125; 06 — одно значение; "
                                     "10 — до 123 значений 0…65535"}), 400
        master.jobs.put(lambda: master.manual_request(fn, addr, start, args))
        return jsonify({"ok": True})

    @app.post("/api/action")
    def action():
        body = request.get_json(force=True)
        name = body.get("name")
        if name == "info":
            master.jobs.put(master.read_info)
        elif name == "mark":
            first, last = int(body["first"]) & 0xFFFF, int(body["last"]) & 0xFFFF
            master.jobs.put(lambda: master.manual_mark(first, last))
        elif name == "broadcast":
            master.jobs.put(lambda: master.write_time_gps(0))
        elif name == "arm":
            master.armed = {"crc": bool(body.get("crc")), "garbage": bool(body.get("garbage"))}
        elif name == "clear":
            master.clear()
        else:
            return jsonify({"error": f"unknown action {name}"}), 400
        return jsonify({"ok": True})

    return app


class FakeSlave:
    # Ведомый v2.3 в памяти для --selftest: блок, окно из целых записей, отметка с головы, приём времени
    WINDOW = 0x1000

    def __init__(self):
        self.out = b""
        self.queue = []
        self.next = 1
        self.config_length = 32
        self.phantom = 0
        self.silent = False
        self.ignore_mark = False
        self.holding = {}

    def push(self, length: int = 32):
        regs = [length, self.next, 1] + [0] * (length - 3)
        regs[15:21] = [3, 7, 0, 0b0101, 2, 3]
        self.queue.append(regs)
        self.next = (self.next + 1) & 0xFFFF

    def reset_input_buffer(self):
        self.out = b""

    def flush(self):
        pass

    def read(self, n: int) -> bytes:
        if not self.out:
            time.sleep(0.002)
            return b""
        chunk, self.out = self.out[:n], self.out[n:]
        return chunk

    def window(self) -> list:
        regs = []
        for r in self.queue:
            if len(regs) + len(r) > self.WINDOW:
                break
            regs += r
        return regs + [0] * (self.WINDOW - len(regs))

    def write(self, raw: bytes):
        if raw.startswith(GARBAGE):
            raw = raw[len(GARBAGE):]
        if self.silent or crc16(raw[:-2]) != raw[-2] | raw[-1] << 8:
            return
        addr, fc = raw[0], raw[1]
        start, count = struct.unpack(">HH", raw[2:6])
        if fc == 4:
            uniform = all(len(r) == self.config_length for r in self.queue)
            block = [20, 1, self.config_length if uniform else 0, self.WINDOW, 3, 1, len(self.queue) + self.phantom, 1]
            win = self.window()
            values = [block[a - 0x1000] if a < 0x1008 else win[a - 0x2000] for a in range(start, start + count)]
            pdu = bytes([4, 2 * count]) + struct.pack(f">{count}H", *values)
        else:
            values = struct.unpack(f">{count}H", raw[7:7 + 2 * count])
            self.holding.update({start + i: v for i, v in enumerate(values)})
            if start == 0x1000 and values[0] == 1 and not self.ignore_mark and self.queue \
                    and self.queue[0][1] == values[1]:
                while self.queue and self.queue.pop(0)[1] != values[2]:
                    pass
            pdu = raw[1:6]
        if addr:
            self.out = adu(addr, pdu)


def selftest():
    def fresh():
        m = Master(dict(DEFAULTS, timeout_ms=30))
        m.port = FakeSlave()
        return m, m.port

    def numbers(m):
        return [r["number"] for r in m.records]

    m, sl = fresh()
    for _ in range(7):
        sl.push()
    before = time.time()
    m.cycle()
    assert numbers(m) == list(range(1, 8)), numbers(m)
    assert not sl.queue and m.counters["marks"] == 3 and m.counters["violations"] == 0, m.counters
    r = m.records[0]
    assert (r["code_text"], r["cameras"], r["zone_text"], r["count"], r["frame"]) == \
           ("Человек без СИЗа", "дальняя, левая", "Опасная близость", 3, 7), r
    assert (sl.holding[0x2006], sl.holding[0x2007]) == (ord("N"), ord("E"))
    sent = sum(sl.holding[0x2008 + i] << (16 * i) for i in range(4))
    assert before - 1 <= sent <= time.time() + 1
    assert [sl.holding[0x2000 + i] for i in range(6)] == split_angle(55.752057) + split_angle(37.626105)

    m, sl = fresh()
    for _ in range(7):
        sl.push()
    m.s["period_s"] = 0
    sent = []
    m.write_time_gps = lambda addr=None: sent.append(addr) or True
    m.cycle()
    assert len(sent) == 4 and not sl.queue, (sent, sl.queue)

    m, sl = fresh()
    sl.push(32), sl.push(40), sl.push(130)
    m.cycle()
    assert numbers(m) == [1, 2, 3] and not sl.queue and m.counters["violations"] == 0, (numbers(m), m.counters)
    assert len(m.records[2]["regs"]) == 130

    m, sl = fresh()
    sl.next = 65534
    for _ in range(3):
        sl.push()
    m.cycle()
    assert numbers(m) == [65534, 65535, 0] and m.records[2]["tag"] == "wrap" and m.counters["gaps"] == 0

    m, sl = fresh()
    m.s["mark"] = False
    sl.push(), sl.push()
    m.cycle()
    m.cycle()
    assert m.counters["repeats"] == 2 and m.counters["violations"] == 0 and len(sl.queue) == 2, m.counters

    m, sl = fresh()
    sl.push()
    sl.next = 5
    sl.push()
    m.cycle()
    assert m.counters["gaps"] == 1 and m.counters["violations"] == 1, m.counters

    m, sl = fresh()
    sl.ignore_mark = True
    sl.push()
    m.cycle()
    assert m.counters["violations"] == 1 and m.counters["marks"] == 1, m.counters

    m, sl = fresh()
    sl.phantom = 1
    m.cycle()
    assert m.counters["violations"] == 1 and not m.records, m.counters

    m, sl = fresh()
    m.cycle()
    assert m.info and m.online
    sl.silent = True
    m.cycle()
    m.cycle()
    assert m.info is None and not m.online and m.counters["timeouts"] == 3, m.counters
    sl.silent = False
    m.cycle()
    assert m.info and m.online

    m, sl = fresh()
    m.armed["crc"] = True
    assert m.read(0x1000, 6) is None and m.counters["timeouts"] == 0 and m.counters["violations"] == 0
    m.armed["garbage"] = True
    assert m.read(0x1000, 6) == [20, 1, 32, 0x1000, 3, 1]
    assert m.write_time_gps(0) and m.counters["violations"] == 0
    print("selftest ok")


def main():
    parser = argparse.ArgumentParser(description="Эмулятор ведущего АС КРСПС (Modbus RTU v2.3) на COM-порту")
    parser.add_argument("--device", help="COM-порт, открывается сразу (напр. COM6)")
    parser.add_argument("--port", type=int, default=8767, help="порт страницы")
    parser.add_argument("--selftest", action="store_true", help="проверка цикла против ведомого в памяти")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return

    s = load_settings()
    if args.device:
        s.update(device=args.device, open=True)
        save_settings(s)
    master = Master(s)
    threading.Thread(target=master.run, daemon=True).start()
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    print(f"[krsps-master] {s['device']} · ведомый {s['slave']} · страница http://localhost:{args.port}", flush=True)
    make_app(master).run(host="127.0.0.1", port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
