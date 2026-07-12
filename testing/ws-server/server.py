"""
Тестовый WS сервер, эмулирует приём кадров по протоколу СВН -> КАУС.
Бинарный фрейм: [4 байта uint32 BE длина JSON][JSON заголовок][байты изображения].
Текстовый фрейм: служебное сообщение (heartbeat и т.д.).
"""
import base64
import json
import struct
import threading
from collections import deque
from datetime import datetime

from flask import Flask, render_template
from flask_sock import Sock

app = Flask(__name__)
sock = Sock(app)

MAX_HISTORY = 10
history = deque(maxlen=MAX_HISTORY)
history_lock = threading.Lock()


def add_entry(entry):
    with history_lock:
        history.appendleft(entry)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/messages")
def messages():
    with history_lock:
        entries = list(history)
    return {"entries": entries}


@sock.route("/ws/frames")
def ws_frames(ws):
    print("[ws] client connected")
    while True:
        data = ws.receive()
        if data is None:
            print("[ws] client disconnected")
            break

        received_at = datetime.now().strftime("%H:%M:%S.%f")[:-3]

        if isinstance(data, bytes):
            if len(data) < 4:
                print("[ws] бинарный фрейм короче 4 байт, пропуск")
                continue

            header_size = struct.unpack(">I", data[0:4])[0]
            header_bytes = data[4:4 + header_size]
            image_bytes = data[4 + header_size:]

            try:
                header = json.loads(header_bytes.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                print(f"[ws] ошибка парсинга JSON-заголовка: {exc}")
                continue

            image_b64 = base64.b64encode(image_bytes).decode("ascii")
            image_format = header.get("img", {}).get("format", "jpeg")

            add_entry({
                "kind": "frame",
                "received_at": received_at,
                "header": json.dumps(header, ensure_ascii=False, indent=2),
                "image_data_url": f"data:image/{image_format};base64,{image_b64}",
                "image_size": len(image_bytes),
            })
            print(f"[ws] кадр: {len(header_bytes)}b заголовок + {len(image_bytes)}b изображение")

        else:
            try:
                header = json.loads(data)
                pretty = json.dumps(header, ensure_ascii=False, indent=2)
            except json.JSONDecodeError:
                pretty = data

            add_entry({
                "kind": "text",
                "received_at": received_at,
                "header": pretty,
                "image_data_url": None,
                "image_size": None,
            })
            print(f"[ws] служебное сообщение: {data}")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8765, debug=False)
