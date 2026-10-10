import asyncio
import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import detection_ingress_pb2 as pb
import frame_ingress_pb2 as gw

from app.config import settings
from app.journal import Journal, now_ms

logger = logging.getLogger(__name__)

EVENT_NAMES = {value: name.removeprefix("TRACK_EVENT_").lower() for name, value in pb.TrackEvent.items()}

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
    # Пропал последний трек: время, рамка и монотонный срок закрытия
    removed_ts: Optional[int] = None
    removed_box: Box = (0, 0, 0, 0)
    deadline: float = 0.0
    config_id: str = ""
    class_id: int = 0
    class_name: str = ""
    superclass: str = ""
    # Ушло в шлюз; опоздавшее — только в журнал
    sent: bool = False
    # Первый снимок уже назначен в шлюз
    imaged: bool = False
    # Монотонный момент открытия: снимок позже LATE_MS в шлюз не уходит
    opened: float = 0.0


@dataclass
class Track:
    row_id: int
    detection: Detection


@dataclass
class Outgoing:
    request: "gw.FrameRequest"
    # Кадр под рамки и плашку: байты или файл журнала
    jpeg: Optional[bytes] = None
    path: Optional[Path] = None
    gps: Optional[tuple[float, float]] = None


@dataclass
class Shot:
    request: "gw.FrameRequest"
    gps: Optional[tuple[float, float]]
    opened: float


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


class RsmRules:
    # РСМ-2000: каждая камера — свои обнаружения, обрывки трека на камере сшиваются
    id = "rsm-2000"
    title = "РСМ-2000"

    @staticmethod
    def description() -> str:
        return (
            "Каждая камера — свои обнаружения. Обрывки трека на той же камере сшиваются: "
            f"тот же суперкласс, пауза до {settings.STITCH_GAP_MS / 1000:g} с, рядом с прежней рамкой."
        )

    def __init__(self, journal: Journal, outbox: Outbox):
        self.journal = journal
        self.outbox = outbox
        self.tracks: dict[tuple, Track] = {}
        # Открытые обнаружения, в том числе ждущие закрытия
        self.detections: dict[int, Detection] = {}
        # Снимки для шлюза, ждущие свой кадр: (устройство, сессия, id снимка)
        self.shots: dict[tuple, Shot] = {}

    def on_packet(self, packet, received_at: int, late: bool) -> None:
        self._flush_camera(packet.device_id, packet.camera_id, packet.ts)
        for track in packet.tracks:
            # Трек без номера ещё не подтверждён
            if track.track_id == 0:
                continue
            self._on_event(packet, track, received_at, late)
        if packet.image_id:
            self._shot(packet)

    def _request(self, event: int, ts: int, camera_id: str, config_id: str, dets: list) -> "gw.FrameRequest":
        return gw.FrameRequest(ver=1, ts=ts, camera_id=camera_id, config_id=config_id,
                               session=self.outbox.session, event=event, dets=dets)

    # Первый снимок новых обнаружений — в шлюз со всеми отправленными целями пакета
    def _shot(self, packet) -> None:
        visible, fresh = [], []
        for track in packet.tracks:
            state = self.tracks.get((packet.device_id, packet.session, track.track_id))
            if track.track_id == 0 or track.event == pb.TRACK_EVENT_REMOVED or state is None or not state.detection.sent:
                continue
            visible.append(gw_detection(state.detection, track))
            if not state.detection.imaged:
                fresh.append(state.detection)
        if not fresh:
            return
        for detection in fresh:
            detection.imaged = True
        request = self._request(gw.TRACK_EVENT_CONFIRMED, packet.ts, packet.camera_id, packet.config_id, visible)
        request.width, request.height = packet.width, packet.height
        gps = (packet.gps.lat, packet.gps.lon) if packet.gps.valid else None
        shot = Shot(request, gps, max(d.opened for d in fresh))
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
        if time.monotonic() - shot.opened > settings.LATE_MS / 1000:
            logger.info("image for detection(s) %s came late, journal only", [d.detection_id for d in shot.request.dets])
            return
        self.outbox.send(Outgoing(shot.request, jpeg=jpeg, path=path, gps=shot.gps))

    # Открытые отправленные — заново в шлюз после подключения
    def resend(self) -> int:
        sent = [d for d in self.detections.values() if d.sent]
        for detection in sent:
            self.outbox.send(Outgoing(self._request(
                gw.TRACK_EVENT_CONFIRMED, detection.last_ts, detection.camera_id, detection.config_id, [gw_detection(detection)])))
        return len(sent)

    def _on_event(self, packet, track, received_at: int, late: bool) -> None:
        key = (packet.device_id, packet.session, track.track_id)
        box: Box = tuple(track.box) if len(track.box) == 4 else (0, 0, 0, 0)
        state = self.tracks.get(key)
        if state is None:
            state = self._open_track(key, packet, track, box, late)
        else:
            self.journal.touch_track(state.row_id, packet.ts)

        detection = state.detection
        detection.last_ts = max(detection.last_ts, packet.ts)
        self.journal.add_event(
            state.row_id, packet, track, EVENT_NAMES.get(track.event, str(track.event)), received_at, late
        )
        if packet.image_id:
            image = self.journal.image_id(packet.device_id, packet.session, packet.image_id)
            if image is not None:
                self.journal.set_detection_image(detection.id, image)

        if track.event == pb.TRACK_EVENT_REMOVED:
            del self.tracks[key]
            detection.tracks.discard(key)
            if not detection.tracks:
                detection.removed_ts = packet.ts
                detection.removed_box = box
                detection.deadline = time.monotonic() + settings.STITCH_GAP_MS / 1000 + 0.5

    def _open_track(self, key: tuple, packet, track, box: Box, late: bool) -> Track:
        cls = track.superclass or track.class_name or str(track.class_id)
        detection = self._stitch(packet, cls, box)
        if detection is None:
            detection_id = self.journal.add_detection(packet, track, late)
            detection = Detection(
                detection_id, packet.device_id, packet.session, packet.camera_id, cls, packet.ts,
                config_id=packet.config_id, class_id=track.class_id, class_name=track.class_name,
                superclass=track.superclass, sent=not late, opened=time.monotonic(),
            )
            self.detections[detection_id] = detection
            logger.info(
                "detection %d opened: %s %s %s track #%d%s",
                detection_id, packet.device_id[:8], packet.camera_id, cls, track.track_id, " (late)" if late else "",
            )
            if detection.sent:
                self.outbox.send(Outgoing(self._request(
                    gw.TRACK_EVENT_CONFIRMED, packet.ts, packet.camera_id, packet.config_id, [gw_detection(detection, track)])))
        else:
            logger.info("detection %d continues with track #%d", detection.id, track.track_id)
            detection.removed_ts = None
            detection.deadline = 0.0

        state = Track(self.journal.add_track(detection.id, packet, track), detection)
        detection.tracks.add(key)
        self.tracks[key] = state
        return state

    # Ждущее закрытия обнаружение той же камеры, класса, недавнее и рядом
    def _stitch(self, packet, cls: str, box: Box) -> Optional[Detection]:
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
            if gap < 0 or gap > settings.STITCH_GAP_MS:
                continue
            rx, ry = center(detection.removed_box)
            reach = math.hypot(detection.removed_box[2], detection.removed_box[3]) * settings.STITCH_DISTANCE
            distance = math.hypot(cx - rx, cy - ry)
            if distance <= reach and distance < best_distance:
                best, best_distance = detection, distance
        return best

    # Пакет камеры позже паузы сшивки закрывает её ждущие обнаружения
    def _flush_camera(self, device_id: str, camera_id: str, ts: int) -> None:
        for detection in list(self.detections.values()):
            if (
                detection.removed_ts is not None
                and detection.device_id == device_id
                and detection.camera_id == camera_id
                and ts - detection.removed_ts > settings.STITCH_GAP_MS
            ):
                self._close(detection, detection.removed_ts, "removed")

    def tick(self) -> None:
        now = time.monotonic()
        for detection in list(self.detections.values()):
            if detection.removed_ts is not None and detection.deadline <= now:
                self._close(detection, detection.removed_ts, "removed")
        for key, shot in list(self.shots.items()):
            if now - shot.opened > settings.LATE_MS / 1000:
                del self.shots[key]

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
        if detection.sent:
            self.outbox.send(Outgoing(self._request(
                gw.TRACK_EVENT_REMOVED, ended_at, detection.camera_id, detection.config_id, [gw_detection(detection)])))


