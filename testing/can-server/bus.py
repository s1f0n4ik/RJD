"""
Доступ к шине двумя способами, как и в message-gateway.

socketcan — штатный интерфейс ядра Linux (can0, vcan0).
slcan — USB-адаптер, говорящий ASCII-протоколом Lawicel через serial port.
        Работает и на Windows, где socketcan нет.

У обоих один интерфейс: send(can_id, data) и колбэк на принятый кадр. Приём
крутится в своём потоке, отключение адаптера не роняет сервер — переподключение
идёт по кругу, как у шлюза.
"""
import socket
import struct
import threading
import time

# Флаг 29-битного идентификатора в socketcan.
CAN_EFF_FLAG = 0x80000000
CAN_EFF_MASK = 0x1FFFFFFF
CAN_ERR_FLAG = 0x20000000
CAN_RTR_FLAG = 0x40000000

# struct can_frame: id, dlc, отступ, 8 байт данных.
CAN_FRAME = struct.Struct("=IB3x8s")

RETRY_SEC = 5.0

# Индекс скорости в команде slcan: S0..S8.
SLCAN_BITRATES = {
    10_000: 0, 20_000: 1, 50_000: 2, 100_000: 3, 125_000: 4,
    250_000: 5, 500_000: 6, 800_000: 7, 1_000_000: 8,
}


class BusError(Exception):
    pass


class Bus:
    """Общая часть: поток приёма и переподключение."""

    def __init__(self, on_frame, on_state):
        self._on_frame = on_frame
        self._on_state = on_state
        self._stop = threading.Event()
        self._thread = None
        self._lock = threading.Lock()
        self.connected = False
        self.error = ""

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._close()

    def _set_state(self, connected, error=""):
        self.connected = connected
        self.error = error
        self._on_state(connected, error)

    def _run(self):
        while not self._stop.is_set():
            try:
                self._open()
                self._set_state(True)
            except Exception as exc:
                self._set_state(False, str(exc))
                self._stop.wait(RETRY_SEC)
                continue

            try:
                self._read_loop()
            except Exception as exc:
                if not self._stop.is_set():
                    self._set_state(False, str(exc))
            finally:
                self._close()

            if not self._stop.is_set():
                self._stop.wait(RETRY_SEC)

    def send(self, can_id, data):
        if not self.connected:
            raise BusError("шина не подключена")
        with self._lock:
            self._write(can_id, data)


class SocketCanBus(Bus):
    def __init__(self, iface, on_frame, on_state):
        super().__init__(on_frame, on_state)
        self._iface = iface
        self._sock = None

    def describe(self):
        return f"socketcan · {self._iface}"

    def _open(self):
        if not hasattr(socket, "PF_CAN"):
            raise BusError("socketcan есть только в Linux — возьмите режим slcan")
        sock = socket.socket(socket.PF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
        sock.settimeout(1.0)
        try:
            sock.bind((self._iface,))
        except OSError as exc:
            sock.close()
            raise BusError(f"интерфейс '{self._iface}' недоступен: {exc}") from exc
        self._sock = sock

    def _close(self):
        if self._sock:
            self._sock.close()
            self._sock = None

    def _write(self, can_id, data):
        payload = bytes(data).ljust(8, b"\x00")
        frame = CAN_FRAME.pack(can_id | CAN_EFF_FLAG, len(data), payload)
        self._sock.send(frame)

    def _read_loop(self):
        while not self._stop.is_set():
            try:
                raw = self._sock.recv(CAN_FRAME.size)
            except socket.timeout:
                continue
            if len(raw) < CAN_FRAME.size:
                continue

            can_id, dlc, payload = CAN_FRAME.unpack(raw)
            # Кадры ошибок шины и запросы данных нам не интересны: они не несут
            # полезной нагрузки и только замусорили бы ленту.
            if can_id & (CAN_ERR_FLAG | CAN_RTR_FLAG):
                continue
            self._on_frame(can_id & CAN_EFF_MASK, payload[:dlc])


class SlcanBus(Bus):
    def __init__(self, device, bitrate, on_frame, on_state):
        super().__init__(on_frame, on_state)
        self._device = device
        self._bitrate = bitrate
        self._port = None

    def describe(self):
        return f"slcan · {self._device} · {self._bitrate} бит/с"

    def _open(self):
        try:
            import serial
        except ImportError as exc:
            raise BusError("нужен pyserial: pip install -r requirements.txt") from exc

        if self._bitrate not in SLCAN_BITRATES:
            raise BusError(f"адаптер не умеет {self._bitrate} бит/с")

        try:
            port = serial.Serial(self._device, 115200, timeout=1.0)
        except Exception as exc:
            raise BusError(f"порт '{self._device}' недоступен: {exc}") from exc

        # Закрыть канал перед настройкой: адаптер мог остаться открытым с
        # прошлого запуска, и тогда команда скорости молча не применится.
        for command in (b"C\r", f"S{SLCAN_BITRATES[self._bitrate]}\r".encode(), b"O\r"):
            port.write(command)
            port.flush()
            time.sleep(0.05)

        port.reset_input_buffer()
        self._port = port

    def _close(self):
        if self._port:
            try:
                self._port.write(b"C\r")
                self._port.flush()
            except Exception:
                pass  # порт мог уже отвалиться, закрытие всё равно обязано пройти
            self._port.close()
            self._port = None

    def _write(self, can_id, data):
        payload = "".join(f"{b:02X}" for b in data)
        self._port.write(f"T{can_id:08X}{len(data)}{payload}\r".encode())
        self._port.flush()

    def _read_loop(self):
        buffer = bytearray()
        while not self._stop.is_set():
            chunk = self._port.read(64)
            if not chunk:
                continue
            buffer.extend(chunk)

            while b"\r" in buffer:
                line, _, rest = bytes(buffer).partition(b"\r")
                buffer = bytearray(rest)
                self._handle_line(line.decode("ascii", "replace").strip())

    def _handle_line(self, line):
        # Ответы адаптера на команды ('z', 'Z', пустая строка) кадрами не
        # являются. Нас интересуют только 'T' и 't'.
        if not line or line[0] not in "Tt":
            return

        extended = line[0] == "T"
        id_len = 8 if extended else 3
        if len(line) < 1 + id_len + 1:
            return

        try:
            can_id = int(line[1:1 + id_len], 16)
            dlc = int(line[1 + id_len], 16)
        except ValueError:
            return

        body = line[2 + id_len:]
        if dlc > 8 or len(body) < dlc * 2:
            return

        try:
            data = bytes.fromhex(body[:dlc * 2])
        except ValueError:
            return

        self._on_frame(can_id, data)


def make_bus(mode, iface, device, bitrate, on_frame, on_state):
    if mode == "socketcan":
        return SocketCanBus(iface, on_frame, on_state)
    if mode == "slcan":
        return SlcanBus(device, bitrate, on_frame, on_state)
    raise BusError(f"неизвестный режим шины: {mode}")
