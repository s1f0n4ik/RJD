import asyncio
import copy
import json
import sys
import tempfile
import unittest
import socket
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from engine import BusyError, Engine
from main import create_app
from models import Emulation, RunOptions, Target as TargetConfig
from oracle import compare, classify_gaps
from store import Store, Trace, atomic, html_report, redacted
from target import storage_budget


def pool():
    return {'volumes': [{'id': 'internal', 'internal': True, 'state': 'online', 'total_bytes': 100*1024**3, 'used_bytes': 70*1024**3, 'high': 90}], 'target': {'volume_id': 'internal'}, 'summary': {'journal_reserve_bytes': 10*1024**3, 'journal_bytes': 2*1024**3}}


class FakeTarget:
    profile = 'original'
    fail_restore = False
    running = True
    owner = None
    delay = 0
    stopped = 0

    def __init__(self, config, root):
        self.config, self.root = config, root

    async def request(self, service, method, path, body=None, **kwargs):
        if path=='/api/config/effective':
            return {'profile': {'id': self.profile}, 'entities': {'binding': {'board': {'body': {'device_id': 'local'}}}}, 'broken': []}
        if path=='/api/config/status':
            return {'devices': [{'state': 'ok', 'expected': 'v1', 'applied': 'v1'}], 'transition': {'phase': 'complete'}}
        if path=='/api/storage/pool':
            return pool()
        if path=='/system/info':
            if not self.running:
                raise RuntimeError('MC is stopped')
            return {'device_id': 'local'}
        return {}

    async def rpc(self, operation, payload=None, timeout=90):
        if operation=='sample':
            return {'services': {str(i): {'running': True, 'health': 'healthy'} for i in range(7)}, 'binary_exists': True, 'mc': {'running': self.running}, 'available_mb': 4096, 'temperatures': [40]}
        if operation=='discover':
            return {'running': self.running, 'pid': 17, 'exe': self.config.binary, 'started': '123', 'boot': 'boot', 'argv': [self.config.binary], 'cwd': self.config.cwd, 'env': {}, 'owner': self.owner}
        if operation=='start':
            type(self).running = True
            type(self).owner = payload['saved']['env'].get('RJD_TEST_RUN')
            return await self.rpc('discover')
        if operation=='stop':
            type(self).running = False
            type(self).stopped += 1
            return {'stopped': True, 'forced': False}
        raise AssertionError(operation)

    async def ready(self, timeout=120):
        return {'device_id': 'local'}

    async def transition(self, profile, timeout=240):
        if profile=='original' and self.fail_restore:
            raise RuntimeError('Injected restoration error')
        if profile!='original':
            await asyncio.sleep(self.delay)
        type(self).profile = profile
        return {'phase': 'complete'}

    async def source(self, *args):
        return {}


