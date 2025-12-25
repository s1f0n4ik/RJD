import logging
import threading
import time
from flask import Flask, Response, jsonify, request
import cv2
import numpy as np
from queue import Queue, Empty

from logger import get_logger
from main_config import SERVER_NEURAL_1, SERVER_NEURAL_2, SERVER_NEURAL_3, SERVER_URL_1, SERVER_URL_2, SERVER_URL_3


class MultiCameraServer:
    def __init__(self, manager, max_queue_size=1):
        self.app = Flask(__name__)
        self.logger = get_logger("MultiCameraServer", level=logging.DEBUG)

        # Очереди для 3 камер, в них храним jpeg-кадры (bytes)
        self.URL_IDS = {
            SERVER_URL_1: SERVER_NEURAL_1,
            SERVER_URL_2: SERVER_NEURAL_2,
            SERVER_URL_3: SERVER_NEURAL_3
        }

        self.frame_queues = {
            SERVER_NEURAL_1: Queue(maxsize=max_queue_size),
            SERVER_NEURAL_2: Queue(maxsize=max_queue_size),
            SERVER_NEURAL_3: Queue(maxsize=max_queue_size),
        }

        self.manager = manager

        # Роуты для камер
        self.app.add_url_rule(SERVER_URL_1, SERVER_NEURAL_1, self.gen_callback(SERVER_NEURAL_1))
        self.app.add_url_rule(SERVER_URL_2, SERVER_NEURAL_2, self.gen_callback(SERVER_NEURAL_2))
        self.app.add_url_rule(SERVER_URL_3, SERVER_NEURAL_3, self.gen_callback(SERVER_NEURAL_3))

        # Сервис
        self.app.add_url_rule('/health', 'health', self.health, methods=['GET'])

        # Камеры
        self.app.add_url_rule('/api/cameras', 'get_cameras', self.get_cameras, methods=['GET'])
        self.app.add_url_rule('/api/camera/add', 'add_camera', self.add_camera, methods=['POST'])
        self.app.add_url_rule('/api/camera/status/<camera_name>', 'camera_status', self.camera_status, methods=['GET'])
        self.app.add_url_rule('/api/camera/update/<camera_name>', 'update_camera', self.update_camera, methods=['PUT'])
        self.app.add_url_rule('/api/camera/delete/<camera_name>', 'delete_camera', self.delete_camera,
                              methods=['DELETE'])

        # Загрузчики
        self.app.add_url_rule('/api/loaders', 'get_loaders', self.get_loaders, methods=['GET'])
        self.app.add_url_rule('/api/loader/create', 'create_loader', self.create_loader, methods=['POST'])
        self.app.add_url_rule('/api/loader/status/<loader_name>', 'loader_status', self.loader_status, methods=['GET'])
        self.app.add_url_rule('/api/loader/update/<loader_name>', 'update_loader', self.update_loader, methods=['PUT'])
        self.app.add_url_rule('/api/loader/start/<loader_name>', 'start_loader', self.start_loader, methods=['POST'])
        self.app.add_url_rule('/api/loader/stop/<loader_name>', 'stop_loader', self.stop_loader, methods=['POST'])
        self.app.add_url_rule('/api/loader/delete/<loader_name>', 'delete_loader', self.delete_loader,
                              methods=['DELETE'])

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

    def push_frame(self, endpoint: str, image: np.ndarray):
        """
        image — OpenCV BGR numpy array
        """
        self.logger.debug(f"Push frame requested for camera {self.logger.c(endpoint, 'cyan')}")

        image_bgr = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        ret, jpeg = cv2.imencode('.jpg', image_bgr)
        if not ret:
            self.logger.action_error(f"Failed to encode frame for camera {self.logger.c(endpoint, 'red')}")
            raise RuntimeError("Failed to encode frame")

        jpeg_bytes = jpeg.tobytes()

        q = self.frame_queues[self.URL_IDS[endpoint]]
        # Если очередь полна — удаляем самый старый кадр, чтобы освободить место
        if q.full():
            try:
                discarded = q.get_nowait()
                self.logger.debug(f"Queue full for camera {self.logger.c(endpoint, 'yellow')}, discarded oldest frame")
            except Empty:
                self.logger.warning(f"Queue was full but empty on get for camera {self.logger.c(endpoint, 'red')}")

        q.put(jpeg_bytes)
        self.logger.debug(f"Frame pushed for camera {self.logger.c(endpoint, 'green')}, queue size now: {q.qsize()}")

    def health(self):
        return jsonify({"status": "ok"})

    def get_cameras(self):
        return jsonify(self.manager.handle_command("camera.list", {}))

    def add_camera(self):
        return jsonify(self.manager.handle_command("camera.add", request.json))

    def camera_status(self, camera_name):
        return jsonify(self.manager.handle_command(
            "camera.status", {"camera_name": camera_name}
        ))

    def update_camera(self, camera_name):
        data = dict(request.json)
        data["camera_name"] = camera_name
        return jsonify(self.manager.handle_command("camera.update", data))

    def delete_camera(self, camera_name):
        return jsonify(self.manager.handle_command(
            "camera.delete", {"camera_name": camera_name}
        ))

    def get_loaders(self):
        return jsonify(self.manager.handle_command("loader.list", {}))

    def create_loader(self):
        return jsonify(self.manager.handle_command("loader.create", request.json))

    def loader_status(self, loader_name):
        return jsonify(self.manager.handle_command(
            "loader.status", {"loader_name": loader_name}
        ))

    def start_loader(self, loader_name):
        return jsonify(self.manager.handle_command(
            "loader.start", {"loader_name": loader_name}
        ))

    def stop_loader(self, loader_name):
        return jsonify(self.manager.handle_command(
            "loader.stop", {"loader_name": loader_name}
        ))

    def update_loader(self, loader_name):
        data = dict(request.json)
        data["loader_name"] = loader_name
        return jsonify(self.manager.handle_command("loader.create", data))

    def delete_loader(self, loader_name):
        return jsonify(self.manager.handle_command(
            "loader.delete", {"loader_name": loader_name}
        ))

    def run(self, host='0.0.0.0', port=5557):
        self.app.run(host=host, port=port, threaded=True)
