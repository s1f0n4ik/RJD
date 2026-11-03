# Самопроверка хранилища под чтением и записью из нескольких потоков: cd shit/backend && python checks/config-store-threads-check.py
import os
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
TMP = tempfile.mkdtemp(prefix="config-store-threads-")
os.environ["CONFIG_DB"] = f"{TMP}/api/config.db"
os.environ["CONFIG_ASSETS_DIR"] = f"{TMP}/api/assets"

from app.services.config_store import ConfigStore  # noqa: E402

THREADS = 8
ROUNDS = 300


def main() -> None:
    store = ConfigStore(f"{TMP}/store/config.db", f"{TMP}/store/assets")
    store.create_version("stand", "Стенд", {("place", "main"): {"name": "Основная"}, ("camera", "camera_1"): {"place": "main"}})
    store.set_active("stand")
    expected = (store.context(), store.active_profile(), [(p["id"], p["version_id"]) for p in store.profiles()])
    failures: list[str] = []
    start = threading.Barrier(THREADS)

    def reader() -> None:
        start.wait()
        for _ in range(ROUNDS):
            try:
                got = (store.context(), store.active_profile(), [(p["id"], p["version_id"]) for p in store.profiles()])
                if got != expected:
                    failures.append(f"inconsistent read: {got}")
            except Exception as error:
                failures.append(f"{type(error).__name__}: {error}")

    def writer() -> None:
        start.wait()
        for i in range(ROUNDS // 3):
            try:
                store.put("stand", "camera", "camera_2", {"place": "main", "n": i})
                store.remove("stand", "camera", "camera_2")
            except Exception as error:
                failures.append(f"writer {type(error).__name__}: {error}")

    workers = [threading.Thread(target=reader) for _ in range(THREADS - 1)] + [threading.Thread(target=writer)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    print(f"reads={(THREADS - 1) * ROUNDS} writes={ROUNDS // 3 * 2} failures={len(failures)}")
    for line in sorted(set(failures))[:10]:
        print(" ", line)
    assert not failures, "concurrent store access returned errors or inconsistent data"
    print("config-store-threads-check: OK")


if __name__ == "__main__":
    main()
