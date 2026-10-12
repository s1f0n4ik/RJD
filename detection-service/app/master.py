import asyncio
import logging
import math
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from pydantic import BaseModel

import detection_ingress_pb2 as pb
import frame_ingress_pb2 as gw

from app.config import settings
from app.journal import Journal, now_ms
from app.rules import IskraSettings, RsmSettings, RulesStore

logger = logging.getLogger(__name__)

EVENT_NAMES = {value: name.removeprefix("TRACK_EVENT_").lower() for name, value in pb.TrackEvent.items()}
NO_EVENT = pb.TRACK_EVENT_UNSPECIFIED
FEED_SIZE = 200
# Зона записи Искры, пока зон на полотне нет: полоса отвода
ISKRA_ZONE = 3

# Рамка x, y, w, h
Box = tuple[int, int, int, int]


def center(box: Box) -> tuple[float, float]:
    return box[0] + box[2] / 2, box[1] + box[3] / 2


@dataclass
class Detection:
    id: int
    device_id: str
    session: int
    camera_id: str
    key: str
    last_ts: int
    # Открытые треки: (устройство, сессия, номер трека)
    tracks: set = field(default_factory=set)
    # Пропал последний трек: время, рамка, причина и монотонный срок закрытия
    removed_ts: Optional[int] = None
    removed_box: Box = (0, 0, 0, 0)
    close_reason: str = "removed"
    deadline: float = 0.0
    config_id: str = ""
    class_id: int = 0
    class_name: str = ""
    superclass: str = ""
    confidence: float = 0.0
    # Опоздавшее — только в журнал
    late: bool = False
    # Модули, получившие «Подтверждён»
    sent_to: set = field(default_factory=set)
    # Первый снимок уже назначен в шлюз
    imaged: bool = False
    # Монотонный момент открытия, время и координаты первого кадра
    opened: float = 0.0
    opened_ts: int = 0
    gps: Optional[tuple[float, float]] = None
    # Искра: запись уже собрана
    recorded: bool = False


@dataclass
class Track:
    row_id: int
    detection: Detection
    camera_id: str
    last_ts: int
    box: Box


@dataclass
class Outgoing:
    request: "gw.FrameRequest"
    # Кадр под рамки и плашку: байты или файл журнала
    jpeg: Optional[bytes] = None
    path: Optional[Path] = None
    gps: Optional[tuple[float, float]] = None
    # Строка ленты; None — досылка, в ленту не попадает
    entry: Optional[dict] = None


@dataclass
class Shot:
    request: "gw.FrameRequest"
    gps: Optional[tuple[float, float]]
    opened: float
    entry: dict
    late_s: float


class Feed:
    # Лента отправленного в шлюз и счётчики модулей; пишут поток мастера и цикл событий
    def __init__(self):
        self.lock = threading.Lock()
        self.entries: deque = deque(maxlen=FEED_SIZE)
        self.pending: dict[int, dict] = {}
        self.counters: dict[str, dict] = {}
        self.seq = 0

    def _count(self, module: str, key: str) -> None:
        counters = self.counters.setdefault(module, {"sent": 0, "accepted": 0, "rejected": 0, "filtered": 0, "dropped": 0})
        counters[key] += 1

    def add(self, module: str, event: str, detection_id: int, class_name: str, camera_id: str, **extra) -> dict:
        with self.lock:
            self.seq += 1
            entry = {
                "seq": self.seq, "t": now_ms(), "module": module, "event": event, "detection_id": detection_id,
                "class_name": class_name, "camera_id": camera_id, "status": "new", **extra,
            }
            self.entries.append(entry)
            return entry

    # Кадр опоздал: в шлюз не ушёл
    def late(self, entry: dict) -> None:
        with self.lock:
            entry["status"] = "late"
            self._count(entry["module"], "dropped")

    def filtered(self, module: str) -> None:
        with self.lock:
            self._count(module, "filtered")

    def queued(self, entry: Optional[dict], request_id: int) -> None:
        if entry is None:
            return
        with self.lock:
            entry["status"] = "sent"
            self.pending[request_id] = entry
            self._count(entry["module"], "sent")

    def dropped(self, entry: Optional[dict]) -> None:
        if entry is None:
            return
        with self.lock:
            entry["status"] = "dropped"
            self._count(entry["module"], "dropped")

    def replied(self, request_id: int, accepted: bool) -> Optional[dict]:
        with self.lock:
            entry = self.pending.pop(request_id, None)
            if entry is not None:
                entry["status"] = "accepted" if accepted else "rejected"
                self._count(entry["module"], "accepted" if accepted else "rejected")
            return entry

    # Связь со шлюзом оборвалась: ответа на ушедшее уже не будет
    def lost(self) -> None:
        with self.lock:
            for entry in self.pending.values():
                entry["status"] = "dropped"
                self._count(entry["module"], "dropped")
            self.pending.clear()

    def snapshot(self) -> dict:
        with self.lock:
            return {"feed": [dict(e) for e in reversed(self.entries)], "counters": {k: dict(v) for k, v in self.counters.items()}}


