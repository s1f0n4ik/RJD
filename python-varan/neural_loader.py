import threading
from queue import Queue

import cv2
import numpy as np

from camera import NV12Frame
from logger import get_logger
from main_config import YOLO_GRAY_Y, YOLO_GRAY_UV


class NeuralLoader(threading.Thread):

    def __init__(self, name:str, weights_path:str, camera_matrix: list[list[str]], img_size: int, logger=None):
        threading.Thread.__init__(self)
        self.queue = Queue()

        self.camera_matrix = camera_matrix
        self.img_size = img_size
        self.name = name
        self.weights_path = weights_path

        self.logger = logger or get_logger(f"NeuralLoader[{name}]")

        self.logger.info(
            f"Initialized: img_size={img_size}, "
            f"cameras={len(camera_matrix)}x{len(camera_matrix[0]) if camera_matrix else 0}"
        )

        self.running = False

    def get_camera_matrix(self) -> list[list[str]]:
        return self.camera_matrix

    def move_batch(self, frames: list[list[NV12Frame | None]]):
        if not frames or not frames[0]:
            self.logger.warning("move_batch called with empty frames")
            return

        rows : int = len(frames)
        cols : int = len(frames[0])

        cell_h = self.img_size // rows
        cell_w = self.img_size // cols

        self.logger.debug(
            f"Building batch: grid={rows}x{cols}, "
            f"cell={cell_w}x{cell_h}"
        )

        # Конечный NV12, который должен получиться
        y_final = np.full(
            (self.img_size, self.img_size),
            YOLO_GRAY_Y,
            dtype=np.uint8
        )

        uv_final = np.full(
            (self.img_size // 2, self.img_size // 2, 2),
            YOLO_GRAY_UV,
            dtype=np.uint8
        )

        filled = 0
        for row in range(rows):
            for col in range(cols):
                frame = frames[row][col]
                if frame is None:
                    self.logger.debug(f"Frame [{row},{col}] is None, skipping")
                    continue

                # Получаем позиции ячеек изображения
                y0 = row * cell_h
                x0 = col + cell_w

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
                    self.logger.action_error(
                        f"Letterbox failed at [{row},{col}]: {e}"
                    )

        if filled == 0:
            self.logger.warning("Batch created but no frames were filled")
            return

        # Получаем конечный кадр
        batch_frame = NV12Frame(
            y=y_final,
            uv=uv_final,
            width=self.img_size,
            height=self.img_size,
            timestamp_ms=max(
                f.timestamp_ms for row in frames for f in row if f is not None
            )
        )

        if self.queue.full():
            self.queue.get()
            self.logger.warning("Queue full → dropping oldest batch")

        self.queue.put(batch_frame)

        self.logger.info(
            f"Batch pushed: filled={filled}/{rows * cols}, "
            f"timestamp={batch_frame.timestamp_ms}"
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

        self.logger.debug(
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

        self.logger.debug(
            f"Y output slice: y[{y_start_y}:{y_end_y}, {y_start_x}:{y_end_x}], "
            f"resized shape: {y_resized.shape}"
        )

        y_out[y_start_y:y_end_y, y_start_x:y_end_x] = \
            y_resized[:y_end_y - y_start_y, :y_end_x - y_start_x]

        # --- UV ---
        if uv.ndim == 2:
            uv = uv.reshape(src_h // 2, src_w // 2, 2)
            self.logger.debug(f"UV reshaped to {uv.shape}")

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

        self.logger.debug(
            f"UV output slice: uv[{uv_start_y}:{uv_end_y}, {uv_start_x}:{uv_end_x}], "
            f"resized shape: {uv_resized.shape}"
        )

        uv_out[uv_start_y:uv_end_y, uv_start_x:uv_end_x] = \
            uv_resized[:uv_end_y - uv_start_y, :uv_end_x - uv_start_x]

        return y_out, uv_out

    def run(self):
        """Запуск обработки батчей"""
        self.running = True

        while self.running:
            frame = self.queue.get()



    def stop(self):
        self.running = False