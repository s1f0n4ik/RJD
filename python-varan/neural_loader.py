import logging
import threading
import time
from queue import Queue, Empty
from typing import Optional, Any

import cv2
import numpy as np

from rknnlite.api import RKNNLite

from camera import NV12Frame
from logger import get_logger
from main_config import YOLO_GRAY_Y, YOLO_GRAY_UV
from server import MultiCameraServer
from utility import nv12_to_rgb, load_classes_from_json, pretty_json
from yolo import postprocess_default_yolo, draw_yolo_boxes


class NeuralLoader(threading.Thread):

    def __init__(
            self,
            name:str,
            weights_path: str,
            classes_path: str,
            camera_matrix: list[list[str]],
            img_size: int,
            log_level=None,
            server: Optional[MultiCameraServer]=None,
            server_endpoint: str = '',
            buffer_size: int = 1,
            confidence_threshold: float = 0.5,
            iou_threshold: float = 0.5,
    ):
        super().__init__(daemon=True)
        self._buffer_size = buffer_size
        self._queue_frames: Queue[list[list[NV12Frame | None]]] = Queue(maxsize=buffer_size)
        self._queue_batch : Queue[NV12Frame] = Queue(maxsize=self._buffer_size)

        self._thread_batch_maker: Optional[threading.Thread] = None

        self._camera_matrix = camera_matrix
        self._img_size = img_size
        self._name = name

        self._weights_path = weights_path
        self._classes_path = classes_path

        self._confidence_threshold = confidence_threshold
        self._iou_threshold = iou_threshold

        self._classes: Optional[list[dict[str, Any]]] = None
        self._rknn: Optional[RKNNLite] = None

        self._log_level = log_level or logging.DEBUG
        self._logger = get_logger(f"NeuralLoader[{name}]", self._log_level)

        self._logger.info(
            f"Initialized: img_size={img_size}, "
            f"cameras={len(camera_matrix)}x{len(camera_matrix[0]) if camera_matrix else 0}"
        )

        self._server = server
        self._server_endpoint = server_endpoint

        self._running = False

    @property
    def classes(self): return self._classes
    @classes.setter
    def classes(self, value):
        self._classes = value

    @property
    def server_endpoint(self): return self._server_endpoint
    @server_endpoint.setter
    def server_endpoint(self, value):
        self._server_endpoint = value

    @property
    def loader_name(self): return self._name
    @loader_name.setter
    def loader_name(self, value):
        self._name = value

    @property
    def imgsz(self): return self._img_size
    @imgsz.setter
    def imgsz(self, value): self._img_size = value

    @property
    def camera_matrix(self) -> list[list[str]]: return self._camera_matrix
    @camera_matrix.setter
    def camera_matrix(self, value):
        if not isinstance(value, list):
            raise ValueError("camera_matrix must be a list of lists")
        self._camera_matrix = value

    @property
    def confidence(self) -> float: return self._confidence_threshold
    @confidence.setter
    def confidence(self, value: float):
        if not 0.0 <= value <= 1.0:
            raise ValueError("confidence must be in range [0.0, 1.0]")
        self._confidence_threshold = float(value)

    @property
    def iou(self) -> float: return self._iou_threshold
    @iou.setter
    def iou(self, value: float):
        if not 0.0 <= value <= 1.0:
            raise ValueError("iou must be in range [0.0, 1.0]")
        self._iou_threshold = float(value)

    @property
    def weights_path(self): return self._weights_path
    @weights_path.setter
    def weights_path(self, value):
        self._weights_path = value

    @property
    def classes_path(self): return self._classes_path
    @classes_path.setter
    def classes_path(self, value):
        self._classes_path = value

    @property
    def logging(self): return self._log_level
    @logging.setter
    def logging(self, value):
        self._log_level = value

    @property
    def running(self): return self._running

    def init_model_runtime(self, core_mask) -> bool:
        """
        Инициалиазация контекста для rknn
        :param core_mask:
        0x01 - первое ядро
        0x02 - второе ядро
        0x04 - третье ядро
        0x07 - все ядра одновременно
        Важно, чтобы один поток использовал только 1 ядро, либо все сразу
        """
        self._rknn = RKNNLite()
        ret = self._rknn.load_rknn(self._weights_path)
        if ret != 0:
            self._logger.error(f"Failed to load model: {self._weights_path}")
            return False

        ret = self._rknn.init_runtime(core_mask=core_mask)
        if ret != 0:
            self._logger.error(f"Failed to init rknn runtime with core mask: {core_mask}")
            return False

        # Загрузка классов из файлов json
        try:
            self._classes, json = load_classes_from_json(self._classes_path)

            self._logger.info(f"Classes loaded from {pretty_json(self._classes)}")
        except Exception as e:
            self._logger.error(f"Failed to load classes from json: {e}")
            return False

        return True

    def run(self):
        """Запуск обработки батчей"""
        self._running = True

        self._thread_batch_maker: Optional[threading.Thread] = threading.Thread(
            target=self.process_batch,
            daemon=True,
        )
        self._thread_batch_maker.start()

        while self._running:
            try:
                frame = self._queue_batch.get(timeout=0.01)
                self._logger.debug(f"Got frame from queue: timestamp={frame.timestamp_ms}")
            except Empty:
                continue
            except Exception as e:
                self._logger.action_error(f"Exception in queue.get(): {e}")
                continue

            # Блок процессинга кадров
            try:
                preprocessed_frame = self.preprocess(frame)

                input_tensor = np.expand_dims(preprocessed_frame, axis=0) # (1, H, W, C)
                input_tensor = input_tensor.transpose(0, 3, 1, 2) # (1, C, H, W)

                outputs = self.inference(input_tensor)

                results, postprocess_frame = self.postprocess(outputs, preprocessed_frame)

            except Exception as e:
                self._logger.action_error(f"Process failed: {e}")
                continue

            if self._server:
                try:
                    self._server.push_frame(self._server_endpoint, postprocess_frame)
                    self._logger.info(f"Pushed frame to server endpoint {self._server_endpoint}")
                except Exception as e:
                    self._logger.action_error(f"Failed to push frame to server: {e}")

        self._logger.info("Processing thread stopped")

    def preprocess(self, frame: NV12Frame) -> np.ndarray:
        start_ts = time.perf_counter()
        rgb_frame = nv12_to_rgb(
            frame.y,
            frame.uv,
            frame.width,
            frame.height
        )

        elapsed_ms = (time.perf_counter() - start_ts) * 1000
        self._logger.info(
            f"Preprocess completed successfully in {elapsed_ms:.2f} ms. "
            f"Resulting RGB frame details: shape={rgb_frame.shape}, dtype={rgb_frame.dtype}"
        )
        return rgb_frame

    def inference(self, inputs:  np.ndarray) -> list[np.ndarray] | None:
        if self._rknn:
            self._logger.info(
                f"Starting inference: input shape={inputs.shape}, "
                f"dtype={inputs.dtype}"
            )

            start_ts = time.perf_counter()
            outputs = self._rknn.inference(inputs=[inputs])
            elapsed_ms = (time.perf_counter() - start_ts) * 1000

            if outputs is None:
                self._logger.warning("Inference finished, but outputs is None")
                return None
            else:
                # RKNN обычно возвращает list[np.ndarray]
                out_info = []
                for i, out in enumerate(outputs):
                    if hasattr(out, "shape"):
                        out_info.append(
                            f"[{i}] shape={out.shape}, dtype={out.dtype}"
                        )
                    else:
                        out_info.append(f"[{i}] type={type(out)}")

                self._logger.info(
                    f"Inference completed in {elapsed_ms:.2f} ms. "
                    f"Outputs: {', '.join(out_info)}"
                )
                return outputs
        else:
            self._logger.warning(
                "Inference skipped: RKNN runtime is not initialized"
            )
            return None

    def postprocess(self, outputs: list[np.ndarray], frame: np.ndarray):
        start_ts = time.perf_counter()

        results = postprocess_default_yolo(
            outputs[0],
            self._confidence_threshold,
            self._iou_threshold,
            (self._img_size, self._img_size),
        )

        elapsed_ms = (time.perf_counter() - start_ts) * 1000

        if results is None or len(results) == 0:
            self._logger.info(
                f"Postprocess completed in {elapsed_ms:.2f} ms. "
                f"No detection results"
            )
            return [], frame

        self._logger.info(
            f"Postprocess completed in {elapsed_ms:.2f} ms. "
            f"Total detections: {len(results)}\n"
            f"\tDetection results: {', '.join(results)}"
        )

        try:
            result_frame = draw_yolo_boxes(frame, results, self._classes)
        except Exception as e:
            self._logger.error(f"Failed to draw yolo boxes: {e}")
            return results, frame

        return results, result_frame

    def move_batch(self, frames: list[list[NV12Frame | None]]):
        if not frames or not frames[0]:
            self._logger.warning("move_batch called with empty frames")
            return

        if self._queue_frames.full():
            self._queue_frames.get_nowait()

        self._queue_frames.put_nowait(frames)

    def process_batch(self):
        while self._running:
            try:
                frames = self._queue_frames.get(timeout=0.1)
            except Empty:
                continue

            if not frames or not frames[0]:
                return

            rows : int = len(frames)
            cols : int = len(frames[0])

            cell_h = self._img_size // rows
            cell_w = self._img_size // cols

            self._logger.debug(
                f"Building batch: grid={rows}x{cols}, "
                f"cell={cell_w}x{cell_h}"
            )

            # Конечный NV12, который должен получиться
            y_final = np.full(
                (self._img_size, self._img_size),
                YOLO_GRAY_Y,
                dtype=np.uint8
            )

            uv_final = np.full(
                (self._img_size // 2, self._img_size // 2, 2),
                YOLO_GRAY_UV,
                dtype=np.uint8
            )

            filled = 0
            for row in range(rows):
                for col in range(cols):
                    frame = frames[row][col]
                    if frame is None:
                        self._logger.debug(f"Frame [{row},{col}] is None, skipping")
                        continue

                    # Получаем позиции ячеек изображения
                    y0 = row * cell_h
                    x0 = col * cell_w

                    y0_uv = y0 // 2
                    x0_uv = x0 // 2

                    # Получаем подогнанное под ячейку изображение
                    try:
                        y_cell, uv_cell = self.letterbox_nv12(
                            frame.y,
                            frame.uv,
                            frame.width,
                            frame.height,
                            cell_w,
                            cell_h
                        )

                        # Складываем в единое изображение
                        y_final[y0:y0 + cell_h, x0:x0 + cell_w] = y_cell
                        uv_final[
                            y0_uv:y0_uv + cell_h // 2,
                            x0_uv:x0_uv + cell_w // 2
                        ] = uv_cell

                        filled += 1

                    except Exception as e:
                        self._logger.action_error(
                            f"Letterbox failed at [{row},{col}]: {e}"
                        )

            if filled == 0:
                self._logger.warning("Batch created but no frames were filled")
                return

            # Получаем конечный кадр
            batch_frame = NV12Frame(
                y=y_final,
                uv=uv_final,
                width=self._img_size,
                height=self._img_size,
                timestamp_ms=max(
                    f.timestamp_ms for row in frames for f in row if f is not None
                )
            )

            if self._queue_batch.full():
                self._queue_batch.get_nowait()
                self._logger.warning("Queue full → dropping oldest batch")

            self._queue_batch.put_nowait(batch_frame)

            self._logger.info(
                f"Batch pushed: filled={filled}/{rows * cols}, "
                f"timestamp={batch_frame.timestamp_ms}, "
                f"Y shape={batch_frame.y.shape}, "
                f"UV shape={batch_frame.uv.shape}, "
                f"width={batch_frame.width}, "
                f"height={batch_frame.height}, "
            )

    def letterbox_nv12(
            self,
            y: np.ndarray,
            uv: np.ndarray,
            src_w: int,
            src_h: int,
            dst_w: int,
            dst_h: int
    ) -> tuple[np.ndarray, np.ndarray]:

        scale = min(dst_w / src_w, dst_h / src_h)
        new_w = int(src_w * scale)
        new_h = int(src_h * scale)

        pad_x = (dst_w - new_w) // 2
        pad_y = (dst_h - new_h) // 2

        self._logger.debug(
            f"Letterbox params: src=({src_w}x{src_h}), dst=({dst_w}x{dst_h}), "
            f"new=({new_w}x{new_h}), pad=({pad_x},{pad_y})"
        )

        # --- Y ---
        y_resized = cv2.resize(y, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
        y_out = np.full((dst_h, dst_w), YOLO_GRAY_Y, dtype=np.uint8)

        y_start_x = max(pad_x, 0)
        y_start_y = max(pad_y, 0)
        y_end_x = min(pad_x + new_w, dst_w)
        y_end_y = min(pad_y + new_h, dst_h)

        self._logger.debug(
            f"Y output slice: y[{y_start_y}:{y_end_y}, {y_start_x}:{y_end_x}], "
            f"resized shape: {y_resized.shape}"
        )

        y_out[y_start_y:y_end_y, y_start_x:y_end_x] = \
            y_resized[:y_end_y - y_start_y, :y_end_x - y_start_x]

        # --- UV ---
        if uv.ndim == 2:
            uv = uv.reshape(src_h // 2, src_w // 2, 2)
            self._logger.debug(f"UV reshaped to {uv.shape}")

        uv_resized = cv2.resize(
            uv,
            (new_w // 2, new_h // 2),
            interpolation=cv2.INTER_LINEAR
        )
        uv_out = np.full(
            (dst_h // 2, dst_w // 2, 2),
            128,
            dtype=np.uint8
        )

        uv_start_x = max(pad_x // 2, 0)
        uv_start_y = max(pad_y // 2, 0)
        uv_end_x = min(uv_start_x + uv_resized.shape[1], dst_w // 2)
        uv_end_y = min(uv_start_y + uv_resized.shape[0], dst_h // 2)

        self._logger.debug(
            f"UV output slice: uv[{uv_start_y}:{uv_end_y}, {uv_start_x}:{uv_end_x}], "
            f"resized shape: {uv_resized.shape}"
        )

        uv_out[uv_start_y:uv_end_y, uv_start_x:uv_end_x] = \
            uv_resized[:uv_end_y - uv_start_y, :uv_end_x - uv_start_x]

        self._logger.debug(
            f"UV output 2D shape: {uv_out.shape}"
        )

        #uv_out_2d = uv_out.reshape(uv_out.shape[0], uv_out.shape[1] * 2)

        return y_out, uv_out

    def stop(self):
        self._running = False

        if self._thread_batch_maker: self._thread_batch_maker.join(timeout=1)
        self._thread_batch_maker = None