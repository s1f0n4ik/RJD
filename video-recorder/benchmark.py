#!/usr/bin/env python3
"""
Performance Benchmark for Orange Pi 5B
Tests system capability under load
"""

import psutil
import time
import subprocess
import json
from typing import Dict, List
import statistics


class SystemBenchmark:
    """System performance benchmark"""

    def __init__(self):
        self.results = {
            'cpu': [],
            'memory': [],
            'disk_io': [],
            'network': []
        }

    def measure_cpu(self, duration: int = 10) -> Dict:
        """Measure CPU usage"""
        print(f"\nMeasuring CPU usage for {duration}s...")

        samples = []
        for _ in range(duration):
            samples.append(psutil.cpu_percent(interval=1, percpu=False))

        result = {
            'avg': statistics.mean(samples),
            'max': max(samples),
            'min': min(samples)
        }

        print(f"CPU: avg={result['avg']:.1f}% max={result['max']:.1f}%")
        return result

    def measure_memory(self) -> Dict:
        """Measure memory usage"""
        print("\nMeasuring memory...")

        mem = psutil.virtual_memory()
        result = {
            'total_gb': mem.total / (1024 ** 3),
            'used_gb': mem.used / (1024 ** 3),
            'percent': mem.percent
        }

        print(f"Memory: {result['used_gb']:.2f}GB / {result['total_gb']:.2f}GB ({result['percent']:.1f}%)")
        return result

    def measure_disk_io(self) -> Dict:
        """Measure disk I/O"""
        print("\nMeasuring disk I/O...")

        disk = psutil.disk_io_counters()
        time.sleep(1)
        disk_after = psutil.disk_io_counters()

        read_speed = (disk_after.read_bytes - disk.read_bytes) / (1024 ** 2)  # MB/s
        write_speed = (disk_after.write_bytes - disk.write_bytes) / (1024 ** 2)

        result = {
            'read_mbps': read_speed,
            'write_mbps': write_speed
        }

        print(f"Disk I/O: read={read_speed:.2f}MB/s write={write_speed:.2f}MB/s")
        return result

    def test_video_encoding(self, resolution: str = "1920x1080", duration: int = 30) -> Dict:
        """Test hardware-accelerated video encoding"""
        print(f"\nTesting video encoding ({resolution}, {duration}s)...")

        output_file = "/tmp/benchmark_test.mp4"

        # Generate test pattern and encode
        cmd = [
            'ffmpeg',
            '-f', 'lavfi',
            '-i', f'testsrc=duration={duration}:size={resolution}:rate=25',
            '-c:v', 'h264_rkmpp',
            '-b:v', '4M',
            '-y',
            output_file
        ]

        start_time = time.time()
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=duration + 10
            )
            elapsed = time.time() - start_time

            if result.returncode == 0:
                fps = duration / elapsed * 25
                print(f"✓ Encoding successful: {fps:.1f} fps")
                return {
                    'success': True,
                    'fps': fps,
                    'elapsed': elapsed
                }
            else:
                print(f"✗ Encoding failed: {result.stderr}")
                return {'success': False}

        except Exception as e:
            print(f"✗ Error: {e}")
            return {'success': False}

    def run_full_benchmark(self) -> Dict:
        """Run complete benchmark suite"""
        print("=" * 50)
        print("ORANGE PI 5B PERFORMANCE BENCHMARK")
        print("=" * 50)

        results = {}

        # System info
        print("\nSystem Information:")
        print(f"CPU Cores: {psutil.cpu_count()}")
        print(f"Total RAM: {psutil.virtual_memory().total / (1024 ** 3):.2f}GB")

        # Run tests
        results['cpu'] = self.measure_cpu(duration=10)
        results['memory'] = self.measure_memory()
        results['disk_io'] = self.measure_disk_io()
        results['video_encoding'] = self.test_video_encoding(duration=30)

        # Save results
        with open('/tmp/benchmark_results.json', 'w') as f:
            json.dump(results, f, indent=2)

        print("\n" + "=" * 50)
        print("BENCHMARK COMPLETE")
        print("=" * 50)
        print(f"Results saved to: /tmp/benchmark_results.json")

        return results


def main():
    benchmark = SystemBenchmark()
    benchmark.run_full_benchmark()


if __name__ == "__main__":
    main()