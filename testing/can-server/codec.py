"""
Кадры шины в том виде, в каком их ждёт message-gateway.

Зеркало message-gateway/src/can-codec.cpp: раскладка байт, порядок и единицы
измерения должны совпадать байт в байт, иначе тест проверяет сам себя.
"""
from datetime import datetime, timezone

# Адреса и PGN из спецификации Садко.
GPS_PGN = 0xFF00
TIME_PGN = 0xFF01
DETECTION_PGN = 0xEF00

SADKO_ADDR = 0x61        # источник времени и координат, то есть мы
VISION_ADDR = 0x71       # техническое зрение, шлёт обнаружения нам
SADKO_PRIORITY = 6
DETECTION_PRIORITY = 0

# Расшифровки для веб-страницы: числа на шине, слова для человека.
DETECTION_TYPES = {
    1: "человек",
    2: "инструмент",
    3: "металлический предмет",
    4: "каменные и бетонные материалы",
    5: "древесные материалы",
    6: "полимерные и текстильные материалы",
    7: "сезонные и погодные объекты",
    8: "предметы работ РСМ",
}

DANGER_CLASSES = {
    1: "информация",
    2: "средняя опасность",
    3: "высокая опасность",
    4: "критическая опасность",
}


def make_j1939_id(priority, pgn, src, dst=0):
    dp = (pgn >> 16) & 0x03
    pf = (pgn >> 8) & 0xFF
    # PDU2 — широковещательное, младший байт PGN сам является PS.
    ps = (pgn & 0xFF) if pf >= 0xF0 else (dst & 0xFF)
    return ((priority & 0x07) << 26) | (dp << 24) | (pf << 16) | (ps << 8) | (src & 0xFF)


def parse_j1939_id(can_id):
    dp = (can_id >> 24) & 0x03
    pf = (can_id >> 16) & 0xFF
    ps = (can_id >> 8) & 0xFF
    priority = (can_id >> 26) & 0x07
    src = can_id & 0xFF
    dst = 0xFF if pf >= 0xF0 else ps          # у PDU2 получателя нет
    pgn = ((dp << 16) | (pf << 8) | ps) if pf >= 0xF0 else ((dp << 16) | (pf << 8))
    return priority, pgn, src, dst


GPS_ID = make_j1939_id(SADKO_PRIORITY, GPS_PGN, SADKO_ADDR)          # 0x18FF0061
TIME_ID = make_j1939_id(SADKO_PRIORITY, TIME_PGN, SADKO_ADDR)        # 0x18FF0161
DETECTION_ID = make_j1939_id(DETECTION_PRIORITY, DETECTION_PGN, VISION_ADDR)  # 0x00EF0071


def _to_dms(value):
    """Градусы, минуты и тысячные доли секунды из десятичных градусов.

    Считаем через целые тысячные доли угловой секунды и разбираем делением с
    остатком. Раздельное округление градусов, минут и секунд давало бы 60 минут
    или 60000 в поле секунд — шлюз такой кадр отвергает как испорченный.
    """
    total = round(abs(value) * 3600_000)
    degrees, rest = divmod(total, 3600_000)
    minutes, thousandths = divmod(rest, 60_000)
    return degrees, minutes, thousandths


def encode_gps(lat, lon):
    """PGN FF00: широта в байтах 1-4, долгота в байтах 5-8.

    Знак полушария — отдельные биты внутри байта минут: бит 7 задаёт N (E), бит
    8 задаёт S (W). Ровно один из них обязан стоять, иначе шлюз считает фикс не
    пойманным.
    """
    data = bytearray(8)

    degrees, minutes, thousandths = _to_dms(lat)
    data[0] = min(degrees, 90)
    data[1] = (minutes & 0x3F) | (0x80 if lat < 0 else 0x40)
    data[2:4] = thousandths.to_bytes(2, "little")

    degrees, minutes, thousandths = _to_dms(lon)
    data[4] = min(degrees, 180)
    data[5] = (minutes & 0x3F) | (0x80 if lon < 0 else 0x40)
    data[6:8] = thousandths.to_bytes(2, "little")

    return bytes(data)


def encode_time(moment, speed_mps=0.0):
    """PGN FF01: дата и время, затем скорость в байтах 7-8 по 0.01 м/с на бит.

    Время уходит в UTC: шлюз разбирает кадр через timegm, и местное время уехало
    бы на смещение зоны.
    """
    utc = moment.astimezone(timezone.utc)
    speed = max(0, min(round(speed_mps / 0.01), 0xFFFF))

    data = bytearray(8)
    data[0] = utc.year % 100
    data[1] = utc.month
    data[2] = utc.day
    data[3] = utc.hour
    data[4] = utc.minute
    data[5] = utc.second
    data[6:8] = speed.to_bytes(2, "little")
    return bytes(data)


def decode_gps(data):
    """Разбор своего же кадра координат — для показа на странице."""
    if len(data) < 8:
        raise ValueError(f"координаты: ожидалось 8 байт, пришло {len(data)}")

    def axis(deg, flags, thousandths, positive_bit, negative_bit, limit, name):
        minutes = flags & 0x3F
        positive = bool(flags & positive_bit)
        negative = bool(flags & negative_bit)
        if positive == negative:
            raise ValueError(f"{name}: знак неоднозначен, оба бита {'подняты' if positive else 'сброшены'}")
        if deg > limit:
            raise ValueError(f"{name}: градусы вне диапазона: {deg}")
        if minutes > 59:
            raise ValueError(f"{name}: минуты вне диапазона: {minutes}")
        value = deg + minutes / 60.0 + (thousandths / 1000.0) / 3600.0
        return -value if negative else value

    lat = axis(data[0], data[1], int.from_bytes(data[2:4], "little"), 0x40, 0x80, 90, "широта")
    lon = axis(data[4], data[5], int.from_bytes(data[6:8], "little"), 0x40, 0x80, 180, "долгота")
    return lat, lon


def decode_time(data):
    if len(data) < 8:
        raise ValueError(f"время: ожидалось 8 байт, пришло {len(data)}")

    year, month, day, hour, minute, second = data[0:6]
    speed = int.from_bytes(data[6:8], "little") * 0.01
    moment = datetime(2000 + year, month, day, hour, minute, second, tzinfo=timezone.utc)
    return moment, speed


def decode_detection(data):
    """PGN EF00 от технического зрения.

    Байт 4 — маска камер, а не номер: бит на камеру, поэтому в одном кадре может
    быть видно сразу несколько камер, поймавших обнаружение.
    """
    if len(data) < 4:
        raise ValueError(f"обнаружения: ожидалось хотя бы 4 байта, пришло {len(data)}")

    count, kind, danger, mask = data[0], data[1], data[2], data[3]
    cameras = [bit for bit in range(1, 9) if mask & (1 << (bit - 1))]
    return {
        "count": count,
        "type": kind,
        "type_title": DETECTION_TYPES.get(kind, "неизвестный тип"),
        "danger": danger,
        "danger_title": DANGER_CLASSES.get(danger, "неизвестный класс"),
        "camera_mask": mask,
        "cameras": cameras,
    }


def hex_bytes(data):
    return " ".join(f"{b:02X}" for b in data)


def hex_id(can_id):
    return f"0x{can_id:08X}"
