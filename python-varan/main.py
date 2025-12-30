import threading
import time

from camera import CameraStream
from main_config import SAVE_FILE
from manager import CameraManager
from server import MultiCameraServer
from utility import pretty_json


def main():
    manager = CameraManager(SAVE_FILE)

    server = MultiCameraServer(manager)
    manager.set_server(server)

    server_thread = threading.Thread(
        target=server.run,
        daemon=True,
        name="FlaskServerThread",
    )
    server_thread.start()

    manager.load_from_file()

    print("Server is running. Press Ctrl+C to stop.")

    try:
        while True:
            time.sleep(1)

    except KeyboardInterrupt:
        print("Stopping application...")

    finally:
        print("Stopping all cameras...")
        manager.stop_all()

        print("Stopping server...")
        server_thread.join(timeout=2)

        print("Shutdown complete.")


if __name__ == "__main__":
    main()