class Outbox:
    # Сообщения мастера в шлюз; отправку подставляет main
    def __init__(self):
        self.session = now_ms()
        self.send: Callable[[Outgoing], None] = lambda message: None


def gw_detection(detection: Detection, track=None) -> "gw.Detection":
    d = gw.Detection(detection_id=detection.id, cid=detection.class_id, cls=detection.class_name, scls=detection.superclass)
    if track is not None:
        d.cid, d.cls, d.scls, d.cf = track.class_id, track.class_name, track.superclass, track.confidence
        if len(track.box) == 4:
            d.box.extend(track.box)
    return d


class Rules:
    # Каждая камера — свои обнаружения, обрывки трека на камере сшиваются; что и куда слать — наследники
    id = ""
    title = ""
    description = ""
    model: type[BaseModel] = RsmSettings
    modules: tuple[str, ...] = ()

    def __init__(self, journal: Journal, outbox: Outbox, feed: Feed, rules: BaseModel):
        self.journal = journal
        self.outbox = outbox
        self.feed = feed
        self.settings = rules
        self.tracks: dict[tuple, Track] = {}
        # Открытые обнаружения, в том числе ждущие закрытия
        self.detections: dict[int, Detection] = {}
        # Монотонный момент последнего пакета камеры: (устройство, сессия, камера)
        self.cameras: dict[tuple, float] = {}
        self.opened_total = 0

    def apply(self, rules: BaseModel) -> None:
        self.settings = rules

    def _request(self, event: int, ts: int, camera_id: str, config_id: str, dets: list, module: str) -> "gw.FrameRequest":
        return gw.FrameRequest(ver=1, ts=ts, camera_id=camera_id, config_id=config_id,
                               session=self.outbox.session, event=event, dets=dets, modules=[module])

    def on_packet(self, packet, received_at: int, late: bool) -> None:
        self._flush_camera(packet.device_id, packet.camera_id, packet.ts)
        # Такт целиком: у всех треков есть состояние (старый media-center шлёт только события)
        whole = all(t.state != pb.TRACK_STATE_UNSPECIFIED for t in packet.tracks)
        seen = set()
        for track in packet.tracks:
            # Трек без номера ещё не подтверждён
            if track.track_id == 0:
                continue
            seen.add(track.track_id)
            self._on_track(packet, track, received_at, late)
        if whole:
            self._missing(packet, seen)
        self.cameras[(packet.device_id, packet.session, packet.camera_id)] = time.monotonic()
        if packet.image_id:
            self._shot(packet)

    def _on_track(self, packet, track, received_at: int, late: bool) -> None:
        key = (packet.device_id, packet.session, track.track_id)
        box: Box = tuple(track.box) if len(track.box) == 4 else (0, 0, 0, 0)
        state = self.tracks.get(key)
        if state is None:
            # «Удалён» трека без открытого обнаружения ничего не открывает
            if track.event == pb.TRACK_EVENT_REMOVED:
                logger.info("track #%d of %s removed with no open detection, skipped", track.track_id, packet.device_id[:8])
                return
            state = self._open_track(key, packet, track, box, late)
        state.last_ts = max(state.last_ts, packet.ts)
        state.box = box
        detection = state.detection
        detection.last_ts = max(detection.last_ts, packet.ts)

        # Такт без события живёт только в памяти
        if track.event == NO_EVENT:
            return
        self.journal.touch_track(state.row_id, packet.ts)
        self.journal.add_event(
            state.row_id, packet, track, EVENT_NAMES.get(track.event, str(track.event)), received_at, late
        )
        if packet.image_id:
            image = self.journal.image_id(packet.device_id, packet.session, packet.image_id)
            if image is not None:
                self.journal.set_detection_image(detection.id, image)
        if track.event == pb.TRACK_EVENT_REMOVED:
            self._drop_track(key, state, packet.ts, "removed")

    # Открытый трек камеры, которого нет в её полном такте, пропал без «Удалён»
    def _missing(self, packet, seen: set) -> None:
        for key, state in list(self.tracks.items()):
            if (
                key[0] == packet.device_id and key[1] == packet.session and key[2] not in seen
                and state.camera_id == packet.camera_id
            ):
                logger.info("track #%d of %s missing from camera %s tick", key[2], key[0][:8], packet.camera_id)
                self._drop_track(key, state, state.last_ts, "missing")

    def _drop_track(self, key: tuple, state: Track, ts: int, reason: str) -> None:
        del self.tracks[key]
        if reason != "removed":
            self.journal.touch_track(state.row_id, state.last_ts)
        detection = state.detection
        detection.tracks.discard(key)
        if not detection.tracks:
            detection.removed_ts = ts
            detection.removed_box = state.box
            detection.close_reason = reason
            detection.deadline = time.monotonic() + self.settings.stitch.gap_s + 0.5

    def _open_track(self, key: tuple, packet, track, box: Box, late: bool) -> Track:
        cls = track.superclass or track.class_name or str(track.class_id)
        detection = self._stitch(packet, cls, box)
        if detection is None:
            detection_id = self.journal.add_detection(packet, track, late)
            detection = Detection(
                detection_id, packet.device_id, packet.session, packet.camera_id, cls, packet.ts,
                config_id=packet.config_id, class_id=track.class_id, class_name=track.class_name,
                superclass=track.superclass, confidence=track.confidence, late=late,
                opened=time.monotonic(), opened_ts=packet.ts,
                gps=(packet.gps.lat, packet.gps.lon) if packet.gps.valid else None,
            )
            self.detections[detection_id] = detection
            self.opened_total += 1
            logger.info(
                "detection %d opened: %s %s %s track #%d%s",
                detection_id, packet.device_id[:8], packet.camera_id, cls, track.track_id, " (late)" if late else "",
            )
            if not late:
                self.on_opened(detection, track, packet)
        else:
            logger.info("detection %d continues with track #%d", detection.id, track.track_id)
            detection.removed_ts = None
            detection.deadline = 0.0

        state = Track(self.journal.add_track(detection.id, packet, track), detection, packet.camera_id, packet.ts, box)
        detection.tracks.add(key)
        self.tracks[key] = state
        return state

    # Ждущее закрытия обнаружение той же камеры, класса, недавнее и рядом
    def _stitch(self, packet, cls: str, box: Box) -> Optional[Detection]:
        gap_ms = self.settings.stitch.gap_s * 1000
        cx, cy = center(box)
        best, best_distance = None, math.inf
        for detection in self.detections.values():
            if (
                detection.removed_ts is None
                or detection.device_id != packet.device_id
                or detection.session != packet.session
                or detection.camera_id != packet.camera_id
                or detection.key != cls
            ):
                continue
            gap = packet.ts - detection.removed_ts
            if gap < 0 or gap > gap_ms:
                continue
            rx, ry = center(detection.removed_box)
            reach = math.hypot(detection.removed_box[2], detection.removed_box[3]) * self.settings.stitch.distance
            distance = math.hypot(cx - rx, cy - ry)
            if distance <= reach and distance < best_distance:
                best, best_distance = detection, distance
        return best

    # Пакет камеры позже паузы сшивки закрывает её ждущие обнаружения
    def _flush_camera(self, device_id: str, camera_id: str, ts: int) -> None:
        gap_ms = self.settings.stitch.gap_s * 1000
        for detection in list(self.detections.values()):
            if (
                detection.removed_ts is not None
                and detection.device_id == device_id
                and detection.camera_id == camera_id
                and ts - detection.removed_ts > gap_ms
            ):
                self._close(detection, detection.removed_ts, detection.close_reason)

    # Связь с устройством вернулась: его камеры отсчитывают тишину заново
    def touch_device(self, device_id: str) -> None:
        now = time.monotonic()
        for key in self.cameras:
            if key[0] == device_id:
                self.cameras[key] = now

    def tick(self, connected: set) -> None:
        now = time.monotonic()
        for camera, last in list(self.cameras.items()):
            if now - last < settings.SILENCE_SEC:
                continue
            keys = [k for k, s in self.tracks.items() if k[0] == camera[0] and k[1] == camera[1] and s.camera_id == camera[2]]
            if not keys:
                del self.cameras[camera]
            elif camera[0] in connected:
                logger.info("camera %s of %s silent for %.1f s, %d track(s) closed", camera[2], camera[0][:8], now - last, len(keys))
                for key in keys:
                    state = self.tracks[key]
                    self._drop_track(key, state, state.last_ts, "silence")
        for detection in list(self.detections.values()):
            if detection.removed_ts is not None and detection.deadline <= now:
                self._close(detection, detection.removed_ts, detection.close_reason)

    def close_device(self, device_id: str, session: int, reason: str) -> None:
        for detection in list(self.detections.values()):
            if detection.device_id == device_id and detection.session == session:
                self._close(detection, detection.removed_ts or detection.last_ts, reason)

    def close_all(self, reason: str) -> None:
        for detection in list(self.detections.values()):
            self._close(detection, detection.removed_ts or detection.last_ts, reason)

    def _close(self, detection: Detection, ended_at: int, reason: str) -> None:
        self.journal.close_detection(detection.id, ended_at, reason)
        for key in detection.tracks:
            self.tracks.pop(key, None)
        del self.detections[detection.id]
        logger.info("detection %d closed: %s", detection.id, reason)
        self.on_closed(detection, ended_at)

    # ── Отправка: решают наследники ──

    def on_opened(self, detection: Detection, track, packet) -> None:
        pass

    def on_closed(self, detection: Detection, ended_at: int) -> None:
        pass

    def _shot(self, packet) -> None:
        pass

    def on_image(self, image) -> None:
        pass

    def on_reply(self, entry: dict) -> None:
        pass

    # Шлюз подключился: открытое досылается; возвращает число досланного
    def resend(self) -> int:
        return 0


