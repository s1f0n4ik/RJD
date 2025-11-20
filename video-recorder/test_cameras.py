#!/usr/bin/env python3
"""
Camera Connection Test Script
Tests RTSP connectivity and stream quality
"""

import subprocess
import sys
import yaml
from pathlib import Path
from typing import List, Dict
import time


def load_cameras(config_path: str = "config/cameras.yaml") -> List[Dict]:
    """Load camera configuration"""
    with open(config_path, 'r') as f:
        data = yaml.safe_load(f)
        return data.get('cameras', [])


def test_rtsp_connection(camera: Dict) -> bool:
    """Test RTSP connection to camera"""
    print(f"\nTesting {camera['name']} ({camera['id']})...")

    # Build RTSP URL with credentials
    rtsp_url = camera['rtsp_url'].replace(
        "rtsp://",
        f"rtsp://{camera['username']}:{camera['password']}@"
    )

    # Use FFprobe to test connection
    cmd = [
        'ffprobe',
        '-v', 'error',
        '-rtsp_transport', 'tcp',
        '-timeout', '5000000',  # 5 seconds
        '-show_entries', 'stream=codec_name,width,height,r_frame_rate',
        '-of', 'default=noprint_wrappers=1',
        rtsp_url
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=10
        )

        if result.returncode == 0:
            print(f"✓ Connection successful")
            print(f"Stream info:\n{result.stdout}")
            return True
        else:
            print(f"✗ Connection failed")
            print(f"Error: {result.stderr}")
            return False

    except subprocess.TimeoutExpired:
        print(f"✗ Connection timeout")
        return False
    except Exception as e:
        print(f"✗ Error: {e}")
        return False


def test_stream_recording(camera: Dict, duration: int = 10) -> bool:
    """Test recording from camera"""
    print(f"\nTesting recording for {duration} seconds...")

    rtsp_url = camera['rtsp_url'].replace(
        "rtsp://",
        f"rtsp://{camera['username']}:{camera['password']}@"
    )

    output_file = f"/tmp/test_{camera['id']}.mp4"

    cmd = [
        'ffmpeg',
        '-rtsp_transport', 'tcp',
        '-i', rtsp_url,
        '-t', str(duration),
        '-c', 'copy',
        '-y',
        output_file
    ]

    try:
        start_time = time.time()
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=duration + 5
        )
        elapsed = time.time() - start_time

        if result.returncode == 0:
            # Check file size
            file_size = Path(output_file).stat().st_size / (1024 * 1024)  # MB
            print(f"✓ Recording successful")
            print(f"Duration: {elapsed:.1f}s, Size: {file_size:.2f}MB")

            # Cleanup
            Path(output_file).unlink()
            return True
        else:
            print(f"✗ Recording failed")
            print(f"Error: {result.stderr}")
            return False

    except Exception as e:
        print(f"✗ Error: {e}")
        return False


def main():
    """Main test execution"""
    print("=== Orange Pi 5B Camera Test ===\n")

    # Load cameras
    try:
        cameras = load_cameras()
        print(f"Found {len(cameras)} cameras in configuration\n")
    except Exception as e:
        print(f"Error loading configuration: {e}")
        sys.exit(1)

    # Test each camera
    results = {}
    for camera in cameras:
        if not camera.get('enabled', True):
            print(f"\nSkipping disabled camera: {camera['name']}")
            continue

        # Test connection
        connection_ok = test_rtsp_connection(camera)

        # Test recording if connection is OK
        recording_ok = False
        if connection_ok:
            recording_ok = test_stream_recording(camera, duration=10)

        results[camera['id']] = {
            'connection': connection_ok,
            'recording': recording_ok
        }

    # Summary
    print("\n" + "=" * 50)
    print("TEST SUMMARY")
    print("=" * 50)

    for camera_id, result in results.items():
        status = "✓ PASS" if all(result.values()) else "✗ FAIL"
        print(f"{camera_id}: {status}")
        print(f"  Connection: {'✓' if result['connection'] else '✗'}")
        print(f"  Recording:  {'✓' if result['recording'] else '✗'}")

    # Exit code
    all_passed = all(all(r.values()) for r in results.values())
    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()