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
        self.rtsp_url = rtsp_url
        self.camera_name = camera_name
        self.running = False
        self.reconnect_interval = reconnect_interval

        self.on_frame = on_frame
        self.logger = get_logger(__name__, log_level) if log_level != logging.NOTSET else NullLogger()

        self.video_info = {}
        self.width = width
        self.height = height

        self.status = CameraStatus.READY

    def probe_rtsp_stream(self):
        """
        Uses ffprobe via the ffmpeg-python library to get stream information.

        Returns:
            dict: A dictionary containing the video stream's properties or None if an error occurs.
        """
        try:
            # Define arguments for ffmpeg input for better RTSP handling
            args = {
                "rtsp_transport": "tcp",  # Use TCP for reliability
                "fflags": "nobuffer",  # Reduce buffer to lower latency
                "flags": "low_delay"  # Further optimize for low delay
            }

            # Run ffprobe and capture the output
            probe = ffmpeg.probe(self.rtsp_url, **args)

            # Find the first video stream information
            self.video_info = next(x for x in probe['streams'] if x['codec_type'] == 'video')

            self.logger.info(f"[{self.camera_name}]: FFprobe succeeded. Video info:\n {pretty_json(self.video_info)}")

            return True

        except ffmpeg.Error as e:
            self.logger.error(f"[{self.camera_name}]: FFmpeg Error:: {e}")
            self.logger.error("[%s]: FFprobe failed:\n%s", self.camera_name, e.stderr.decode("utf-8", errors="replace"))
            return False
        except StopIteration:
            self.logger.error(f"[{self.camera_name}]: No video stream found in the source URL.", file=sys.stderr)
            return False
        except Exception as e:
            self.logger.error(f"[{self.camera_name}]: An unexpected error occurred: {e}", file=sys.stderr)
            return False

    # Функция, которая запускает ffmpeg
    def receive_frames(self):
        width = self.width or self.video_info['width']
        height = self.height or self.video_info['height']
        frame_size = width * height * 3 // 2  # NV12

        self.logger.info(
            f"[{self.camera_name}] Starting stream {width}x{height}"
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
                    self.rtsp_url,
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
            self.logger.error(f"[{self.camera_name}] FFmpeg start error: {e}")
            return False

        timeout_sec = 3.0  # сколько ждать кадр

        try:
            while self.running:
                rlist, _, _ = select.select(
                    [process.stdout],
                    [],
                    [],
                    timeout_sec
                )

                if not rlist:
                    self.logger.error(
                        f"[{self.camera_name}] Frame timeout ({timeout_sec}s)"
                    )
                    return False

                in_bytes = process.stdout.read(frame_size)

                if not in_bytes or len(in_bytes) < frame_size:
                    self.logger.error(
                        f"[{self.camera_name}] Stream ended or broken"
                    )
                    return False

                frame = np.frombuffer(in_bytes, np.uint8)

                y = frame[:width * height].reshape((height, width))
                uv = frame[width * height:].reshape((height // 2, width))

                nv12_frame = NV12Frame(
                    y=y,
                    uv=uv,
                    width=width,
                    height=height,
                    timestamp_ms=now_ms(),
                )

                self.logger.debug(
                    f"[{self.camera_name}] Received frame: width={nv12_frame.width}, height={nv12_frame.height}, "
                    f"Y shape={nv12_frame.y.shape}, UV shape={nv12_frame.uv.shape}, timestamp_ms={nv12_frame.timestamp_ms}"
                )

                if self.on_frame:
                    self.on_frame(nv12_frame, self.camera_name)

        finally:
            self.logger.info(f"[{self.camera_name}] Stopping ffmpeg")
            try:
                process.terminate()
                process.wait(timeout=1)
            except Exception as e:
                self.logger.error(f"[{self.camera_name}] FFmpeg terminated with error: {e}")
                process.kill()

        return False

    def run(self):
        """Main thread loop: probe → receive frames → repeat."""
        self.logger.info(f"[{self.camera_name}] Thread started")
        self.running = True
        while self.running:
            self.logger.info(f"[{self.camera_name}] Probing stream...")
            while self.running and not self.probe_rtsp_stream():
                self.logger.warning(
                    f"[{self.camera_name}] Probe failed. Retry in {self.reconnect_interval}s"
                )
                time.sleep(self.reconnect_interval)

            self.logger.info(f"[{self.camera_name}] Starting video receive loop")
            self.status = CameraStatus.RUNNING
            ok = self.receive_frames()

            if not ok:
                self.status = CameraStatus.FAILED
                self.logger.warning(
                    f"[{self.camera_name}] Reconnecting in {self.reconnect_interval}s..."
                )
                time.sleep(self.reconnect_interval)

            if not self.running:
                break

        self.logger.info(f"[{self.camera_name}] Thread stopped")

    def stop(self):
        self.running = False
        self.status = CameraStatus.STOPPED