class SessionChecks(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.engine = Engine(self.store, FakeTarget)
        FakeTarget.profile, FakeTarget.fail_restore, FakeTarget.running, FakeTarget.owner, FakeTarget.delay, FakeTarget.stopped = 'original', False, True, None, 0, 0

    async def asyncTearDown(self):
        if self.engine.task and not self.engine.task.done():
            await self.engine.stop()
            await self.engine.task
        await self.engine.shutdown()
        self.temp.cleanup()

    async def test_one_session_and_successful_restoration(self):
        FakeTarget.delay = .1
        await self.engine.start('tests', RunOptions(cases=['services'], minutes=1))
        with self.assertRaises(BusyError):
            await self.engine.start('emulation', Emulation(protocols=['ws']))
        await self.engine.task
        self.assertIsNone(self.engine.active)
        self.assertEqual(FakeTarget.profile, 'original')
        report = self.store.runs()[0]
        self.assertEqual(report['state'], 'completed')
        self.assertTrue(report['cleanup']['restored'])

    async def test_failed_restoration_blocks_new_session_until_retry(self):
        FakeTarget.fail_restore = True
        await self.engine.start('tests', RunOptions(cases=['services']))
        await self.engine.task
        self.assertEqual(self.engine.active['phase'], 'recovery_failed')
        with self.assertRaises(BusyError):
            await self.engine.start('tests', RunOptions(cases=['services']))
        FakeTarget.fail_restore = False
        await self.engine.retry()
        await self.engine.task
        self.assertIsNone(self.engine.active)

    async def test_originally_stopped_mc_is_stopped_again(self):
        FakeTarget.running = False
        await self.engine.start('tests', RunOptions(cases=['services']))
        await self.engine.task
        self.assertFalse(FakeTarget.running)
        self.assertEqual(FakeTarget.stopped, 1)

    async def test_operator_cancel_restores_profile(self):
        FakeTarget.delay = .1
        await self.engine.start('tests', RunOptions(cases=['services']))
        await asyncio.sleep(.03)
        await self.engine.stop()
        await self.engine.task
        self.assertEqual(self.store.runs()[0]['state'], 'cancelled')
        self.assertEqual(FakeTarget.profile, 'original')

    async def test_cancel_before_worker_starts_releases_session(self):
        await self.engine.start('tests', RunOptions(cases=['services']))
        await self.engine.stop()
        await self.engine.task
        self.assertIsNone(self.engine.active)
        self.assertEqual(self.store.runs()[0]['state'], 'cancelled')

    async def test_unsafe_recovery_keeps_mc_stopped_and_blocks_new_runs(self):
        original = FakeTarget.request
        async def unsafe(target, service, method, path, body=None, **kwargs):
            if service=='storage' and self.engine.active and self.engine.active['phase']=='recovering':
                value = pool()
                value['volumes'][0]['used_bytes'] = 89*1024**3
                return value
            return await original(target, service, method, path, body, **kwargs)
        with patch.object(FakeTarget, 'request', unsafe):
            await self.engine.start('tests', RunOptions(cases=['services']))
            await self.engine.task
        self.assertFalse(FakeTarget.running)
        self.assertEqual(self.engine.active['phase'], 'recovery_failed')
        await self.engine.retry()
        await self.engine.task
        self.assertTrue(FakeTarget.running)
        self.assertEqual(FakeTarget.profile, 'original')
        self.assertIsNone(self.engine.active)

    async def test_restart_recovers_without_resuming_test(self):
        run_id = 'run-restart'
        self.store.path('runs', run_id).mkdir()
        self.store.report({'id': run_id, 'target': 'local', 'state': 'running', 'phase': 'load', 'started_at': '2026-11-01T00:00:00+00:00', 'checks': [], 'artifacts': [], 'events': []})
        active = {'id': run_id, 'kind': 'tests', 'config': TargetConfig().model_dump(), 'phase': 'testing', 'snapshot': {'profile': 'original', 'process': {'running': True, 'argv': [TargetConfig().binary], 'cwd': '/tmp', 'env': {}}, 'temporary': 'temporary'}, 'profile_touched': True}
        atomic(self.store.root/'private'/'active.json', active)
        self.engine = Engine(self.store, FakeTarget)
        await self.engine.startup()
        await self.engine.task
        self.assertIsNone(self.engine.active)
        self.assertEqual(self.store.runs()[0]['state'], 'interrupted')

    async def test_duplicate_cases_rejected(self):
        with self.assertRaises(ValueError):
            await self.engine.start('tests', RunOptions(cases=['services', 'services']))

    async def test_manual_emulation_never_switches_profile(self):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        await self.engine.start('emulation', Emulation(protocols=['ws'], ws_port=port))
        for _ in range(100):
            if self.engine.active and self.engine.active['phase']=='emulation':
                break
            await asyncio.sleep(.02)
        self.assertEqual(self.engine.active['phase'], 'emulation')
        self.assertIsNone(self.engine.active['snapshot'])
        await self.engine.stop()
        await self.engine.task
        self.assertEqual(FakeTarget.profile, 'original')
        self.assertTrue(self.store.runs()[0]['cleanup']['settings_changed'] is False)


class StorageChecks(unittest.TestCase):
    def test_logical_reserve_prevents_false_free_space_pass(self):
        value = pool()
        self.assertEqual(storage_budget(value, 4*1024**3)[0]['headroom_bytes'], 12*1024**3)
        value['volumes'][0]['used_bytes'] = 80*1024**3
        with self.assertRaises(RuntimeError):
            storage_budget(value, 4*1024**3)

    def test_unknown_accounting_fails_closed(self):
        for value in ({}, {**pool(), 'summary': {}}):
            with self.assertRaises(RuntimeError):
                storage_budget(value, 0)

    def test_unselected_internal_volume_is_also_guarded(self):
        value = pool()
        value['volumes'][0]['used_bytes'] = 89*1024**3
        value['target']['volume_id'] = 'usb'
        value['volumes'].append({'id': 'usb', 'state': 'online', 'total_bytes': 100*1024**3, 'used_bytes': 10*1024**3, 'high': 90})
        with self.assertRaises(RuntimeError):
            storage_budget(value, 4*1024**3)

    def test_report_escaping_redaction_and_trace_bound(self):
        with tempfile.TemporaryDirectory() as root:
            trace = Trace(Path(root), 1)
            for i in range(50):
                trace.add('test', {'payload': 'x'*100000})
            self.assertLess(sum(p.stat().st_size for p in Path(root).glob('*.jsonl')), 1024**2)
            self.assertEqual(trace.total, 50)
        report = {'id': '<script>', 'target': '<script>', 'started_at': '', 'state': 'completed', 'checks': [], 'cleanup': {}}
        self.assertNotIn('<script>', html_report(report))
        self.assertEqual(redacted({'password': 'abc'})['password'], '[redacted]')


class OracleChecks(unittest.TestCase):
    def test_external_ack_and_camera_correlations(self):
        expectations = [{'channel': 'journal', 'start': 1, 'end': 3, 'minimum': 1, 'maximum': 1, 'fields': {'class_name': 'person'}}, {'channel': 'modbus', 'start': 1, 'end': 3, 'minimum': 1, 'maximum': 1, 'fields': {'code': 1}}, {'channel': 'ws', 'start': 1, 'end': 3, 'minimum': 1, 'maximum': 1, 'fields': {'dets.0.cls': 'person'}}]
        journal = [{'id': 15, 'started_at': 10802000, 'observed_ms': 2000, 'class_name': 'person'}]
        trace = [{'channel': 'modbus-records', 'wall_ms': 2000, 'value': {'frame': 15, 'code': 1}}, {'channel': 'modbus-records', 'wall_ms': 2000, 'value': {'frame': 14, 'code': 1}}, {'channel': 'ws', 'wall_ms': 2000, 'value': {'header': {'cam': 'camera', 'ts': 10802000, 'dets': [{'cls': 'person'}]}}}]
        result = compare(expectations, journal, trace, 0, 'camera')
        self.assertTrue(result['passed'])
        self.assertEqual(result['received_counts']['modbus'], 1)
        self.assertFalse(compare(expectations, journal, [], 0, 'camera')['passed'])

    def test_negative_window_is_independently_enforced(self):
        expectation = {'channel': 'journal', 'start': 0, 'end': 10, 'minimum': 0, 'maximum': 0, 'fields': {'class_name': 'person'}}
        self.assertFalse(compare([expectation], [{'id': 1, 'started_at': 10802000, 'observed_ms': 2000, 'class_name': 'person'}], [], 0, 'camera')['passed'])

    def test_expected_gap_requires_exact_file_checkpoint_and_bounded_duration(self):
        rows = [{'session_uid': 'session', 'camera_id': 'camera', 'stream_key': 'main', 'file': name, 'checkpoint_id': key} for name, key in [('a', 10), ('b', 11), ('c', 12)]]
        gap = {'session': 'session', 'camera': 'camera', 'stream': 'main', 'previous': 'a', 'following': 'b', 'gap_ms': 5000}
        pause = {'expected_pause': True, 'reason': 'transition', 'start_ms': 0, 'end_ms': 5000, 'before': [rows[0]], 'after': [rows[1]]}
        self.assertTrue(classify_gaps([gap], rows, [pause])[0]['expected'])
        self.assertFalse(classify_gaps([{**gap, 'gap_ms': 9000}], rows, [pause])[0]['expected'])
        self.assertFalse(classify_gaps([{**gap, 'previous': 'b', 'following': 'c'}], rows, [pause])[0]['expected'])


class ApiChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(self.temp.name, 'local-check-password', lambda store: Engine(store, FakeTarget))
        self.client = TestClient(self.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def test_login_and_protected_api(self):
        self.assertEqual(self.client.get('/api/state').status_code, 401)
        self.assertEqual(self.client.get('/docs').status_code, 401)
        self.assertEqual(self.client.post('/api/login', json={'password': 'wrong'}).status_code, 401)
        self.assertEqual(self.client.post('/api/login', json={'password': 'local-check-password'}).status_code, 200)
        self.assertEqual(self.client.get('/api/state').status_code, 200)
        self.assertEqual(self.client.post('/api/logout').status_code, 200)
        self.assertEqual(self.client.get('/api/state').status_code, 401)

    def test_cookie_csrf_and_bearer_api(self):
        headers = {'Authorization': 'Bearer local-check-password'}
        self.assertEqual(self.client.get('/api/state', headers=headers).status_code, 200)
        self.client.post('/api/login', json={'password': 'local-check-password'})
        self.assertEqual(self.client.put('/api/target', json={}, headers={'origin': 'http://foreign.test'}).status_code, 403)

    def test_no_tests_on_page_or_service_start(self):
        self.client.get('/')
        self.assertIsNone(self.app.state.engine.active)
        self.assertFalse(self.app.state.store.runs())

    def test_oversized_key_is_rejected_before_file_write(self):
        self.client.post('/api/login', json={'password': 'local-check-password'})
        response = self.client.post('/api/target/key', content=b'x'*65537, headers={'Content-Type': 'application/octet-stream'})
        self.assertEqual(response.status_code, 413)
        self.assertFalse((self.app.state.store.root/'private'/'ssh-key').exists())

    def test_video_budget_is_checked_before_persistent_or_spooled_upload(self):
        self.client.post('/api/login', json={'password': 'local-check-password'})
        scenario = self.client.post('/api/scenarios', json={'name': 'Reference', 'model_sha256': '0'*64, 'config_id': 'config', 'camera_id': 'camera', 'duration': 10, 'expectations': [{'start': 1, 'end': 2, 'fields': {'class_name': 'person'}}]}).json()
        original = FakeTarget.request
        async def full(target, service, method, path, body=None, **kwargs):
            if service=='storage':
                value = pool()
                value['volumes'][0]['used_bytes'] = 89*1024**3
                return value
            return await original(target, service, method, path, body, **kwargs)
        with patch.object(FakeTarget, 'request', full):
            response = self.client.post('/api/scenarios/'+scenario['id']+'/video', content=b'x'*1024**2, headers={'Content-Type': 'application/octet-stream'})
        self.assertEqual(response.status_code, 409)
        folder = self.app.state.store.path('scenarios', scenario['id'])
        self.assertFalse((folder/'video').exists())
        self.assertFalse((folder/'video.part').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
