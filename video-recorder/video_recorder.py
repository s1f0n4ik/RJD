#!/usr/bin/env python3
"""
Orange Pi 5B Video Recorder with NTP Synchronization
Optimized for Rockchip RK3588 with hardware acceleration
"""

import asyncio
import logging
import signal
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional
import yaml
import aiohttp
import subprocess
import json
from dataclasses import dataclass
import psutil
import ntplib
from concurrent.futures import ThreadPoolExecutor

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@dataclass
class CameraConfig:
    """Camera configuration"""
    id: str
    name: str
    rtsp_url: str
    username: str
    password: str
    enabled: bool = True
    fps: int = 25
    resolution: str = "1920x1080"


@dataclass
class RecordingConfig:
    """Recording configuration"""
    segment_duration: int = 300  # seconds (5 minutes)
    output_format: str = "mp4"
    codec: str = "h264_rkmpp"  # Rockchip hardware encoder
    bitrate: str = "4M"
    storage_path: Path = Path("/recordings")
    retention_days: int = 7
    enable_audio: bool = False


class NTPSyncClient:
    """NTP Client for time synchronization"""

    def __init__(self, ntp_server: str = "localhost"):
        self.ntp_server = ntp_server
        self.ntp_client = ntplib.NTPClient()
        self.time_offset = 0.0
        self.last_sync = None

    async def sync_time(self) -> float:
        """Synchronize with NTP server and get offset"""
        try:
            loop = asyncio.get_event_loop()
            with ThreadPoolExecutor() as executor:
                response = await loop.run_in_executor(
                    executor,
                    lambda: self.ntp_client.request(self.ntp_server, version=3)
                )

            self.time_offset = response.offset
            self.last_sync = datetime.now()
            logger.info(f"NTP sync successful. Offset: {self.time_offset:.3f}s")
            return self.time_offset

        except Exception as e:
            logger.error(f"NTP sync failed: {e}")
            return self.time_offset

    def get_synced_timestamp(self) -> datetime:
        """Get current timestamp with NTP correction"""
        return datetime.now() + timedelta(seconds=self.time_offset)

    async def periodic_sync(self, interval: int = 300):
        """Periodic NTP synchronization"""
        while True:
            await self.sync_time()
            await asyncio.sleep(interval)


