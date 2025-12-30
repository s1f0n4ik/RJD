import json
import threading
import time
from logging import DEBUG
from pathlib import Path
from time import sleep
from typing import Optional

from queue import Queue


from camera import CameraStream, NV12Frame, CameraStatus
import main_config
from logger import get_logger, NullLogger
from neural_loader import NeuralLoader


class CameraManager:
    def __init__(self, save_file: str, max_queue_size: int = 1, delta_ms: int = 200):

        self.save_file = save_file

        self.cameras : dict[str, CameraStream] = {}
        # Создаем загрузчики
        self.neural_loaders: dict[str, NeuralLoader] = {}

        # Буферы для получения кадров
        self.camera_images: dict[str, Queue[NV12Frame]] = {}
        self.max_queue_size = max_queue_size
        self.max_delta_ms = delta_ms

        # Поток пуша кадров в нейронные модули
        self.neural_push_thread : Optional[threading.Thread] = None

        self.server = None

        self.running = False

        log = True
        if log:
            self.logger = get_logger(__name__, DEBUG)
        else:
            self.logger = NullLogger()

    def set_server(self, server):
        self.server = server

    def start_all(self):
        """Запустить все камеры параллельно"""
        self.running = True
        self.logger.info(f"[CameraManager] Starting all cameras")

        for name, cam in self.cameras.items():
            cam.start()

        for index, n_loader in enumerate(self.neural_loaders.values()):
            if index >= main_config.MAX_NEURAL:
                break

            if n_loader.init_model_runtime(1 >> index):
                n_loader.start()

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

        for name, cam in self.cameras.items():
            cam.stop()
            cam.join(timeout=1)

        for name, n_loader in self.neural_loaders.items():
            n_loader.stop()
            n_loader.join(timeout=1)

        self.neural_push_thread.join(timeout=1)
        self.logger.info(f"[CameraManager] Stopping all cameras")

    def list_status(self):
        """Посмотреть состояние потоков"""
        statuses = {}
        for name, cam in self.cameras.items():
            statuses[cam.camera_name] = cam.status
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

            for name, n_loader in self.neural_loaders.items():
                camera_matrix = n_loader.camera_matrix
                frame_matrix: list[list[NV12Frame | None]] = []

                for row in camera_matrix:
                    frame_row: list[NV12Frame | None] = []
                    for camera_name in row:
                        frame_row.append(frames.get(camera_name))  # Возьмём кадр или None, если нет
                    frame_matrix.append(frame_row)

                n_loader.move_batch(frame_matrix)

    def get_latest_frames(self):
        frames: dict[str, NV12Frame] = {}
        while self.running:
            all_frames_received = True
            cameras_active = [camera for camera in self.cameras.values() if camera.status is CameraStatus.RUNNING]

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


    def load_from_file(self) -> dict:
        path = Path(self.save_file)

        if not path.exists():
            return {"status": "error", "message": f"Config file not found: {path}"}

        with path.open("r", encoding="utf-8") as f:
            cfg = json.load(f)

        created = {
            "cameras": [],
            "loaders": []
        }

        for cam_data in cfg.get("cameras", []):
            try:
                res = self.handle_command("camera.add", cam_data)
                if res.get("status") == "success":
                    created["cameras"].append(cam_data["camera_name"])
            except Exception as e:
                self.logger.error(str(e))

        for loader_data in cfg.get("loaders", []):
            try:
                res = self._loader_create(loader_data)
                if res.get("status") == "success":
                    created["loaders"].append(loader_data["loader_name"])
            except Exception as e:
                self.logger.error(str(e))

        self.logger.info(
            f"Loaded from {path}: "
            f"{len(created['cameras'])} cameras, "
            f"{len(created['loaders'])} loaders"
        )

        self.running = True

        self.neural_push_thread = threading.Thread(target=self.push_latest_frames_to_neural, daemon=True)
        self.neural_push_thread.start()

        return {
            "status": "ok",
            "created": created
        }

    def save_to_file(self) -> dict:
        path = Path(self.save_file)

        data = {
            "cameras": [],
            "loaders": []
        }

        # ---------- CAMERAS ----------
        for name, cam in self.cameras.items():
            data["cameras"].append({
                "camera_name": name,
                "rtsp_url": cam.rtsp_url,
                "width": cam.imgsz[0],
                "height": cam.imgsz[1],
                "reconnect_interval": cam.reconnect_interval
            })

        # ---------- LOADERS ----------
        for name, n_loader in self.neural_loaders.items():
            data["loaders"].append({
                "loader_name": name,
                "camera_matrix": n_loader.camera_matrix,
                "img_size": n_loader.imgsz,
                "weights_path": n_loader.weights_path,
                "classes_path": n_loader.classes_path,
                "server_endpoint": n_loader.server_endpoint,
                "confidence_threshold": n_loader.confidence,
                "iou_threshold": n_loader.iou,
                "log_level": n_loader.logging
            })

        with path.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        self.logger.info(f"Configuration saved to {path}")

        return {
            "status": "ok",
            "path": str(path)
        }

    def handle_command(self, command: str, data: dict) -> dict | list[dict]:
        try:
            if command == "camera.add":
                return self._camera_add(data)

            if command == "camera.delete":
                return self._camera_delete(data)

            if command == "camera.update":
                return self._camera_update(data)

            if command == "camera.status":
                return self._camera_status(data)

            if command == "camera.list":
                return self._camera_list()

            if command == "camera.start":
                return self._camera_start(data)

            if command == "camera.stop":
                return self._camera_stop(data)

            if command == "loader.create":
                return self._loader_create(data)

            if command == "loader.delete":
                return self._loader_delete(data)

            if command == "loader.start":
                return self._loader_start(data)

            if command == "loader.stop":
                return self._loader_stop(data)

            if command == "loader.status":
                return self._loader_status(data)

            if command == "loader.list":
                return self._loader_list()

            raise ValueError(f"Unknown command: {command}")

        except Exception as e:
            self.logger.error(str(e))
            return {"status": "error", "message": str(e)}

    def _camera_add(self, data: dict) -> dict:
        name = data.get("camera_name")

        if name in self.cameras:
            self.logger.error(f"Camera {name} already exists")
            return {"status": "error", "message": f"Camera {name} already exists"}

        cam = CameraStream(
            rtsp_url=data.get("rtsp_url", ""),
            camera_name=name,
            width=data.get("width", None),
            height=data.get("height", None),
            reconnect_interval=data.get("reconnect_interval", 5),
            on_frame=self.on_frame,
            log_level=data.get("log_level", 10)
        )

        self.cameras[str(name)] = cam
        self.camera_images[cam.camera_name] = Queue(maxsize=self.max_queue_size)
        cam.start()
        self.logger.info(f"Camera {name} added and started")

        #self.save_to_file()

        return {"status": "success", "message": f"Camera {name} added and started"}

    def _camera_delete(self, data: dict) -> dict:
        name = data["camera_name"]

        try :
            cam = self.cameras.pop(name)
            cam.stop()
            cam.join(timeout=1)
        except IndexError as index_error:
            self.logger.error(f"Camera {name} not found")
            return {"status": "error", "message": f"Camera {name} not found"}
        except Exception as runtime_error:
            self.logger.error(runtime_error)
            return {"status": "error", "message": f"Unknown error: {runtime_error}"}

        self.camera_images.pop(name, None)
        self.logger.info(f"Camera {name} deleted!")

        self.save_to_file()

        return {"status": "success", "message": f"Camera {name} deleted"}

    def _camera_start(self, data: dict) -> dict:
        name = data.get("camera_name")

        if name not in self.cameras:
            self.logger.error(f"Camera {name} not found")
            return {"status": "error", "message": f"Camera {name} not found"}

        camera = self.cameras[name]
        if not camera.is_alive():
            camera.start()
            self.logger.info(f"Camera {name} started")
        else:
            self.logger.info(f"Camera {name} has already started!")

        return {"status": "success", "message": f"Camera {name} started"}

    def _camera_stop(self, data: dict) -> dict:
        name = data.get("camera_name")

        if name not in self.cameras:
            self.logger.error(f"Camera {name} not found")
            return {"status": "error", "message": f"Camera {name} not found"}

        camera = self.cameras[name]
        if not camera.is_alive():
            camera.stop()
            camera.join(timeout=1)
            self.logger.info(f"Camera {name} stopped!")
        else:
            self.logger.info(f"Camera {name} has already stopped!")

        return {"status": "success", "camera_name": f"Camera {name} stopped"}

    def _camera_update(self, data: dict) -> dict:
        name = data["camera_name"]

        if name not in self.cameras:
            self.logger.error(f"Camera {name} not found")
            return {"status": "error", "message": f"Camera {name} not found"}

        cam = self.cameras[name]

        if cam.status != CameraStatus.RUNNING:
            cam.stop()
            cam.join(timeout=1)
            self.logger.debug(f"Camera {name} stopped to update camera data!")

        if "rtsp_url" in data:
            cam.rtsp_url = data.get("rtsp_url")
        if "width" in data and "height" in data:
            cam.imgsz = (data.get("width"), data.get("height"))
        if "reconnect_interval" in data:
            cam.reconnect_interval = data.get("reconnect_interval")
        if "log_level" in data:
            cam.logging = data.get("log_level")

        cam.start()
        self.logger.info(f"Camera {name} updated to {cam.status}")

        self.save_to_file()

        return {"status": "success", "message": f"Camera {name} updated and restarted!"}

    def _camera_status(self, data: dict) -> dict:
        name = data.get("camera_name")

        if name not in self.cameras:
            self.logger.error(f"Camera {name} not found")
            return {"status": "error", "message": f"Camera {name} not found"}

        cam = self.cameras[name]

        return {
            "camera_name": name,
            "status": cam.status.name.lower() if hasattr(cam.status, 'name') else "unknown",
            "is_alive": cam.is_alive(),
            "rtsp_url": cam.rtsp_url,
            "width": cam.imgsz[0],
            "height": cam.imgsz[1],
            "reconnect_interval": cam.reconnect_interval,
            "log_level": cam.logging
        }

    def _camera_list(self) -> list[dict]:
        return [
            {
                "camera_name": name,
                "rtsp_url": cam.rtsp_url,
                "width": cam.imgsz[0],
                "height": cam.imgsz[1],
                "reconnect_interval": cam.reconnect_interval,
                "status": cam.status.name.lower(),
                "log_level": cam.logging
            }
            for name, cam in self.cameras.items()
        ]

    def _loader_create(self, data: dict) -> dict:
        name = data["loader_name"]

        if name in self.neural_loaders:
            self.logger.error(f"Loader {name} already exists")
            return {"status": "error", "message": f"Loader {name} already exists"}

        if len(self.neural_loaders) > main_config.MAX_LOADERS_COUNT:
            self.logger.error(f"[CameraManager] Too many neural loaders!")
            return {"status": "error", "message": f"Too many neural loaders!"}

        n_loader = NeuralLoader(
            name=name,
            camera_matrix=data.get("camera_matrix"),
            img_size=data.get("img_size"),
            weights_path=data.get("weights_path"),
            classes_path=data.get("classes_path"),
            server=self.server,
            server_endpoint=data.get("server_endpoint"),
            confidence_threshold=data.get("confidence_threshold", 0.5),
            iou_threshold=data.get("iou_threshold", 0.5),
            log_level=data.get("log_level", 10),
        )

        self.logger.info(f"Loader {name} created!")
        self.neural_loaders[name] = n_loader

        index = len(self.neural_loaders) - 1
        if n_loader.init_model_runtime(1 << index):
            n_loader.start()
            self.logger.info(f"Loader {name} started!")
        else:
            self.logger.info(f"Loader {name} cannot be started with mask {1 << index}!")

        #self.save_to_file()

        return {"status": "success", "message": f"Loader {name} created and started!"}

    def _loader_start(self, data: dict) -> dict:
        name = data["loader_name"]

        if name not in self.neural_loaders:
            self.logger.error(f"Loader {name} not found")
            return {"status": "error", "message": f"Loader {name} not found"}

        n_loader = self.neural_loaders[name]

        if not n_loader.is_alive():
            n_loader.start()

        self.logger.info(f"Loader {name} started!")

        return {"status": "success", "message": f"Loader {name} started!"}


    def _loader_stop(self, data: dict) -> dict:
        name = data["loader_name"]

        if name not in self.neural_loaders:
            self.logger.error(f"Loader {name} not found")
            return {"status": "error", "message": f"Loader {name} not found"}

        n_loader = self.neural_loaders[name]

        if n_loader.is_alive():
            n_loader.stop()

        self.logger.info(f"Loader {name} stopped!")

        return {"status": "success", "message": f"Loader {name} stopped!"}


    def _loader_update(self, data: dict) -> dict:
        name = data["loader_name"]

        if name not in self.neural_loaders:
            self.logger.error(f"Loader {name} not found")
            return {"status": "error", "message": f"Loader {name} not found"}

        n_loader = self.neural_loaders[name]
        n_loader.stop()
        n_loader.join(timeout=1)
        self.logger.info(f"Loader {name} stopped to update loader data!")

        if "weights_path" in data:
            n_loader.weights_path = data.get("weights_path")
        if "classes_path" in data:
            n_loader.classes_path = data.get("classes_path")
        if "server_endpoint" in data:
            n_loader.server_endpoint = data.get("server_endpoint")
        if "loader_matrix" in data:
            n_loader.camera_matrix = data.get("loader_matrix")
        if "img_size" in data:
            n_loader.imgsz = data.get("img_size")
        if "confidence_threshold" in data:
            n_loader.confidence_threshold = data.get("confidence_threshold")
        if "iou_threshold" in data:
            n_loader.iou_threshold = data.get("iou_threshold")
        if "log_level" in data:
            n_loader.logging = data.get("log_level")

        self.logger.info(f"Loader {name} updated!")

        n_loader.start()
        self.logger.info(f"Loader {name} started!")

        self.save_to_file()

        return {"status": "success", "message": f"Loader {name} updated and restarted!"}

    def _loader_status(self, data: dict) -> dict:
        name = data["loader_name"]

        if name not in self.neural_loaders:
            self.logger.error(f"Loader {name} not found")
            return {"status": "error", "message": f"Loader {name} not found"}

        n_loader = self.neural_loaders[name]

        return {
            "loader_name": n_loader.loader_name,
            "status": "running" if n_loader.is_alive() else "stopped",
            "is_alive": n_loader.is_alive(),
            "img_size": n_loader.imgsz,
            "loader_matrix": n_loader.camera_matrix,
            "weights_path": n_loader.weights_path,
            "classes_path": n_loader.classes_path,
            "confidence_threshold": n_loader.confidence,
            "iou_threshold": n_loader.iou,
            "server_endpoint": n_loader.server_endpoint,
        }

    def _loader_list(self) -> list[dict]:
         return  [
             {
                "loader_name": n_loader.loader_name,
                "status": "running" if n_loader.is_alive() else "stopped",
                "is_alive": n_loader.is_alive(),
                "img_size": n_loader.imgsz,
                "camera_matrix": n_loader.camera_matrix,
                "weights_path": n_loader.weights_path,
                "classes_path": n_loader.classes_path,
                "confidence_threshold": n_loader.confidence,
                "iou_threshold": n_loader.iou,
                "server_endpoint": n_loader.server_endpoint,
             }
             for name, n_loader in self.neural_loaders.items()
        ]

    def _loader_delete(self, data):
        name = data.get("loader_name")

        if name not in self.neural_loaders:
            self.logger.error(f"Loader {name} not found")
            return {"status": "error", "message": f"Loader {name} not found"}

        n_loader = self.neural_loaders.pop(name)
        n_loader.stop()
        n_loader.join(timeout=1)

        self.logger.info(f"Loader {name} stopped and deleted!")

        self.save_to_file()

        return {"status": "success", "message": f"Loader {name} deleted!"}




