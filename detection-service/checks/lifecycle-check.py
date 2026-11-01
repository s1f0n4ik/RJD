import copy
import os
import tempfile
from pathlib import Path

temporary = tempfile.TemporaryDirectory(prefix="detection-lifecycle-")
os.environ["JOURNAL_DIR"] = temporary.name

import detection_ingress_pb2 as pb
from app.journal import Journal, now_ms
from app.lifecycle import Lifecycle
from app.master import Master


def rejected(fn, *args):
    try:
        fn(*args)
    except ValueError:
        return
    raise AssertionError("Invalid command accepted")


def main():
    journal = Journal(Path(temporary.name))
    journal.open()
    master = Master(journal)
    master.start()
    master.set_active("rsm-2000")
    sent = []
    master.outbox.sender = sent.append
    executor = Lifecycle(master, Path(temporary.name) / "executor.json")

    def packet(number, track):
        value = pb.Packet(id=number, device_id="board", session=1, config_id="model", camera_id="front", ts=now_ms(),
                          tracks=[pb.TrackRecord(track_id=track, event=pb.TRACK_EVENT_CONFIRMED, class_id=0,
                                                 class_name="person", box=[0, 0, 20, 20])])
        master.handle(pb.DeviceMessage(packet=value))

    packet(1, 1)
    old = next(iter(master.rules.detections.values()))
    settings = master.rules.settings.model_dump()
    settings["table"]["cameras"]["front"] = 3
    master.save_rules("rsm-2000", settings)
    packet(2, 2)
    new = list(master.rules.detections.values())[-1]
    assert master.rules._can_request(2, now_ms(), old).camera_no == 0
    assert master.rules._can_request(2, now_ms(), new).camera_no == 3
    count = len(sent)
    stop = {"transition_id": "one", "previous_transition_id": "", "modules": ["detection"]}
    executor.stop(stop)
    executor.stopped()
    assert not master.rules.detections and not master.outbox.enabled and len(sent) == count
    packet(3, 3)
    assert master.rules.detections and len(sent) == count
    package = {"transition_id": "one", "revision": "new", "active": "iskra", "rules": {}}
    bad = copy.deepcopy(package)
    bad["rules"] = {"iskra": {"stitch": {"gap_s": -1}}}
    rejected(executor.apply, bad)
    assert executor.status()["revision"] == ""
    executor.apply(package)
    assert master.active == "iskra" and not master.outbox.enabled
    recovered = Lifecycle(master, executor.path)
    recovered.restore()
    assert recovered.status()["state"] == "stopped" and not master.outbox.enabled
    rejected(recovered.start, {"transition_id": "one", "revision": "wrong"})
    recovered.start({"transition_id": "one", "revision": "new"})
    assert master.outbox.enabled and not master.rules.detections
    rejected(recovered.stop, stop)
    stop2 = {"transition_id": "two", "previous_transition_id": "one", "modules": ["detection"]}
    recovered.stop(stop2)
    recovered.stopped()
    recovered.apply({**package, "transition_id": "two", "revision": "new2", "active": "rsm-2000"})
    recovered.start({"transition_id": "two", "revision": "new2"})
    packet(4, 4)
    assert sent[-1].request.runtime_id == "two"
    assert journal.conn.execute("SELECT COUNT(*) FROM detections").fetchone()[0] == 4
    assert journal.conn.execute("SELECT COUNT(*) FROM detections WHERE ended_at IS NULL").fetchone()[0] == 1
    recovered.stop({"transition_id": "three", "previous_transition_id": "two", "modules": []})
    recovered.stopped()
    recovered.apply({**package, "transition_id": "three", "revision": "empty", "active": ""})
    recovered.start({"transition_id": "three", "revision": "empty"})
    assert not master.outbox.enabled
    executor.path.write_text("[]", encoding="utf-8")
    corrupt = Lifecycle(master, executor.path)
    corrupt.restore()
    assert corrupt.status()["state"] == "stopping" and not master.outbox.enabled
    journal.close()
    print("detection lifecycle-check: OK")


main()