class CameraRecorder:
    """Individual camera recorder with hardware acceleration"""

    def __init__(
            self,
            camera: CameraConfig,
            recording_config: RecordingConfig,
            ntp_client: NTPSyncClient
    ):
        self.camera = camera
        self.config = recording_config
        self.ntp_client = ntp_client
        self.process: Optional[subprocess.Popen] = None
        self.is_recording = False
        self.reconnect_attempts = 0
        self.max_reconnect_attempts = 10

    def _build_ffmpeg_command(self, output_file: Path) -> List[str]:
        """Build FFmpeg command with hardware acceleration"""

        # Construct authenticated RTSP URL
        rtsp_url = self.camera.rtsp_url.replace(
            "rtsp://",
            f"rtsp://{self.camera.username}:{self.camera.password}@"
        )

        cmd = [
            'ffmpeg',
            '-rtsp_transport', 'tcp',
            '-i', rtsp_url,
            '-c:v', self.config.codec,  # Use Rockchip HW encoder
            '-b:v', self.config.bitrate,
            '-preset', 'fast',
            '-g', '50',  # GOP size
            '-r', str(self.camera.fps),
            '-s', self.camera.resolution,
        ]

        if self.config.enable_audio:
            cmd.extend(['-c:a', 'aac', '-b:a', '128k'])
        else:
            cmd.extend(['-an'])

        # Segmented output
        cmd.extend([
            '-f', 'segment',
            '-segment_time', str(self.config.segment_duration),
            '-segment_format', self.config.output_format,
            '-reset_timestamps', '1',
            '-strftime', '1',
            '-segment_atclocktime', '1',
            str(output_file)
        ])

        return cmd

    def _get_output_path(self) -> Path:
        """Generate output path with timestamp"""
        now = self.ntp_client.get_synced_timestamp()
        date_dir = self.config.storage_path / now.strftime("%Y-%m-%d")
        camera_dir = date_dir / self.camera.id
        camera_dir.mkdir(parents=True, exist_ok=True)

        # Output filename pattern with timestamp
        filename = f"{self.camera.id}_%Y-%m-%d_%H-%M-%S.{self.config.output_format}"
        return camera_dir / filename

    async def start_recording(self):
        """Start recording process"""
        if self.is_recording:
            logger.warning(f"Camera {self.camera.id} is already recording")
            return

        output_path = self._get_output_path()
        cmd = self._build_ffmpeg_command(output_path)

        logger.info(f"Starting recording for {self.camera.name} ({self.camera.id})")
        logger.debug(f"FFmpeg command: {' '.join(cmd)}")

        try:
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True
            )
            self.is_recording = True
            self.reconnect_attempts = 0

            # Monitor process output
            asyncio.create_task(self._monitor_process())

        except Exception as e:
            logger.error(f"Failed to start recording for {self.camera.id}: {e}")
            self.is_recording = False

    async def _monitor_process(self):
        """Monitor FFmpeg process for errors"""
        while self.is_recording and self.process:
            try:
                returncode = self.process.poll()

                if returncode is not None:
                    # Process terminated
                    stderr = self.process.stderr.read() if self.process.stderr else ""
                    logger.error(
                        f"Recording stopped for {self.camera.id}. "
                        f"Return code: {returncode}. Error: {stderr}"
                    )
                    self.is_recording = False

                    # Attempt reconnection
                    if self.reconnect_attempts < self.max_reconnect_attempts:
                        self.reconnect_attempts += 1
                        logger.info(
                            f"Attempting reconnection {self.reconnect_attempts}/"
                            f"{self.max_reconnect_attempts} for {self.camera.id}"
                        )
                        await asyncio.sleep(5)
                        await self.start_recording()
                    else:
                        logger.error(
                            f"Max reconnection attempts reached for {self.camera.id}"
                        )
                    break

                await asyncio.sleep(1)

            except Exception as e:
                logger.error(f"Error monitoring {self.camera.id}: {e}")
                break

    async def stop_recording(self):
        """Stop recording gracefully"""
        if not self.is_recording or not self.process:
            return

        logger.info(f"Stopping recording for {self.camera.id}")
        self.is_recording = False

        try:
            self.process.send_signal(signal.SIGINT)
            await asyncio.sleep(2)

            if self.process.poll() is None:
                self.process.terminate()
                await asyncio.sleep(1)

                if self.process.poll() is None:
                    self.process.kill()

            logger.info(f"Recording stopped for {self.camera.id}")

        except Exception as e:
            logger.error(f"Error stopping recording for {self.camera.id}: {e}")

    def get_status(self) -> Dict:
        """Get current status"""
        return {
            'camera_id': self.camera.id,
            'camera_name': self.camera.name,
            'is_recording': self.is_recording,
            'reconnect_attempts': self.reconnect_attempts,
            'process_running': self.process.poll() is None if self.process else False
        }