class RsmRules(Rules):
    id = "rsm-2000"
    title = "РСМ-2000"
    description = "Каждая камера — свои обнаружения, обрывки трека на камере сшиваются. ЦПУ получает кадр нового обнаружения, CAN — список открытых."
    model = RsmSettings
    modules = ("websocket", "can")

    def __init__(self, *args):
        super().__init__(*args)
        # Снимки для ЦПУ, ждущие свой кадр: (устройство, сессия, id снимка)
        self.shots: dict[tuple, Shot] = {}

    def _ws_takes(self, detection: Detection) -> bool:
        ws = self.settings.websocket
        return not detection.late and ws.enabled and ws.allows(detection.class_name, detection.superclass)

    def on_opened(self, detection: Detection, track, packet) -> None:
        can = self.settings.can
        if not (can.enabled and can.allows(detection.class_name, detection.superclass)):
            self.feed.filtered("can")
            return
        detection.sent_to.add("can")
        entry = self.feed.add("can", "confirmed", detection.id, detection.class_name, detection.camera_id,
                              confidence=track.confidence)
        self.outbox.send(Outgoing(self._request(
            gw.TRACK_EVENT_CONFIRMED, packet.ts, packet.camera_id, packet.config_id, [gw_detection(detection, track)], "can"), entry=entry))

    def on_closed(self, detection: Detection, ended_at: int) -> None:
        if "can" not in detection.sent_to:
            return
        entry = self.feed.add("can", "removed", detection.id, detection.class_name, detection.camera_id)
        self.outbox.send(Outgoing(self._request(
            gw.TRACK_EVENT_REMOVED, ended_at, detection.camera_id, detection.config_id, [gw_detection(detection)], "can"), entry=entry))

    # Первый снимок новых обнаружений — в ЦПУ со всеми целями кадра, которые ЦПУ берёт
    def _shot(self, packet) -> None:
        visible, fresh = [], []
        for track in packet.tracks:
            state = self.tracks.get((packet.device_id, packet.session, track.track_id))
            if track.track_id == 0 or track.event == pb.TRACK_EVENT_REMOVED or state is None:
                continue
            detection = state.detection
            if not self._ws_takes(detection):
                if not detection.late and not detection.imaged:
                    detection.imaged = True
                    self.feed.filtered("websocket")
                continue
            visible.append(gw_detection(detection, track))
            if not detection.imaged:
                fresh.append((detection, track))
        if not fresh:
            return
        for detection, _ in fresh:
            detection.imaged = True
        first, track = fresh[0]
        request = self._request(gw.TRACK_EVENT_CONFIRMED, packet.ts, packet.camera_id, packet.config_id, visible, "websocket")
        request.width, request.height = packet.width, packet.height
        gps = (packet.gps.lat, packet.gps.lon) if packet.gps.valid else None
        entry = self.feed.add("websocket", "confirmed", first.id, first.class_name, first.camera_id,
                              confidence=track.confidence, more=[d.id for d, _ in fresh[1:]])
        shot = Shot(request, gps, max(d.opened for d, _ in fresh), entry, self.settings.websocket.late_s)
        path = self.journal.image_path(packet.device_id, packet.session, packet.image_id)
        if path is None:
            self.shots[(packet.device_id, packet.session, packet.image_id)] = shot
        else:
            self._send_shot(shot, path=path)

    def on_image(self, image) -> None:
        shot = self.shots.pop((image.device_id, image.session, image.id), None)
        if shot is not None:
            self._send_shot(shot, jpeg=image.jpeg)

    def _send_shot(self, shot: Shot, jpeg: Optional[bytes] = None, path: Optional[Path] = None) -> None:
        if time.monotonic() - shot.opened > shot.late_s:
            logger.info("image for detection(s) %s came late, journal only", [d.detection_id for d in shot.request.dets])
            self.feed.late(shot.entry)
            return
        self.outbox.send(Outgoing(shot.request, jpeg=jpeg, path=path, gps=shot.gps, entry=shot.entry))

    # Открытые, ушедшие в CAN, — заново; без них — пустое «Удалён» с сессией мастера
    def resend(self) -> int:
        sent = [d for d in self.detections.values() if "can" in d.sent_to]
        for detection in sent:
            self.outbox.send(Outgoing(self._request(
                gw.TRACK_EVENT_CONFIRMED, detection.last_ts, detection.camera_id, detection.config_id, [gw_detection(detection)], "can")))
        if not sent:
            self.outbox.send(Outgoing(self._request(gw.TRACK_EVENT_REMOVED, now_ms(), "", "", [], "can")))
        return len(sent)

    def tick(self, connected: set) -> None:
        super().tick(connected)
        now = time.monotonic()
        for key, shot in list(self.shots.items()):
            if now - shot.opened > shot.late_s:
                del self.shots[key]
                self.feed.late(shot.entry)


