import logging
import threading
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Any

import ffmpeg
import numpy as np
import time
import sys

import select

from logger import get_logger, NullLogger
from utility import pretty_json, now_ms

class CameraStatus(Enum):
    FAILED = 1
    RUNNING = 2
    STOPPED = 3
    READY = 4

@dataclass(slots=True)
class NV12Frame:
    y: np.ndarray
    uv: np.ndarray
    width: int
    height: int
    timestamp_ms: int          # время в миллисекундах

FrameCallback = Callable[[NV12Frame, str], Any]

class CameraStream(threading.Thread):
    def __init__(
            self,
            rtsp_url: str,
            camera_name: str,
            width: int | None,
            height: int | None,
            on_frame: FrameCallback | None = None,
            reconnect_interval=5,
            log_level: int = logging.NOTSET,
    ):
        super().__init__(daemon=True)
        self._rtsp_url = rtsp_url
        self._camera_name = camera_name
        self._running = False
        self._reconnect_interval = reconnect_interval

        self._on_frame = on_frame
        self._log_level = log_level
        self._logger = get_logger(__name__, log_level) if log_level != logging.NOTSET else NullLogger()

        self.video_info = {}
        self._width = width
        self._height = height

        self._status = CameraStatus.STOPPED

    @property
    def status(self): return self._status

    @property
    def imgsz(self):
        return (
            self._width or self.video_info.get('width', None),
            self._height or self.video_info.get('height', None)
        )
    @imgsz.setter
    def imgsz(self, value):
        if not isinstance(value, (tuple, list)) or len(value) != 2:
            raise ValueError("imgsz must be (width, height)")
        self._width, self._height = value

    @property
    def reconnect_interval(self): return self._reconnect_interval
    @reconnect_interval.setter
    def reconnect_interval(self, value):
        if value < 0:
            raise ValueError("reconnect_interval must be >= 0")
        self._reconnect_interval = value

    @property
    def rtsp_url(self): return self._rtsp_url
    @rtsp_url.setter
    def rtsp_url(self, value):
        self._rtsp_url = value

    @property
    def camera_name(self): return self._camera_name
    @camera_name.setter
    def camera_name(self, value):
        self._camera_name = value

    @property
    def logging(self): return self._log_level
    @logging.setter
    def logging(self, value):
        self._log_level = value

    def probe_rtsp_stream(self):
        try:
            args = {
                "rtsp_transport": "tcp",
                "fflags": "nobuffer",
                "flags": "low_delay"
            }

            probe = ffmpeg.probe(self._rtsp_url, **args)

            self.video_info = next(x for x in probe['streams'] if x['codec_type'] == 'video')

            self._logger.info(f"[{self._camera_name}]: FFprobe succeeded. Video info:\n {pretty_json(self.video_info)}")
            self._status = CameraStatus.READY
            return True

        except ffmpeg.Error as e:
            self._logger.error(f"[{self._camera_name}]: FFmpeg Error:: {e}")
            self._logger.error("[%s]: FFprobe failed:\n%s", self._camera_name, e.stderr.decode("utf-8", errors="replace"))
            return False
        except StopIteration:
            self._logger.error(f"[{self._camera_name}]: No video stream found in the source URL.", file=sys.stderr)
            return False
        except Exception as e:
            self._logger.error(f"[{self._camera_name}]: An unexpected error occurred: {e}", file=sys.stderr)
            return False

    # Функция, которая запускает ffmpeg
    def receive_frames(self):
        width = self._width or self.video_info['width']
        height = self._height or self.video_info['height']
        frame_size = width * height * 3 // 2  # NV12

        self._logger.info(
            f"[{self._camera_name}] Starting stream {width}x{height}"
        )

        codec_map = {
            'h264': 'h264_rkmpp',
            'hevc': 'hevc_rkmpp',
        }

        codec = codec_map.get(
            self.video_info.get('codec_name'),
            'h264_rkmpp'
        )

        try:
            process = (
                ffmpeg
                .input(
                    self._rtsp_url,
                    rtsp_transport='tcp',
                    fflags='nobuffer',
                    flags='low_delay',
                    analyzeduration='0',
                    probesize='32',
                    max_delay=0,
                )
                .output(
                    'pipe:',
                    format='rawvideo',
                    pix_fmt='nv12'
                )
                .global_args(
                    '-loglevel', 'error',
                    '-hwaccel', 'rkmpp',
                    '-c:v', codec,
                    '-an'
                )
                .run_async(
                    pipe_stdout=True,
                    pipe_stderr=False
                )
            )
        except ffmpeg.Error as e:
            self._status = CameraStatus.FAILED
            self._logger.error(f"[{self._camera_name}] FFmpeg start error: {e}")
            return False

        timeout_sec = 3.0  # сколько ждать кадр
        first_frame = True

        try:
            while self._running:
                rlist, _, _ = select.select(
                    [process.stdout],
                    [],
                    [],
                    timeout_sec
                )

                if not rlist:
                    self._logger.error(
                        f"[{self._camera_name}] Frame timeout ({timeout_sec}s)"
                    )
                    return False

                in_bytes = process.stdout.read(frame_size)

                if not in_bytes or len(in_bytes) < frame_size:
                    self._logger.error(
                        f"[{self._camera_name}] Stream ended or broken"
                    )
                    self._status = CameraStatus.FAILED
                    return False

                frame = np.frombuffer(in_bytes, np.uint8)
                if first_frame:
                    first_frame = False
                    self._status = CameraStatus.RUNNING

                y = frame[:width * height].reshape((height, width))
                uv = frame[width * height:].reshape((height // 2, width))

                nv12_frame = NV12Frame(
                    y=y,
                    uv=uv,
                    width=width,
                    height=height,
                    timestamp_ms=now_ms(),
                )

                self._logger.debug(
                    f"[{self._camera_name}] Received frame: width={nv12_frame.width}, height={nv12_frame.height}, "
                    f"Y shape={nv12_frame.y.shape}, UV shape={nv12_frame.uv.shape}, timestamp_ms={nv12_frame.timestamp_ms}"
                )

                if self._on_frame:
                    self._on_frame(nv12_frame, self._camera_name)

        except Exception as e:
            self._status = CameraStatus.FAILED
            self._logger.error(f"[{self._camera_name}] Stream error: {e}")
            return False

        finally:
            self._logger.info(f"[{self._camera_name}] Stopping ffmpeg")
            try:
                process.terminate()
                process.wait(timeout=1)
            except Exception as e:
                self._logger.error(f"[{self._camera_name}] FFmpeg terminated with error: {e}")
                process.kill()

        return False

    def run(self):
        """Main thread loop: probe → receive frames → repeat."""
        self._logger.info(f"[{self._camera_name}] Thread started")
        self._running = True

        while self._running:
            self._logger.info(f"[{self._camera_name}] Probing stream...")
            while self._running and not self.probe_rtsp_stream():
                self._logger.warning(
                    f"[{self._camera_name}] Probe failed. Retry in {self._reconnect_interval}s"
                )
                time.sleep(self._reconnect_interval)

            self._logger.info(f"[{self._camera_name}] Starting video receive loop")
            ok = self.receive_frames()

            if not ok:
                self._status = CameraStatus.FAILED
                self._logger.warning(
                    f"[{self._camera_name}] Reconnecting in {self._reconnect_interval}s..."
                )
                time.sleep(self._reconnect_interval)

            if not self._running:
                break

        self._logger.info(f"[{self._camera_name}] Thread stopped")

    def stop(self):
        self._running = False
        self._status = CameraStatus.STOPPED