# Правила по id конфигурации шлюза
RULES = {"rsm-2000": RsmRules}


@dataclass
class Device:
    session: int
    streams: int = 0
    # Монотонный момент, когда закрылся последний поток устройства
    lost_at: Optional[float] = None
    closed_for_loss: bool = False


class Master:
    # Все вызовы — из одного рабочего потока
    def __init__(self, journal: Journal):
        self.journal = journal
        self.devices: dict[str, Device] = {}
        self.active: Optional[str] = None
        self.outbox = Outbox()
        self.rules = RsmRules(journal, self.outbox)

    def start(self) -> None:
        closed = self.journal.close_all_open("master_restart")
        if closed:
            logger.info("%d detection(s) left open by the previous run closed", closed)
        self.active = self.journal.load_active()
        self.rules = self._make_rules(self.active)
        logger.info("rules: %s", self.active or "default")

    def _make_rules(self, active: Optional[str]):
        rules = RULES.get(active or "")
        if rules is None:
            if active is not None:
                logger.warning("no rules for gateway configuration %r, using rsm-2000", active)
            rules = RsmRules
        return rules(self.journal, self.outbox)

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
            self._session(packet.device_id, packet.session)
            if not self.journal.packet_seen(packet.device_id, packet.session, packet.id):
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

    # Шлюз подключился: открытые отправленные — заново
    def resend_open(self) -> int:
        return self.rules.resend()

    # Какую конфигурацию шлюза видит мастер и по каким правилам работает
    def rules_state(self) -> dict:
        return {
            "active": self.active,
            "rules": self.rules.id,
            "title": self.rules.title,
            "description": self.rules.description(),
            "open": len(self.rules.detections),
            "devices": sum(1 for d in self.devices.values() if d.streams > 0),
            "available": [{"id": r.id, "title": r.title, "description": r.description()} for r in RULES.values()],
        }

    def _session(self, device_id: str, session: int) -> None:
        device = self.devices.get(device_id)
        if device is None:
            self.devices[device_id] = Device(session)
            logger.info("device %s session %d", device_id, session)
            return
        if device.session != session:
            logger.info("device %s new session %d (was %d)", device_id, session, device.session)
            self.rules.close_device(device_id, device.session, "device_restart")
            device.session = session
            device.closed_for_loss = False

    def stream_opened(self, device_id: str, peer: str) -> None:
        device = self.devices[device_id]
        device.streams += 1
        device.lost_at = None
        device.closed_for_loss = False
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
        self.rules.tick()
        self.journal.commit()


# Журнал, правила, таймеры и правки из API живут в одном потоке
worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="master")
journal = Journal(Path(settings.JOURNAL_DIR))
master = Master(journal)


async def run(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(worker, fn, *args)