class IskraRules(Rules):
    id = "iskra"
    title = "Искра"
    description = "Каждая камера — свои обнаружения, обрывки трека на камере сшиваются. Modbus получает запись 28163 на обнаружение."
    model = IskraSettings
    modules = ("modbus",)

    def __init__(self, *args):
        super().__init__(*args)
        # Записи, ещё не принятые шлюзом: id обнаружения → запрос
        self.pending: dict[int, "gw.FrameRequest"] = {}

    def _record(self, detection: Detection) -> None:
        detection.recorded = True
        if detection.late:
            return
        modbus = self.settings.modbus
        code = modbus.codes.get(detection.class_name)
        if not modbus.enabled or code is None:
            self.feed.filtered("modbus")
            return
        role = modbus.roles.get(detection.camera_id, 0)
        mask = 1 << (role - 1) if role else 0
        record = gw.Record(code=code, frame_id=detection.id & 0xFFFFFFFF, camera_mask=mask, zone=ISKRA_ZONE,
                           count=1, ts=detection.opened_ts)
        if detection.gps is not None:
            record.gps.CopyFrom(gw.GpsData(lat=detection.gps[0], lon=detection.gps[1], valid=True))
        request = self._request(gw.TRACK_EVENT_CONFIRMED, detection.opened_ts, detection.camera_id, detection.config_id,
                                [gw_detection(detection)], "modbus")
        request.record.CopyFrom(record)
        self.pending[detection.id] = request
        self._send_record(detection.id, request)

    def _send_record(self, detection_id: int, request) -> None:
        record = request.record
        entry = self.feed.add("modbus", "record", detection_id, request.dets[0].cls, request.camera_id,
                              code=record.code, camera_mask=record.camera_mask, zone=record.zone)
        self.outbox.send(Outgoing(request, entry=entry))

    def on_closed(self, detection: Detection, ended_at: int) -> None:
        if not detection.recorded:
            self._record(detection)

    def on_reply(self, entry: dict) -> None:
        if entry["module"] == "modbus" and entry["status"] == "accepted":
            self.pending.pop(entry["detection_id"], None)

    def resend(self) -> int:
        for detection_id, request in list(self.pending.items()):
            self._send_record(detection_id, request)
        return len(self.pending)

    def tick(self, connected: set) -> None:
        super().tick(connected)
        now = time.monotonic()
        ceiling = self.settings.modbus.ceiling_s
        for detection in self.detections.values():
            if not detection.recorded and now - detection.opened >= ceiling:
                self._record(detection)


