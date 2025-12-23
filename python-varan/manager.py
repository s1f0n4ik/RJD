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
        self.camera_images[camera.camera_name] = Queue(maxsize=self.max_queue_size)
        self.logger.info(f"[CameraManager] Adding camera {camera.camera_name}")

    def start_all(self):
        """Запустить все камеры параллельно"""
        self.running = True
        self.logger.info(f"[CameraManager] Starting all cameras")

        for cam in self.cameras:
            cam.start()

        for loader in self.neural_loaders:
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
            cam.join()

        for loader in self.neural_loaders:
            loader.stop()

        for loader in self.neural_loaders:
            loader.join()

        self.neural_push_thread.join()
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

    def push_synchronized_frames_to_neural(self):
        while self.running:
            # Синхронизируем кадры
            synchronized_frames = self.synchronize_frames()
            if synchronized_frames is None:
                time.sleep(0.01)
                self.logger.debug("[CameraManager] No frames synchronized got!")
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

    def push_synchronized_frames_to_neural(self):
        while self.running:
            # Синхронизируем кадры
            synchronized_frames = self.synchronize_frames()
            if synchronized_frames is None:
                time.sleep(0.01)
                self.logger.debug("[CameraManager] No frames synchronized got!")
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

        # Словарь для записи кадров
        current_frames: Dict[str, Optional[NV12Frame]] = {}

        while self.running:
            frames_all = True
            running_cameras = [camera for camera in self.cameras if camera.status is CameraStatus.RUNNING]
            if not running_cameras:
                self.logger.debug("[CameraManager] No running cameras to synchronize!")
                return None

            for camera in running_cameras:
                temp_q = self.camera_images.get(camera.camera_name)
                if temp_q is None:
                    self.logger.warning(f"[CameraManager] Camera '{camera.camera_name}' queue does not exist!")
                    frames_all = False
                    break
                if temp_q.empty():
                    #self.logger.debug(
                    #    f"[CameraManager] Queue for camera '{camera.camera_name}' is empty, waiting for frames...")
                    frames_all = False
                    break

            if frames_all:
                for camera in running_cameras:
                    current_frames[camera.camera_name] = None
                self.logger.debug(f"[CameraManager] All running cameras have frames ready for synchronization.")
                break

            #self.logger.debug("[CameraManager] Not enough frames to synchronize yet, sleeping shortly...")
            time.sleep(0.01)

        # Берем первые кадры очереди
        for camera_name in current_frames.keys():
            try:
                frame = self.camera_images[camera_name].queue[0]
                current_frames[camera_name] = frame
                self.logger.debug(
                    f"[CameraManager] Got frame from camera '{camera_name}' with timestamp {frame.timestamp_ms}.")
            except IndexError:
                current_frames[camera_name] = None
                self.logger.warning(f"[CameraManager] Queue for camera '{camera_name}' became empty unexpectedly.")

        # Проверяем, есть ли хоть один кадр
        if all(frame is None for frame in current_frames.values()):
            self.logger.debug("[CameraManager] No frames found in any camera queues after waiting.")
            return None

        # Синхронизация
        for attempt in range(1, 11):
            valid_frames = [f for f in current_frames.values() if f is not None]
            if not valid_frames:
                self.logger.debug(f"[CameraManager] No valid frames to synchronize on attempt {attempt}.")
                break

            max_ts = max(f.timestamp_ms for f in valid_frames)
            min_ts = min(f.timestamp_ms for f in valid_frames)

            self.logger.debug(f"[CameraManager] Attempt {attempt}: max timestamp = {max_ts}, min timestamp = {min_ts}")

            # Проверяем синхронизирован ли набор кадров
            if max_ts - min_ts <= self.max_delta_ms:
                self.logger.debug(
                    f"[CameraManager] Frames synchronized within delta {self.max_delta_ms}ms on attempt {attempt}.")
                break

            # Сдвигаем очереди с кадрами, которые не удовлетворяют сравнению
            for camera_name, frame in current_frames.items():
                if frame is None:
                    continue
                if frame.timestamp_ms < max_ts - self.max_delta_ms:
                    q = self.camera_images[camera_name]
                    if q.qsize() > 1:
                        removed_frame = q.get()
                        self.logger.debug(
                            f"[CameraManager] Popped outdated frame from camera '{camera_name}' with timestamp {removed_frame.timestamp_ms}.")
                        if q.empty():
                            current_frames[camera_name] = None
                            self.logger.debug(
                                f"[CameraManager] Queue for camera '{camera_name}' is now empty after popping.")
                        else:
                            current_frames[camera_name] = q.queue[0]
                            self.logger.debug(
                                f"[CameraManager] New head frame for camera '{camera_name}' has timestamp {current_frames[camera_name].timestamp_ms}.")
                    else:
                        current_frames[camera_name] = None
                        self.logger.debug(
                            f"[CameraManager] No new frames to pop from camera '{camera_name}', setting frame to None.")
        else:
            self.logger.warning(
                "[CameraManager] Failed to synchronize frames within 10 attempts; returning current frames.")

        # Забираем синхронизированные кадры из очереди
        for camera_name, frame in current_frames.items():
            if frame is not None:
                self.camera_images[camera_name].get()

        return current_frames

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