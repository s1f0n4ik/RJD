import threading
import time

from camera import CameraStream
from main_config import LOADER_NAME, LOADER_IMG_SIZE, LOADER_MATRIX, LOADER_WEIGHTS_PATH, SERVER_ENDPOINT, \
    SERVER_NEURAL_1, SERVER
from manager import CameraManager
from server import MultiCameraServer


def main():
    server = MultiCameraServer()

    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()

    manager = CameraManager(
        [{
            LOADER_NAME : "loader_1",
            LOADER_WEIGHTS_PATH : "/home/test",
            LOADER_MATRIX: [["Camera_1", "Camera_2"]],  # ← ИСПРАВИЛ: одна строка 2x1
            LOADER_IMG_SIZE : 1024,
            SERVER: server,
            SERVER_ENDPOINT: SERVER_NEURAL_1
        }]
    )

    cameras = [
        CameraStream(
            "rtsp://admin:VniiTest@192.168.1.11:554/ISAPI/Streaming/Channels/101",
            "Camera_1", None, None, on_frame=manager.on_frame, log=True
        ),
        CameraStream(
            "rtsp://admin:VniiTest@192.168.1.12:554/ISAPI/Streaming/Channels/101",
            "Camera_2", None, None, on_frame=manager.on_frame, log=True
        )
    ]

    for cam in cameras:
        manager.add_camera(cam)
        # ❗ ДОБАВЛЯЕМ КАМЕРЫ В СЕРВЕР
        server.cameras[cam.camera_name] = cam

    # ❗ ДОБАВЛЯЕМ LOADERS В СЕРВЕР
    for loader in manager.neural_loaders:
        server.loaders[loader.name] = loader

    print("Starting all cameras...")
    manager.start_all()

    print(f"✅ Registered cameras: {list(server.cameras.keys())}")
    print(f"✅ Registered loaders: {list(server.loaders.keys())}")

    try:
        while True:
            time.sleep(2)

    except KeyboardInterrupt:
        print("Stopping all cameras...")
        manager.stop_all()
        server_thread.join(timeout=1)
        return

if __name__ == "__main__":
    main()