# Правила по id конфигурации шлюза
RULES: dict[str, type[Rules]] = {"rsm-2000": RsmRules, "iskra": IskraRules}


@dataclass
class Device:
    session: int
    streams: int = 0
    # Монотонный момент, когда закрылся последний поток устройства
    lost_at: Optional[float] = None
    closed_for_loss: bool = False
    # Наибольший принятый номер пакета сессии: пакеты устройства идут по порядку
    last_packet: int = 0
    packets: int = 0
    rate: float = 0.0
    delay_ms: int = 0


class Master:
    # Все вызовы — из одного рабочего потока
    def __init__(self, journal: Journal):
        self.journal = journal
        self.store = RulesStore(Path(settings.JOURNAL_DIR))
        self.feed = Feed()
        self.devices: dict[str, Device] = {}
        self.active: Optional[str] = None
        self.outbox = Outbox()
        self.rules: Rules = self._make_rules(None)
        self.rate_at = time.monotonic()

    def start(self) -> None:
        closed = self.journal.close_all_open("master_restart")
        if closed:
            logger.info("%d detection(s) left open by the previous run closed", closed)
        self.active = self.journal.load_active()
        self.rules = self._make_rules(self.active)
        logger.info("rules: %s", self.active or "default")

    def _rules_class(self, config_id: Optional[str]) -> type[Rules]:
        rules = RULES.get(config_id or "")
        if rules is None:
            if config_id is not None:
                logger.warning("no rules for gateway configuration %r, using rsm-2000", config_id)
            rules = RsmRules
        return rules

    def _make_rules(self, active: Optional[str]) -> Rules:
        rules = self._rules_class(active)
        return rules(self.journal, self.outbox, self.feed, self.store.load(rules.id, rules.model))

    def set_active(self, active: str) -> None:
        if active == self.active:
            return
        if self.active is None:
            logger.info("gateway configuration %s", active)
        else:
            logger.info("gateway configuration %s -> %s, open detections closed", self.active, active)
            self.rules.close_all("config_changed")
            self.journal.commit()
        self.active = active
        self.rules = self._make_rules(active)
        self.journal.save_active(active)

    # Сообщение устройства: запись в журнал, затем подтверждение
    def handle(self, message) -> tuple[str, "pb.Ack"]:
        received_at = now_ms()
        ack = pb.Ack()
        if message.HasField("packet"):
            packet = message.packet
            device = self._session(packet.device_id, packet.session)
            device.packets += 1
            device.delay_ms = packet.delay_ms
            if packet.id > device.last_packet:
                device.last_packet = packet.id
                self.rules.on_packet(packet, received_at, packet.delay_ms > settings.LATE_MS)
            ack.packet_ids.append(packet.id)
            device_id = packet.device_id
        else:
            image = message.image
            self._session(image.device_id, image.session)
            image_id = self.journal.add_image(image, received_at)
            if image_id is not None:
                for detection_id in self.journal.detections_for_image(image.device_id, image.session, image.id):
                    self.journal.set_detection_image(detection_id, image_id)
                self.rules.on_image(image)
            ack.image_ids.append(image.id)
            device_id = image.device_id
        self.journal.commit()
        return device_id, ack

    # Шлюз подключился: открытое — заново
    def resend_open(self) -> int:
        return self.rules.resend()

    # Ответ шлюза на сообщение с лентой
    def on_reply(self, entry: dict) -> None:
        self.rules.on_reply(entry)

    def _rules_info(self, rules: type[Rules]) -> dict:
        return {"id": rules.id, "title": rules.title, "description": rules.description, "modules": list(rules.modules)}

    # Какую конфигурацию шлюза видит мастер и по каким правилам работает
    def rules_state(self) -> dict:
        return {
            "active": self.active,
            "rules": self.rules.id,
            "title": self.rules.title,
            "description": self.rules.description,
            "open": len(self.rules.detections),
            "devices": sum(1 for d in self.devices.values() if d.streams > 0),
            "available": [self._rules_info(r) for r in RULES.values()],
        }

    # Настройки правил конфигурации и окружение мастера
    def rules_settings(self, config_id: str) -> Optional[dict]:
        rules = RULES.get(config_id)
        if rules is None:
            return None
        current = self.rules.settings if self.rules.id == config_id else self.store.load(rules.id, rules.model)
        return {
            **self._rules_info(rules),
            "settings": current.model_dump(),
            "defaults": rules.model().model_dump(),
            "saved_at": self.store.saved_at(config_id),
            "env": {"late_s": settings.LATE_MS / 1000, "silence_s": settings.SILENCE_SEC, "link_lost_s": settings.LINK_LOST_SEC},
        }

    # Сохранение действует сразу и только на новые обнаружения
    def save_rules(self, config_id: str, body: dict) -> dict:
        rules = RULES[config_id]
        parsed = rules.model.model_validate(body)
        self.store.save(config_id, parsed)
        if self.rules.id == config_id:
            self.rules.apply(parsed)
        logger.info("rules %s saved", config_id)
        return self.rules_settings(config_id)

    # Цепочка устройства → мастер → шлюз → модули и лента для экрана конфигураций
    def link_state(self) -> dict:
        snapshot = self.feed.snapshot()
        return {
            "active": self.active,
            "rules": self.rules.id,
            "devices": [
                {"id": device_id, "connected": d.streams > 0, "packets_per_s": round(d.rate, 1), "delay_ms": d.delay_ms}
                for device_id, d in self.devices.items()
            ],
            "master": {
                "tracks": len(self.rules.tracks),
                "open": len(self.rules.detections),
                "opened": self.rules.opened_total,
                "session": self.outbox.session,
            },
            **snapshot,
        }

    def _session(self, device_id: str, session: int) -> Device:
        device = self.devices.get(device_id)
        if device is None:
            device = self.devices[device_id] = Device(session)
            logger.info("device %s session %d", device_id, session)
        elif device.session != session:
            logger.info("device %s new session %d (was %d)", device_id, session, device.session)
            self.rules.close_device(device_id, device.session, "device_restart")
            device.session = session
            device.closed_for_loss = False
            device.last_packet = 0
        return device

    def stream_opened(self, device_id: str, peer: str) -> None:
        device = self.devices[device_id]
        device.streams += 1
        device.lost_at = None
        device.closed_for_loss = False
        self.rules.touch_device(device_id)
        logger.info("device %s connected from %s", device_id, peer)

    def stream_closed(self, device_id: str) -> None:
        device = self.devices.get(device_id)
        if device is None:
            return
        device.streams = max(0, device.streams - 1)
        if device.streams == 0:
            device.lost_at = time.monotonic()
            logger.info("device %s disconnected", device_id)

    def tick(self) -> None:
        now = time.monotonic()
        elapsed = now - self.rate_at
        if elapsed >= 1.0:
            for device in self.devices.values():
                device.rate = device.packets / elapsed
                device.packets = 0
            self.rate_at = now
        for device_id, device in self.devices.items():
            if (
                device.streams == 0
                and device.lost_at is not None
                and not device.closed_for_loss
                and now - device.lost_at >= settings.LINK_LOST_SEC
            ):
                logger.info("device %s lost for %.0f s", device_id, now - device.lost_at)
                self.rules.close_device(device_id, device.session, "link_lost")
                device.closed_for_loss = True
        self.rules.tick({device_id for device_id, d in self.devices.items() if d.streams > 0})
        self.journal.commit()


# Журнал, правила, таймеры и правки из API живут в одном потоке
worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="master")
journal = Journal(Path(settings.JOURNAL_DIR))
master = Master(journal)


async def run(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(worker, fn, *args)
