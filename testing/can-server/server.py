"""
Тестовый CAN сервер: изображает Садко на шине для message-gateway.

Шлёт то, что шлюз ждёт от стороннего устройства — время (PGN FF01) и координаты
(PGN FF00) раз в 500 мс с адреса 0x61. Координаты выдуманные: точка гуляет
случайным блужданием вокруг заданной, чтобы по странице было видно, что кадры
действительно идут, а не замерли.

Принимает кадр обнаружений (PGN EF00, адрес 0x71) от технического зрения и
разбирает его, включая маску камер.

    python server.py --mode slcan --device COM3
    python server.py --mode socketcan --iface can0
"""
import argparse
import random
import threading
import time
from collections import deque
from datetime import datetime, timezone

from flask import Flask, jsonify, render_template

import codec
from bus import make_bus

app = Flask(__name__)

MAX_LOG = 300
LOG = deque(maxlen=MAX_LOG)
LOCK = threading.Lock()

STATE = {
    "bus": "—",
    "connected": False,
    "error": "",
    "sent": 0,
    "received": 0,
    "foreign": 0,
    "errors": 0,
    "period_ms": 500,
    "gps": None,
    "detection": None,
    "detection_at": None,
}

SEQ = 0


def log_frame(direction, can_id, data, title, note="", error=""):
    global SEQ
    with LOCK:
        SEQ += 1
        LOG.appendleft({
            "seq": SEQ,
            "ts": datetime.now().strftime("%H:%M:%S.%f")[:-3],
            "dir": direction,
            "id": codec.hex_id(can_id),
            "data": codec.hex_bytes(data),
            "title": title,
            "note": note,
            "error": error,
        })


class Wanderer:
    """Заглушка координат: точка гуляет вокруг базовой.

    Случайная точка на всём шаре не годится — по ней не отличить живую выдачу от
    залипшей. Блуждание малым шагом даёт правдоподобный трек и сразу видно, идут
    кадры или встали.
    """

    def __init__(self, lat, lon):
        self.lat = lat
        self.lon = lon
        self.base_lat = lat
        self.base_lon = lon
        self.speed = 0.0

    def step(self):
        self.lat += random.uniform(-0.0002, 0.0002)
        self.lon += random.uniform(-0.0002, 0.0002)
        # Не отпускаем точку дальше пары километров от базовой, иначе за час
        # прогона трек уползёт в соседнюю область.
        self.lat = max(self.base_lat - 0.02, min(self.base_lat + 0.02, self.lat))
        self.lon = max(self.base_lon - 0.02, min(self.base_lon + 0.02, self.lon))
        self.speed = max(0.0, min(30.0, self.speed + random.uniform(-1.5, 1.5)))
        return self.lat, self.lon, self.speed


def on_state(connected, error):
    STATE["connected"] = connected
    STATE["error"] = error
    print(f"[шина] {'подключена' if connected else 'нет связи'}{': ' + error if error else ''}", flush=True)


def on_frame(can_id, data):
    """Кадр с шины. Свой же разбираем, чужой только считаем."""
    _, pgn, src, _ = codec.parse_j1939_id(can_id)

    if pgn != codec.DETECTION_PGN or src != codec.VISION_ADDR:
        STATE["foreign"] += 1
        # Любой пришедший кадр — уже хорошо: значит шина живая и приём работает.
        # Печатаем даже чужой, но не каждый, чтобы не залить консоль потоком.
        if STATE["foreign"] <= 5 or STATE["foreign"] % 50 == 0:
            print(f"[rx] чужой кадр {codec.hex_id(can_id)} [{len(data)}] {codec.hex_bytes(data)}"
                  f" (всего чужих {STATE['foreign']})", flush=True)
        return

    STATE["received"] += 1
    try:
        detection = codec.decode_detection(data)
    except ValueError as exc:
        STATE["errors"] += 1
        log_frame("rx", can_id, data, "Обнаружения", error=str(exc))
        return

    STATE["detection"] = detection
    STATE["detection_at"] = datetime.now().strftime("%H:%M:%S")

    cameras = ", ".join(str(c) for c in detection["cameras"]) or "нет"
    note = (f"{detection['count']} обн. · {detection['type']} {detection['type_title']}"
            f" · {detection['danger']} {detection['danger_title']} · камеры {cameras}")
    log_frame("rx", can_id, data, "Обнаружения", note=note)


