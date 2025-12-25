import threading
import time

import sys
import termios
import tty
import select

from camera import CameraStream
from main_config import LOADER_NAME, LOADER_IMG_SIZE, LOADER_MATRIX, LOADER_WEIGHTS_PATH, SERVER_ENDPOINT, \
    SERVER_NEURAL_1, SERVER, SERVER_NEURAL_2, LOADER_CLASSES_PATH, SAVE_FILE
from manager import CameraManager
from server import MultiCameraServer

def esc_pressed():
    dr, _, _ = select.select([sys.stdin], [], [], 0)
    if dr:
        ch = sys.stdin.read(1)
        return ch == '\x1b'  # ESC
    return False

def main():
    manager = CameraManager(SAVE_FILE)

    server = MultiCameraServer(manager)
    manager.set_server(server)

    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()

    manager.load_from_file()

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
