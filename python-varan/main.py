import time

from camera import CameraStream
from main_config import LOADER_NAME, LOADER_IMG_SIZE, LOADER_MATRIX, LOADER_WEIGHTS_PATH
from manager import CameraManager

def main():
    manager = CameraManager(
        [{
            LOADER_NAME : "loader_1",
            LOADER_WEIGHTS_PATH : "/home/test",
            LOADER_MATRIX: [["Camera_1"], ["Camera_2"]],
            LOADER_IMG_SIZE : 1024
        }]
    )

    cameras = [
        CameraStream(
            "rtsp://admin:VniiTest@192.168.1.11:554/ISAPI/Streaming/Channels/101",
            "Camera_1", None, None, on_frame= manager.on_frame, log=True
        ),
        CameraStream(
            "rtsp://admin:VniiTest@192.168.1.12:554/ISAPI/Streaming/Channels/101",
            "Camera_2", None, None, on_frame= manager.on_frame, log=True
        )
    ]

    for cam in cameras:
        manager.add_camera(cam)

    print("Starting all cameras...")
    manager.start_all()

    try:
        while True:
            time.sleep(2)
            manager.print_camera_queues()

    except KeyboardInterrupt:
        print("Stopping all cameras...")
        manager.stop_all()
        return

if __name__ == "__main__":
    main()