import threading
import time
from logging import DEBUG
from typing import Dict, Optional, Any

import numpy as np
from queue import Queue

from camera import CameraStream, NV12Frame, CameraStatus
import main_config
from logger import get_logger, NullLogger
from neural_loader import NeuralLoader


class CameraManager:
    def __init__(self, neural_loaders: list[dict[str, Any]], max_queue_size: int = 1, delta_ms: int = 200):
        """

        :rtype: None
        """
        # Проверяем на количество нейронных загрузчиков
        if len(neural_loaders) > main_config.MAX_LOADERS_COUNT:
            raise RuntimeError("[CameraManager] Too many neural loaders!")

        required_keys = {
            main_config.LOADER_NAME,
            main_config.LOADER_MATRIX,
            main_config.LOADER_IMG_SIZE,
            main_config.LOADER_WEIGHTS_PATH,
            main_config.SERVER,
            main_config.SERVER_ENDPOINT
        }

        for idx, loader in enumerate(neural_loaders):
            if not isinstance(loader, dict):
                raise TypeError(
                    f"[CameraManager] Loader #{idx} must be dict, got {type(loader)}"
                )

            missing = required_keys - loader.keys()
            if missing:
                raise KeyError(
                    f"[CameraManager] Loader #{idx} missing fields: {sorted(missing)}"
                )

        self.cameras : list[CameraStream] = []

        # Буферы для получения кадров
        self.camera_images: dict[str, Queue[NV12Frame]] = {}
        self.max_queue_size = max_queue_size
        self.max_delta_ms = delta_ms

        # Поток пуша кадров в нейронные модули
        self.neural_push_thread : Optional[threading.Thread] = None

        self.running = False

        # Создаем загрузчики
        self.neural_loaders: list[NeuralLoader] = list()

        for lin in neural_loaders:
            loader = NeuralLoader(
                name=lin[main_config.LOADER_NAME],
                camera_matrix=lin[main_config.LOADER_MATRIX],
                img_size=lin[main_config.LOADER_IMG_SIZE],
                weights_path=lin[main_config.LOADER_WEIGHTS_PATH],
                classes_path=lin[main_config.LOADER_CLASSES_PATH],
                server=lin[main_config.SERVER],
                server_endpoint=lin[main_config.SERVER_ENDPOINT]
            )
            self.neural_loaders.append(loader)

        log = True
        if log:
            self.logger = get_logger(__name__, DEBUG)
        else:
            self.logger = NullLogger()

    def add_camera(self, camera: CameraStream):
        """Добавить камеру в менеджер"""
        self.cameras.append(camera)
        self.camera_images[camera.name] = Queue(maxsize=self.max_queue_size)
        self.logger.info(f"[CameraManager] Adding camera {camera.name}")

    def start_all(self):
        """Запустить все камеры параллельно"""
        self.running = True
        self.logger.info(f"[CameraManager] Starting all cameras")

        for cam in self.cameras:
            cam.start()

        for index, loader in enumerate(self.neural_loaders):
            if index >= main_config.MAX_NEURAL:
                break

            if loader.init_model_runtime(2^index):
                loader.start()

        if self.neural_push_thread is not None:
            raise RuntimeError("[CameraManager] The neural loader is running during its first initialization!")

        self.neural_push_thread = threading.Thread(
            target=self.push_latest_frames_to_neural,
            daemon=True
        )
        self.neural_push_thread.start()

    def stop_all(self):
        """Остановить все камеры"""
        self.running = False

        for cam in self.cameras:
            cam.stop()

        # Дождаться их завершения
        for cam in self.cameras:
            cam.join(timeout=1)

        for loader in self.neural_loaders:
            loader.stop()

        for loader in self.neural_loaders:
            loader.join(timeout=1)

        self.neural_push_thread.join(timeout=1)
        self.logger.info(f"[CameraManager] Stopping all cameras")

    def list_status(self):
        """Посмотреть состояние потоков"""
        statuses = {}
        for cam in self.cameras:
            statuses[cam.camera_name] = cam.is_alive()
        return statuses

    def on_frame(self, frame: NV12Frame, camera_name: str):
        if camera_name not in self.camera_images:
            self.camera_images[camera_name] = Queue(maxsize=self.max_queue_size)

        if self.camera_images[camera_name].full():
            self.camera_images[camera_name].get_nowait()

        self.camera_images[camera_name].put_nowait(frame)

    def push_latest_frames_to_neural(self):
        while self.running:
            frames = self.get_latest_frames()
            if frames is None:
                time.sleep(0.005)
                continue

            for loader in self.neural_loaders:
                camera_matrix = loader.get_camera_matrix()
                frame_matrix: list[list[NV12Frame | None]] = []

                for row in camera_matrix:
                    frame_row: list[NV12Frame | None] = []
                    for camera_name in row:
                        frame_row.append(frames.get(camera_name))  # Возьмём кадр или None, если нет
                    frame_matrix.append(frame_row)

                loader.move_batch(frame_matrix)

    def get_latest_frames(self):
        frames: dict[str, NV12Frame] = {}
        while self.running:
            all_frames_received = True
            cameras_active = [camera for camera in self.cameras if camera.status is CameraStatus.RUNNING]

            if not cameras_active:
                return None

            for camera in cameras_active:
                q = self.camera_images.get(camera.camera_name)
                if q is None:
                    all_frames_received = False
                    break
                if q.empty():
                    all_frames_received = False
                    break
                else:
                    frames[camera.camera_name] = q.queue[-1] # Берем последний кадр
                    q.queue.clear()

            if all_frames_received:
                for name, queue in self.camera_images.items():
                    if name in frames:
                        self.camera_images[name].queue.clear()
                break
            else:
                time.sleep(0.005)

        return frames