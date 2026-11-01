import asyncio
import json
import socket
import struct
import subprocess
import sys
import tempfile
import importlib.util
import os
import shutil
import sqlite3
import warnings
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from emulators import Emulators
from models import Emulation, Target as TargetConfig
from reuse import load
from store import Trace
from target import Target


def port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class MediaChecks(unittest.IsolatedAsyncioTestCase):
    async def test_websocket_receiver_checks_framing_and_bounds(self):
        from websockets.asyncio.client import connect
        with tempfile.TemporaryDirectory() as root:
            settings = Emulation(protocols=['ws'], ws_port=port())
            emulator = Emulators(Target(TargetConfig(), Path(root)), settings, Trace(Path(root), 1))
            try:
                await emulator.start()
                async with connect(f'ws://127.0.0.1:{settings.ws_port}/ws/frames') as client:
                    header = json.dumps({'ver': 1, 'type': 'frame', 'id': 17}).encode()
                    await client.send(struct.pack('>I', len(header))+header+b'PNG')
                    for _ in range(30):
                        if emulator.counts['ws_messages']:
                            break
                        await asyncio.sleep(.05)
                self.assertEqual(emulator.counts['ws_messages'], 1)
                self.assertEqual(emulator.trace.rows[0]['value']['image_bytes'], 3)
                async with connect(f'ws://127.0.0.1:{settings.ws_port}/ws/frames') as client:
                    await client.send(struct.pack('>I', 1000)+b'{}')
                    for _ in range(30):
                        if emulator.counts['errors']:
                            break
                        await asyncio.sleep(.05)
                self.assertEqual(emulator.counts['errors'], 1)
            finally:
                await emulator.stop()

    async def test_reference_rtsp_is_playable_and_emits_play_timestamp(self):
        with tempfile.TemporaryDirectory() as root:
            video = Path(root)/'source.mp4'
            generated = await asyncio.create_subprocess_exec('ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x96:rate=10', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(video))
            self.assertEqual(await generated.wait(), 0)
            listener = port()
            worker = await asyncio.create_subprocess_exec('python', str(Path(__file__).resolve().parents[1]/'rtsp.py'), str(video), '--port', str(listener), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                ready = json.loads(await asyncio.wait_for(worker.stdout.readline(), 10))
                self.assertTrue(ready['ready'])
                playback = await asyncio.create_subprocess_exec('ffmpeg', '-v', 'error', '-rtsp_transport', 'tcp', '-i', f'rtsp://127.0.0.1:{listener}/ISAPI/Streaming/Channels/101', '-t', '1', '-f', 'null', '-', stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
                try:
                    _, errors = await asyncio.wait_for(playback.communicate(), 20)
                    self.assertEqual(playback.returncode, 0, errors.decode())
                    played = json.loads(await asyncio.wait_for(worker.stdout.readline(), 5))
                    self.assertGreater(played['play_ms'], 0)
                finally:
                    if playback.returncode is None:
                        playback.kill()
                        await playback.wait()
            finally:
                worker.terminate()
                await worker.wait()


class ReuseChecks(unittest.TestCase):
    def test_existing_rtu_master_selfcheck(self):
        module = load('rjd_rtu_check', 'modbus', 'server.py')
        module.selftest()

    def host(self):
        spec = importlib.util.spec_from_file_location('host_check', Path(__file__).resolve().parents[1]/'host.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_pid_identity_fences_process_signals(self):
        host = self.host()
        binary = str(Path(shutil.which('sleep')).resolve())
        with tempfile.TemporaryDirectory() as root:
            config = {'binary': binary, 'cwd': root, 'argv': ['30'], 'env': {}, 'gst_env': '/dev/null'}
            before = host.discover(config)
            self.assertFalse(before['running'])
            saved = {**before, 'env': {'RJD_TEST_RUN': 'identity-check'}}
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', ResourceWarning)
                current = host.start(config, saved)
            try:
                wrong = {**current, 'started': 'invalid-token'}
                with self.assertRaises(RuntimeError):
                    host.stop(config, wrong)
                self.assertTrue(host.discover(config)['running'])
            finally:
                self.assertTrue(host.stop(config, current)['stopped'])
                os.waitpid(current['pid'], 0)
            self.assertFalse(host.discover(config)['running'])

    def test_recording_window_does_not_misclassify_preexisting_indexed_file(self):
        host = self.host()
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root)
            video = folder/'new.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=size=160x96:rate=10', '-t', '1', '-c:v', 'libx264', str(video)], check=True)
            old = folder/'old.mp4'
            shutil.copyfile(video, old)
            os.utime(video, (1.4, 1.4))
            os.utime(old, (1.4, 1.4))
            conn = sqlite3.connect(folder/'segments.db')
            conn.execute('CREATE TABLE segments (path TEXT, wall_start_ms INTEGER, mono_start_ms INTEGER, camera_id TEXT, stream_key TEXT, session_uid TEXT, closed INTEGER)')
            conn.executemany('INSERT INTO segments VALUES (?,?,?,?,?,?,?)', [(str(old), 500, 500, 'camera', 'main', 'session', 1), (str(video), 10801250, 1250, 'camera', 'main', 'session', 1)])
            conn.commit()
            conn.close()
            (folder/'target.json').write_text(json.dumps({'path': root}))
            result = host.recording({'archive': root}, {'since_ms': 1000, 'until_ms': 2000, 'after_id': 1, 'through_id': 2})
            self.assertEqual(len(result['rows']), 1)
            self.assertTrue(result['rows'][0]['packets'])
            self.assertEqual(result['unindexed_files'], [])
            checkpoint = host.recording({'archive': root}, {'list_only': True})
            self.assertEqual(checkpoint['last_id'], 2)
            self.assertEqual(checkpoint['latest'][0]['checkpoint_id'], 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
