import threading
import time

import sys
import termios
import tty
import select

from camera import CameraStream
from main_config import LOADER_NAME, LOADER_IMG_SIZE, LOADER_MATRIX, LOADER_WEIGHTS_PATH, SERVER_ENDPOINT, \
    SERVER_NEURAL_1, SERVER, SERVER_NEURAL_2, LOADER_CLASSES_PATH
from manager import CameraManager
from server import MultiCameraServer

def esc_pressed():
    dr, _, _ = select.select([sys.stdin], [], [], 0)
    if dr:
        ch = sys.stdin.read(1)
        return ch == '\x1b'  # ESC
    return False

def main():
    server = MultiCameraServer()

    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()

    manager = CameraManager(
        [{
            LOADER_NAME : "loader_1",
            LOADER_WEIGHTS_PATH: "/home/orangepi/python-varan-cameras/models/weights/yolo11n.rknn",
            LOADER_CLASSES_PATH: "/home/orangepi/python-varan-cameras/models/classes/classes-coco.json",
            LOADER_MATRIX: [["Camera_1"], ["Camera_2"]],
            LOADER_IMG_SIZE : 1024,
            SERVER: server,
            SERVER_ENDPOINT: SERVER_NEURAL_1
        },
        {
            LOADER_NAME: "loader_2",
            LOADER_WEIGHTS_PATH: "/home/orangepi/python-varan-cameras/models/weights/yolo11n.rknn",
            LOADER_CLASSES_PATH: "/home/orangepi/python-varan-cameras/models/classes/classes-coco.json",
            LOADER_MATRIX: [["Camera_3"], ["Camera_4"]],
            LOADER_IMG_SIZE: 1024,
            SERVER: server,
            SERVER_ENDPOINT: SERVER_NEURAL_2
        }
        ]
    )

    cameras = [
        CameraStream(
            "rtsp://admin:VniiTest@192.168.1.11:554/ISAPI/Streaming/Channels/102",
            "Camera_1", None, None, on_frame= manager.on_frame, log_level=1
        ),
        CameraStream(
            "rtsp://admin:VniiTest@192.168.1.12:554/ISAPI/Streaming/Channels/102",
            "Camera_2", None, None, on_frame= manager.on_frame, log_level=1
        ),
        CameraStream(
            "rtsp://admin:VniiTest@192.168.1.13:554/cam/realmonitor?channel=1&subtype=0",
            "Camera_3", None, None, on_frame= manager.on_frame, log_level=1
        ),
        CameraStream(
            "rtsp://admin:VniiTest@192.168.1.14:554/cam/realmonitor?channel=1&subtype=0",
            "Camera_4", None, None, on_frame= manager.on_frame, log_level=1
        )
    ]

    for cam in cameras:
        manager.add_camera(cam)

    print("Starting all cameras...")
    manager.start_all()

    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)

    try:
        tty.setcbreak(fd)
        print("Press ESC to stop...")

        while True:
            if esc_pressed():
                print("ESC pressed")
                break
            time.sleep(0.1)

    except KeyboardInterrupt:
        pass

    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
        print("Stopping all cameras...")
        manager.stop_all()
        server_thread.join(timeout=1)

if __name__ == "__main__":
    main()