def sender(bus, wanderer, period_ms):
    """Время и координаты раз в период, пока сервер жив."""
    while True:
        time.sleep(period_ms / 1000.0)
        if not bus.connected:
            continue

        lat, lon, speed = wanderer.step()
        now = datetime.now(timezone.utc)

        for can_id, data, title, note in (
            (codec.TIME_ID, codec.encode_time(now, speed),
             "Время", f"{now.strftime('%d.%m.%Y %H:%M:%S')} UTC · {speed:.2f} м/с"),
            (codec.GPS_ID, codec.encode_gps(lat, lon),
             "Координаты", f"{lat:.6f}, {lon:.6f}"),
        ):
            try:
                bus.send(can_id, data)
            except Exception as exc:
                STATE["errors"] += 1
                log_frame("tx", can_id, data, title, error=str(exc))
                continue
            STATE["sent"] += 1
            log_frame("tx", can_id, data, title, note=note)

        STATE["gps"] = {"lat": round(lat, 6), "lon": round(lon, 6), "speed": round(speed, 2)}


def heartbeat():
    """Раз в 5 секунд печатаем счётчики. Главное — приём: если received и
    foreign держатся на нуле при растущем sent, значит шлём в пустоту — с шины
    к нам ничего не приходит, и дело не в коде, а в проводах или скорости."""
    while True:
        time.sleep(5.0)
        rx = STATE["received"] + STATE["foreign"]
        line = (f"[статус] шина {'подключена' if STATE['connected'] else 'нет связи'}"
                f" | отправлено {STATE['sent']} | принято обнаружений {STATE['received']}"
                f" | чужих {STATE['foreign']} | ошибок {STATE['errors']}")
        if STATE["connected"] and rx == 0:
            line += "  <-- с шины не пришло НИ ОДНОГО кадра: проверьте провода, терминаторы и скорость"
        print(line, flush=True)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/messages")
def messages():
    with LOCK:
        entries = list(LOG)
    return jsonify({"state": STATE, "entries": entries})


def main():
    parser = argparse.ArgumentParser(description="Тестовый CAN сервер: Садко для message-gateway")
    parser.add_argument("--mode", choices=["socketcan", "slcan"], default="slcan",
                        help="способ доступа к шине (по умолчанию slcan: работает и в Windows)")
    parser.add_argument("--iface", default="can0", help="интерфейс для socketcan")
    parser.add_argument("--device", default="COM3", help="serial port адаптера для slcan")
    parser.add_argument("--bitrate", type=int, default=500000, help="скорость шины для slcan")
    parser.add_argument("--period", type=int, default=500, help="период выдачи, мс")
    parser.add_argument("--lat", type=float, default=55.751244, help="базовая широта заглушки")
    parser.add_argument("--lon", type=float, default=37.618423, help="базовая долгота заглушки")
    parser.add_argument("--port", type=int, default=8766, help="порт веб-страницы")
    args = parser.parse_args()

    bus = make_bus(args.mode, args.iface, args.device, args.bitrate, on_frame, on_state)
    STATE["bus"] = bus.describe()
    STATE["period_ms"] = args.period
    bus.start()

    wanderer = Wanderer(args.lat, args.lon)
    threading.Thread(target=sender, args=(bus, wanderer, args.period), daemon=True).start()
    threading.Thread(target=heartbeat, daemon=True).start()

    print(f"[can-server] {bus.describe()}")
    print(f"[can-server] шлём {codec.hex_id(codec.TIME_ID)} и {codec.hex_id(codec.GPS_ID)} "
          f"раз в {args.period} мс, ждём {codec.hex_id(codec.DETECTION_ID)}")
    print(f"[can-server] страница: http://localhost:{args.port}")

    try:
        app.run(host="0.0.0.0", port=args.port, debug=False)
    finally:
        bus.stop()


if __name__ == "__main__":
    main()
