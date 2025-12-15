import threading
import time
from typing import Dict, Optional, Any

import numpy as np
from queue import Queue

from camera import CameraStream, NV12Frame
import main_config
from neural_loader import NeuralLoader


class CameraManager:
    def __init__(self, neural_loaders: list[dict[str, Any]], max_queue_size: int = 25, delta_ms: int = 200):
        # Проверяем на количество нейронных загрузчиков
        if len(neural_loaders) > main_config.MAX_LOADERS_COUNT:
            raise RuntimeError("[CameraManager] Too many neural loaders!")

        required_keys = {
            main_config.LOADER_NAME,
            main_config.LOADER_MATRIX,
            main_config.LOADER_IMG_SIZE,
            main_config.LOADER_WEIGHTS_PATH,
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

        self.cameras = []

        # Буферы для получения кадров
        self.camera_images = {}
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
            )
            self.neural_loaders.append(loader)

    def add_camera(self, camera: CameraStream):
        """Добавить камеру в менеджер"""
        self.cameras.append(camera)
        self.camera_images[camera.name] = Queue(maxsize=self.max_queue_size)

    def start_all(self):
        """Запустить все камеры параллельно"""
        self. running = True

        for cam in self.cameras:
            cam.start()

        for loader in self.neural_loaders:
            loader.start()

        if self.neural_push_thread is not None:
            raise RuntimeError("[CameraManager] The neural loader is running during its first initialization!")

        self.neural_push_thread = threading.Thread(target=self.push_frames_to_neural())
        self.neural_push_thread.start()

    def stop_all(self):
        """Остановить все камеры"""
        self.running = False

        for cam in self.cameras:
            cam.stop()

        # Дождаться их завершения
        for cam in self.cameras:
            cam.join()

        for loader in self.neural_loaders:
            loader.stop()

        self.neural_push_thread.join()

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
            self.camera_images[camera_name].get()

        self.camera_images[camera_name].put(frame)

    def push_frames_to_neural(self):
        while self.running:
            # Синхронизируем кадры
            synchronized_frames = self.synchronize_frames()
            if synchronized_frames is None:
                time.sleep(0.01)
                continue

            # Отправляем матрицу кадров
            for loader in self.neural_loaders:
                camera_matrix = loader.get_camera_matrix()
                frame_matrix: list[list[NV12Frame | None]] = []

                for row in camera_matrix:
                    frame_row: list[NV12Frame | None] = []

                    for camera_name in row:
                        frame_row.append(synchronized_frames.get(camera_name))

                    frame_matrix.append(frame_row)

                loader.move_batch(frame_matrix)


    def synchronize_frames(self) -> Dict[str, Optional[NV12Frame]] | None:
        """
        Синхронизация всех кадров в очередях, возвращает словарь синхронизированных кадров
        None - если нет никаких кадров вообще
        """
        # Берем первые кадры очередей
        current_frames: Dict[str, Optional[NV12Frame]] = {}
        for camera, q in self.camera_images.items():
            if q.empty():
                current_frames[camera] = None
            else:
                current_frames[camera] = q.queue[0]

        # Кадров нет
        if all(frame is None for frame in current_frames.values()):
            return None

        # Синхронизация
        for _ in range(10):
            valid_frames = [f for f in current_frames.values() if f is not None]
            if not valid_frames:
                # Нет кадров для синхронизации
                break

            max_ts = max(f.timestamp_ms for f in valid_frames)
            min_ts = min(f.timestamp_ms for f in valid_frames)

            # Проверяем синхронизирован ли набор кадров
            if max_ts - min_ts <= self.max_delta_ms:
                break

            # Сдвигаем очереди с кадрами, которые не удовлетворяют сравнению
            for camera, frame in current_frames.items():
                if frame is None:
                    continue
                if frame.timestamp_ms < max_ts - self.max_delta_ms:
                    q = self.camera_images[camera]
                    if q.qsize() > 1:
                        q.get()
                        if q.empty():
                            current_frames[camera] = None
                        else:
                            current_frames[camera] = q.queue[0]
                    else:
                        # Нет новых кадров, заменяем на None
                        current_frames[camera] = None
        else:
            # Если не удалось синхронизировать за 10 попыток — просто вернём текущее состояние
            pass

        # Забираем синхронизированные кадры из очереди
        for camera, frame in current_frames.items():
            if frame is not None:
                self.camera_images[camera].get()

        return current_frames

    def print_camera_queues(self):
        # Заголовок таблицы
        header = f"{'Camera':<15} | {'Frames in Queue':<15} | {'Frame idx':<9} | {'Width':<6} | {'Height':<6} | {'Y size (bytes)':<14} | {'UV size (bytes)':<15} | {'Timestamp (ms)':<14}"
        sep = '-' * len(header)
        print(header)
        print(sep)

        for camera_name, q in self.camera_images.items():
            frames = list(q.queue)  # Получаем список из очереди (без удаления элементов)
            frames_count = len(frames)

            if frames_count == 0:
                print(
                    f"{camera_name:<15} | {frames_count:<15} | {'-':<9} | {'-':<6} | {'-':<6} | {'-':<14} | {'-':<15} | {'-':<14}")
                continue

            for idx, frame in enumerate(frames):
                y_size = frame.y.nbytes if isinstance(frame.y, np.ndarray) else 'N/A'
                uv_size = frame.uv.nbytes if isinstance(frame.uv, np.ndarray) else 'N/A'

                print(
                    f"{camera_name:<15} | {frames_count:<15} | {idx:<9} | {frame.width:<6} | {frame.height:<6} | {y_size:<14} | {uv_size:<15} | {frame.timestamp_ms:<14}")