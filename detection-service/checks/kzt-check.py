import os
import tempfile
from pathlib import Path

temporary = tempfile.TemporaryDirectory(prefix="detection-kzt-")
os.environ["JOURNAL_DIR"] = temporary.name

import detection_ingress_pb2 as pb
from app.journal import Journal, now_ms
from app.master import Master

# Модель КЖТ: суперкласс 0 — ковш (состояния), 1 — грузы; класс без суперкласса — щётка
CLASSES = {
    "bucket-empty": (0, "bucket", 0), "bucket-load": (1, "bucket", 0),
    "sleeper": (2, "cargo", 1), "barrel": (3, "cargo", 1), "rail": (4, "cargo", 1),
    "brush": (5, "", 0),
}


def main():
    journal = Journal(Path(temporary.name))
    journal.open()
    master = Master(journal)
    master.start()
    master.set_active("kzt")
    sent = []
    master.outbox.sender = sent.append
    number = 0

    def tick(*tracks, camera="front", zone=1):
        nonlocal number
        number += 1
        records = []
        for track_id, name in tracks:
            class_id, superclass, place = CLASSES[name]
            records.append(pb.TrackRecord(track_id=track_id, state=pb.TRACK_STATE_CONFIRMED, class_id=class_id,
                                          class_name=name, superclass=superclass, superclass_id=place,
                                          box=[0, 0, 20, 20], zone_id=zone))
        master.handle(pb.DeviceMessage(packet=pb.Packet(id=number, device_id="board", session=1, config_id="model",
                                                        camera_id=camera, ts=now_ms(), tracks=records)))

    def last():
        k = sent[-1].request.kzt
        return list(k.attachments), list(k.cargo), k.period_s

    settings = master.rules.settings.model_dump()
    table = settings["table"]
    table["models"] = {"model": {"classes": {"5": 3}, "superclasses": {"0": 4}}}
    table.update(camera_id="front", zone_id=1, cargo_superclass="cargo", cargo=["sleeper", "barrel", "rail"],
                 allowed={"4": ["sleeper", "barrel"]})
    settings["modbus"]["period_s"] = 30
    master.save_rules("kzt", settings)

    tick((1, "bucket-empty"), (2, "sleeper"), (3, "sleeper"), (4, "rail"))
    # Рельс ковшу не разрешён; суперкласс ковша — код 4
    assert last() == ([4], [2, 0, 0], 30), last()
    assert sent[-1].request.modules == ["modbus"] and sent[-1].request.camera_id == "front"
    count = len(sent)
    # Смена состояния ковша и тот же состав — пакета нет
    tick((1, "bucket-load"), (2, "sleeper"), (3, "sleeper"), (4, "rail"))
    assert len(sent) == count
    # Вне рабочей зоны и с другой камеры не считается
    tick((1, "bucket-load"), (2, "sleeper"), (3, "sleeper"), (4, "rail"), (5, "barrel", ))
    assert last() == ([4], [2, 1, 0], 30), last()
    tick((1, "bucket-load"), (2, "sleeper"), (3, "sleeper"), (4, "rail"), (5, "barrel"), zone=2)
    assert last() == ([4], [0, 0, 0], 30), last()
    tick((9, "brush"), camera="back")
    assert last() == ([4], [0, 0, 0], 30), last()
    # Ковш пропал — навесное залипает; щётка без строки в таблице разрешает всё
    tick((7, "brush"), (8, "rail"))
    assert last() == ([3], [0, 0, 1], 30), last()
    tick((8, "rail"))
    assert last() == ([3], [0, 0, 1], 30), last()
    tick((1, "bucket-empty"), (7, "brush"), (8, "rail"))
    assert last() == ([3, 4], [0, 0, 1], 30), last()

    # Навесное переживает перезапуск мастера и паузу перехода
    restarted = Master(journal)
    restarted.start()
    assert restarted.rules.attachments == [3, 4]
    restarted.pause()
    assert restarted.rules.attachments == [3, 4]
    # Шлюз подключился — состав заново
    resent = []
    restarted.outbox.enabled = True
    restarted.outbox.sender = resent.append
    assert restarted.resend_open() == 1 and list(resent[-1].request.kzt.attachments) == [3, 4]
    # Смена конфигурации шлюза — с нуля
    restarted.set_active("iskra")
    restarted.set_active("kzt")
    assert restarted.rules.attachments == []

    journal.close()
    print("detection kzt-check: OK")


main()