class VideoRecorderSystem:
    """Main video recorder system orchestrator"""

    def __init__(self, config_path: str = "/config"):
        self.config_path = Path(config_path)
        self.cameras: List[CameraConfig] = []
        self.recording_config: RecordingConfig = RecordingConfig()
        self.recorders: Dict[str, CameraRecorder] = {}
        self.ntp_client: Optional[NTPSyncClient] = None
        self.running = False

    def load_configuration(self):
        """Load configuration from YAML files"""

        # Load cameras configuration
        cameras_file = self.config_path / "cameras.yaml"
        with open(cameras_file, 'r') as f:
            cameras_data = yaml.safe_load(f)
            self.cameras = [
                CameraConfig(**cam) for cam in cameras_data.get('cameras', [])
            ]

        logger.info(f"Loaded {len(self.cameras)} camera configurations")

        # Load recording configuration
        recording_file = self.config_path / "recording.yaml"
        with open(recording_file, 'r') as f:
            recording_data = yaml.safe_load(f)
            self.recording_config = RecordingConfig(
                **recording_data.get('recording', {})
            )

        # Load NTP configuration
        ntp_file = self.config_path / "ntp.yaml"
        with open(ntp_file, 'r') as f:
            ntp_data = yaml.safe_load(f)
            ntp_server = ntp_data.get('ntp', {}).get('server', 'localhost')
            self.ntp_client = NTPSyncClient(ntp_server)

        logger.info("Configuration loaded successfully")

    async def initialize(self):
        """Initialize the system"""
        logger.info("Initializing Video Recorder System for Orange Pi 5B")

        # Load configuration
        self.load_configuration()

        # Initial NTP sync
        await self.ntp_client.sync_time()

        # Create recorder instances
        for camera in self.cameras:
            if camera.enabled:
                recorder = CameraRecorder(
                    camera,
                    self.recording_config,
                    self.ntp_client
                )
                self.recorders[camera.id] = recorder

        logger.info(f"Initialized {len(self.recorders)} camera recorders")

        # Start periodic NTP sync
        asyncio.create_task(self.ntp_client.periodic_sync())

        # Start cleanup task
        asyncio.create_task(self._cleanup_old_recordings())

    async def start_all_recordings(self):
        """Start recording from all cameras"""
        logger.info("Starting all recordings")
        self.running = True

        tasks = []
        for recorder in self.recorders.values():
            tasks.append(recorder.start_recording())

        await asyncio.gather(*tasks)
        logger.info("All recordings started")

    async def stop_all_recordings(self):
        """Stop all recordings gracefully"""
        logger.info("Stopping all recordings")
        self.running = False

        tasks = []
        for recorder in self.recorders.values():
            tasks.append(recorder.stop_recording())

        await asyncio.gather(*tasks)
        logger.info("All recordings stopped")

    async def _cleanup_old_recordings(self):
        """Cleanup old recordings based on retention policy"""
        while self.running:
            try:
                retention_date = datetime.now() - timedelta(
                    days=self.recording_config.retention_days
                )

                for date_dir in self.recording_config.storage_path.iterdir():
                    if date_dir.is_dir():
                        try:
                            dir_date = datetime.strptime(date_dir.name, "%Y-%m-%d")
                            if dir_date < retention_date:
                                logger.info(f"Removing old recordings: {date_dir}")
                                subprocess.run(['rm', '-rf', str(date_dir)])
                        except ValueError:
                            continue

            except Exception as e:
                logger.error(f"Error during cleanup: {e}")

            # Run cleanup daily
            await asyncio.sleep(86400)

    def get_system_status(self) -> Dict:
        """Get overall system status"""
        cpu_percent = psutil.cpu_percent(interval=1)
        memory = psutil.virtual_memory()
        disk = psutil.disk_usage(str(self.recording_config.storage_path))

        return {
            'system': {
                'cpu_usage': cpu_percent,
                'memory_usage': memory.percent,
                'disk_usage': disk.percent,
                'disk_free_gb': disk.free / (1024 ** 3)
            },
            'ntp': {
                'time_offset': self.ntp_client.time_offset,
                'last_sync': self.ntp_client.last_sync.isoformat() if self.ntp_client.last_sync else None
            },
            'cameras': [
                recorder.get_status() for recorder in self.recorders.values()
            ]
        }


async def main():
    """Main entry point"""
    system = VideoRecorderSystem()

    # Setup signal handlers
    loop = asyncio.get_event_loop()

    async def shutdown(sig):
        logger.info(f"Received exit signal {sig.name}")
        await system.stop_all_recordings()
        loop.stop()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(
            sig,
            lambda s=sig: asyncio.create_task(shutdown(s))
        )

    try:
        # Initialize and start
        await system.initialize()
        await system.start_all_recordings()

        # Keep running
        while system.running:
            status = system.get_system_status()
            logger.info(f"System status: {json.dumps(status, indent=2)}")
            await asyncio.sleep(60)

    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        await system.stop_all_recordings()
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())