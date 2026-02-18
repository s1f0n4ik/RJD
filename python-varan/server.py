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
    def __init__(self, max_queue_size=1):
        self.app = Flask(__name__)
        self.logger = get_logger("MultiCameraServer", level=logging.DEBUG)

        self.frame_queues = {
            SERVER_NEURAL_1: Queue(maxsize=max_queue_size),
            SERVER_NEURAL_2: Queue(maxsize=max_queue_size),
            SERVER_NEURAL_3: Queue(maxsize=max_queue_size),
        }

        self.app.add_url_rule(SERVER_URL_1, SERVER_NEURAL_1, self.gen_callback(SERVER_NEURAL_1))
        self.app.add_url_rule(SERVER_URL_2, SERVER_NEURAL_2, self.gen_callback(SERVER_NEURAL_2))
        self.app.add_url_rule(SERVER_URL_3, SERVER_NEURAL_3, self.gen_callback(SERVER_NEURAL_3))

        self.app.add_url_rule('/health', 'health', self.health, methods=['GET'])

        self.app.add_url_rule('/api/cameras', 'get_cameras', self.get_cameras, methods=['GET'])
        self.app.add_url_rule('/api/camera/add', 'add_camera', self.add_camera, methods=['POST'])
        self.app.add_url_rule('/api/camera/status/<camera_name>', 'camera_status', self.camera_status, methods=['GET'])
        self.app.add_url_rule('/api/camera/update/<camera_name>', 'update_camera', self.update_camera, methods=['PUT'])
        self.app.add_url_rule('/api/camera/delete/<camera_name>', 'delete_camera', self.delete_camera,
                              methods=['DELETE'])

        self.app.add_url_rule('/api/loaders', 'get_loaders', self.get_loaders, methods=['GET'])
        self.app.add_url_rule('/api/loader/create', 'create_loader', self.create_loader, methods=['POST'])
        self.app.add_url_rule('/api/loader/status/<loader_name>', 'loader_status', self.loader_status, methods=['GET'])
        self.app.add_url_rule('/api/loader/update/<loader_name>', 'update_loader', self.update_loader, methods=['PUT'])
        self.app.add_url_rule('/api/loader/start/<loader_name>', 'start_loader', self.start_loader, methods=['POST'])
        self.app.add_url_rule('/api/loader/stop/<loader_name>', 'stop_loader', self.stop_loader, methods=['POST'])
        self.app.add_url_rule('/api/loader/delete/<loader_name>', 'delete_loader', self.delete_loader,
                              methods=['DELETE'])

        self.cameras = {}  # {camera_name: CameraStream}
        self.loaders = {}  # {loader_name: NeuralLoader}
        self.camera_manager = None  # Инициализировать при необходимости

    def gen_callback(self, cam_id):
        def generate():
            self.logger.info(f"Start streaming camera {self.logger.c(cam_id, 'cyan')}")
            while True:
                try:
                    frame = self.frame_queues[cam_id].get(timeout=1)
                    self.logger.action_send(
                        f"Sending frame for camera {self.logger.c(cam_id, 'green')}")
                except Empty:
                    self.logger.action_recv(
                        f"No frames in queue for camera {self.logger.c(cam_id, 'yellow')}")
                    continue

                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')

        def flask_handler():
            return Response(generate(), mimetype='multipart/x-mixed-replace; boundary=frame')

        return flask_handler

    def push_frame(self, cam_id: str, image: np.ndarray):
        """image — OpenCV BGR numpy array"""
        self.logger.debug(f"Push frame for {self.logger.c(cam_id, 'cyan')}")
        ret, jpeg = cv2.imencode('.jpg', image)
        if not ret:
            self.logger.action_error(f"Failed to encode frame for {cam_id}")
            raise RuntimeError("Failed to encode frame")

        jpeg_bytes = jpeg.tobytes()
        q = self.frame_queues[cam_id]

        if q.full():
            try:
                q.get_nowait()
                self.logger.debug(f"Queue full for {cam_id}, discarded oldest")
            except Empty:
                pass

        q.put(jpeg_bytes)
        self.logger.debug(f"Frame pushed for {cam_id}, queue size: {q.qsize()}")

    def health(self):
        """Health check endpoint"""
        return jsonify({"status": "ok", "service": "flask-server"})

    def get_cameras(self):
        """Получить список всех камер"""
        cameras_list = []
        for name, cam in self.cameras.items():
            cameras_list.append({
                "camera_name": name,
                "rtsp_url": cam.rtsp_url,
                "width": cam.width,
                "height": cam.height,
                "reconnect_interval": cam.reconnect_interval,
                "status": cam.status.name.lower() if hasattr(cam.status, 'name') else "unknown"
            })
        return jsonify(cameras_list)

    def add_camera(self):
        """Добавить новую камеру"""
        data = request.json
        camera_name = data.get("camera_name")

        if camera_name in self.cameras:
            return jsonify({"error": "Camera already exists"}), 400

        from camera import CameraStream

        cam = CameraStream(
            rtsp_url=data.get("rtsp_url"),
            camera_name=camera_name,
            width=data.get("width"),
            height=data.get("height"),
            reconnect_interval=data.get("reconnect_interval", 5),
            on_frame=None,  # TODO: Callback настроить позже
            log=True
        )

        self.cameras[camera_name] = cam
        cam.start()

        return jsonify({
            "status": "success",
            "message": f"Camera {camera_name} added and started"
        })

    def camera_status(self, camera_name):
        """Получить статус камеры"""
        if camera_name not in self.cameras:
            return jsonify({"error": "Camera not found"}), 404

        cam = self.cameras[camera_name]
        return jsonify({
            "camera_name": camera_name,
            "status": cam.status.name.lower() if hasattr(cam.status, 'name') else "unknown",
            "is_alive": cam.is_alive(),
            "rtsp_url": cam.rtsp_url,
            "width": cam.width,
            "height": cam.height
        })

    def update_camera(self, camera_name):
        """Обновить параметры камеры"""
        if camera_name not in self.cameras:
            return jsonify({"error": "Camera not found"}), 404

        data = request.json
        cam = self.cameras[camera_name]

        cam.stop()
        cam.join()

        if "rtsp_url" in data:
            cam.rtsp_url = data["rtsp_url"]
        if "width" in data:
            cam.width = data["width"]
        if "height" in data:
            cam.height = data["height"]
        if "reconnect_interval" in data:
            cam.reconnect_interval = data["reconnect_interval"]

        cam.start()

        return jsonify({"status": "success", "message": f"Camera {camera_name} updated"})

    def delete_camera(self, camera_name):
        """Удалить камеру"""
        if camera_name not in self.cameras:
            return jsonify({"error": "Camera not found"}), 404

        cam = self.cameras[camera_name]
        cam.stop()
        cam.join()

        del self.cameras[camera_name]

        return jsonify({"status": "success", "message": f"Camera {camera_name} deleted"})

    def get_loaders(self):
        """Получить список всех загрузчиков"""
        loaders_list = []
        for name, loader in self.loaders.items():
            loaders_list.append({
                "loader_name": name,
                "weights_path": loader.weights_path,
                "img_size": loader.img_size,
                "server_endpoint": loader.server_endpoint,
                "loader_matrix": loader.camera_matrix,
                "status": "running" if loader.running else "stopped"
            })
        return jsonify(loaders_list)

    def create_loader(self):
        """Создать новый загрузчик"""
        data = request.json
        loader_name = data.get("loader_name")

        if loader_name in self.loaders:
            return jsonify({"error": "Loader already exists"}), 400

        from neural_loader import NeuralLoader

        loader = NeuralLoader(
            name=loader_name,
            weights_path=data.get("weights_path"),
            camera_matrix=data.get("loader_matrix"),
            img_size=data.get("img_size"),
            server=self,
            server_endpoint=data.get("server_endpoint")
        )

        self.loaders[loader_name] = loader

        return jsonify({
            "status": "success",
            "message": f"Loader {loader_name} created (not started)"
        })

    def loader_status(self, loader_name):
        """Получить статус загрузчика"""
        if loader_name not in self.loaders:
            return jsonify({"error": "Loader not found"}), 404

        loader = self.loaders[loader_name]
        return jsonify({
            "loader_name": loader_name,
            "status": "running" if loader.running else "stopped",
            "is_alive": loader.is_alive(),
            "img_size": loader.img_size,
            "server_endpoint": loader.server_endpoint
        })

    def start_loader(self, loader_name):
        """Запустить загрузчик"""
        if loader_name not in self.loaders:
            return jsonify({"error": "Loader not found"}), 404

        loader = self.loaders[loader_name]
        if not loader.is_alive():
            loader.start()

        return jsonify({"status": "success", "message": f"Loader {loader_name} started"})

    def stop_loader(self, loader_name):
        """Остановить загрузчик"""
        if loader_name not in self.loaders:
            return jsonify({"error": "Loader not found"}), 404

        loader = self.loaders[loader_name]
        loader.stop()
        loader.join()

        return jsonify({"status": "success", "message": f"Loader {loader_name} stopped"})

    def update_loader(self, loader_name):
        """Обновить загрузчик (пересоздание)"""
        if loader_name not in self.loaders:
            return jsonify({"error": "Loader not found"}), 404

        old_loader = self.loaders[loader_name]
        old_loader.stop()
        old_loader.join()

        data = request.json

        from neural_loader import NeuralLoader
        new_loader = NeuralLoader(
            name=loader_name,
            weights_path=data.get("weights_path", old_loader.weights_path),
            camera_matrix=data.get("loader_matrix", old_loader.camera_matrix),
            img_size=data.get("img_size", old_loader.img_size),
            server=self,
            server_endpoint=data.get("server_endpoint", old_loader.server_endpoint)
        )

        self.loaders[loader_name] = new_loader

        return jsonify({"status": "success", "message": f"Loader {loader_name} updated"})

    def delete_loader(self, loader_name):
        """Удалить загрузчик"""
        if loader_name not in self.loaders:
            return jsonify({"error": "Loader not found"}), 404

        loader = self.loaders[loader_name]
        loader.stop()
        loader.join()

        del self.loaders[loader_name]

        return jsonify({"status": "success", "message": f"Loader {loader_name} deleted"})

    def run(self, host='0.0.0.0', port=5000):
        self.app.run(host=host, port=port, threaded=True)