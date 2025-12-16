import logging
import threading
import time
from flask import Flask, Response
import cv2
import numpy as np
from queue import Queue, Empty

from logger import get_logger
from main_config import SERVER_NEURAL_1, SERVER_NEURAL_2, SERVER_NEURAL_3, SERVER_URL_1, SERVER_URL_2, SERVER_URL_3


class MultiCameraServer:
    def __init__(self, max_queue_size=1):
        self.app = Flask(__name__)
        self.logger = get_logger("MultiCameraServer", level=logging.DEBUG)

        # Очереди для 3 камер, в них храним jpeg-кадры (bytes)
        self.frame_queues = {
            SERVER_NEURAL_1: Queue(maxsize=max_queue_size),
            SERVER_NEURAL_2: Queue(maxsize=max_queue_size),
            SERVER_NEURAL_3: Queue(maxsize=max_queue_size),
        }

        # Роуты для камер
        self.app.add_url_rule(SERVER_URL_1, SERVER_NEURAL_1, self.gen_callback(SERVER_NEURAL_1))
        self.app.add_url_rule(SERVER_URL_2, SERVER_NEURAL_2, self.gen_callback(SERVER_NEURAL_2))
        self.app.add_url_rule(SERVER_URL_3, SERVER_NEURAL_3, self.gen_callback(SERVER_NEURAL_3))

    def gen_callback(self, cam_id):
        def generate():
            self.logger.info(f"Start streaming camera {self.logger.c(cam_id, 'cyan')}")
            while True:
                try:
                    frame = self.frame_queues[cam_id].get(timeout=1)
                    self.logger.action_send(
                        f"Sending frame for camera {self.logger.c(cam_id, 'green')}, queue size after get: {self.frame_queues[cam_id].qsize()}")
                except Empty:
                    self.logger.action_recv(
                        f"No frames in queue for camera {self.logger.c(cam_id, 'yellow')}, waiting...")
                    continue

                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')

        # Возвращаем функцию-обработчик Flask
        def flask_handler():
            return Response(generate(), mimetype='multipart/x-mixed-replace; boundary=frame')

        return flask_handler

    def push_frame(self, cam_id: str, image: np.ndarray):
        """
        image — OpenCV BGR numpy array
        """
        self.logger.debug(f"Push frame requested for camera {self.logger.c(cam_id, 'cyan')}")

        # Кодируем в JPEG
        ret, jpeg = cv2.imencode('.jpg', image)
        if not ret:
            self.logger.action_error(f"Failed to encode frame for camera {self.logger.c(cam_id, 'red')}")
            raise RuntimeError("Failed to encode frame")

        jpeg_bytes = jpeg.tobytes()

        q = self.frame_queues[cam_id]
        # Если очередь полна — удаляем самый старый кадр, чтобы освободить место
        if q.full():
            try:
                discarded = q.get_nowait()
                self.logger.debug(f"Queue full for camera {self.logger.c(cam_id, 'yellow')}, discarded oldest frame")
            except Empty:
                self.logger.warning(f"Queue was full but empty on get for camera {self.logger.c(cam_id, 'red')}")

        q.put(jpeg_bytes)
        self.logger.debug(f"Frame pushed for camera {self.logger.c(cam_id, 'green')}, queue size now: {q.qsize()}")

    def run(self, host='0.0.0.0', port=5556):
        self.app.run(host=host, port=port, threaded=True)
