import asyncio
import base64
import copy
import importlib.util
import json
import os
import shutil
import time
import struct
import threading
import signal
from pathlib import Path
from urllib.parse import quote

from emulators import Emulators
from engine import Cancelled, Unavailable
from reuse import load
from store import BudgetError, Trace


class Cases:
    def __init__(self, engine, target, options, bodies):
        self.e = engine
        self.target = target
        self.options = options
        self.bodies = bodies
        self.profile = engine.active['snapshot']['temporary']
        self.device = engine.active['snapshot']['device']
        self.root = engine.store.path('runs', engine.active['id'])
        self.since = round(time.time()*1000)
        self.expected_pauses = []
        self.started = time.monotonic()
        self.trace = Trace(self.root, target.config.trace_mb)

    async def begin_pause(self, reason, expected=True):
        pause = {'reason': reason, 'expected_pause': expected, 'start_ms': round(time.time()*1000)}
        if 'recording' in self.options.cases:
            pause['before'] = (await self.target.rpc('recording', {'list_only': True}))['latest']
        return pause

    async def end_pause(self, pause):
        if 'recording' in self.options.cases:
            pause['after'] = (await self.target.rpc('recording', {'list_only': True}))['latest']
        pause['end_ms'] = round(time.time()*1000)
        self.expected_pauses.append(pause)

    async def transition(self, profile):
        pause = await self.begin_pause('Profile lifecycle transition')
        await self.target.transition(profile)
        await self.recording_ready()
        await self.end_pause(pause)

    async def recording_ready(self):
        if not getattr(self, 'recording_streams', None):
            return
        deadline = time.monotonic()+30
        while time.monotonic()<deadline:
            cameras = (await self.target.request('mc', 'GET', '/camera')).get('cameras', {})
            if all(cameras.get(camera, {}).get('streams', {}).get(key, {}).get('status')==3 for camera, key in self.recording_streams):
                return
            await self.e.wait(.5)
        raise RuntimeError('Recording camera streams did not recover')

    async def source(self, kind, key, body):
        active = await self.target.request('api', 'GET', '/api/config/effective')
        if active['profile']['id']!=self.profile:
            raise RuntimeError('Application profile changed outside the test session')
        pause = await self.begin_pause('Apply '+kind+'/'+key)
        await self.target.source(self.profile, kind, key, body)
        await self.applied()
        if kind=='camera' and body and body.get('camera', {}).get('ip_adress')!='127.0.0.1':
            await self.recording_ready()
        await self.end_pause(pause)

    async def applied(self, timeout=150):
        deadline = time.monotonic()+timeout
        while time.monotonic()<deadline:
            self.e.check_cancel()
            state = await self.target.request('api', 'GET', '/api/config/status')
            transition = state.get('transition') or {}
            if transition.get('error'):
                raise RuntimeError('Configuration transition failed: '+str(transition['error']))
            devices = state.get('devices', [])
            if transition.get('phase', 'complete')=='complete' and devices and all(row.get('state')=='ok' and row.get('expected')==row.get('applied') for row in devices):
                return state
            await self.e.wait(1)
        raise RuntimeError('Configuration revision was not acknowledged by all executors')

    async def step(self, key, action):
        self.e.check_cancel()
        self.e.report['phase'] = next(c['title'] for c in self.e.report['checks'] if c['id']==key)
        self.e.result(key, 'running', 'Проверка выполняется')
        try:
            value = await action()
            self.e.check_cancel()
            self.e.result(key, value.get('status', 'passed'), value.get('summary', 'Проверено'), metrics=value)
        except Unavailable as error:
            self.e.result(key, 'unavailable', str(error))
            if self.e.child or self.e.emulator:
                raise
        except Cancelled:
            raise
        except (BudgetError, OSError):
            raise
        except Exception as error:
            self.e.result(key, 'failed', str(error))
            if self.e.monitor_error or self.e.child or self.e.emulator:
                raise

    async def run(self, capabilities):
        allowed = {c['id']: c for c in capabilities}
        selected = self.options.cases
        self.archive_before = []
        self.recording_streams = set()
        if 'recording' in selected:
            checkpoint = await self.target.rpc('recording', {'list_only': True})
            self.archive_before, self.archive_after_id = checkpoint['paths'], checkpoint['last_id']
            self.archive_initial_ids = [row['checkpoint_id'] for row in checkpoint['latest'] if not row['closed']]
            cameras = (await self.target.request('mc', 'GET', '/camera')).get('cameras', {})
            self.recording_streams = {(camera, key) for camera, body in cameras.items() for key, stream in body.get('streams', {}).items() if stream.get('status')==3 and 'record' in stream.get('purposes', [])}
        for key in selected:
            if not allowed[key]['available']:
                self.e.result(key, 'unavailable', allowed[key]['reason'])
        if 'services' in selected:
            await self.step('services', self.services)
        if 'neural' in selected and allowed['neural']['available']:
            await self.step('neural', self.neural)
        if 'cameras' in selected:
            await self.step('cameras', self.cameras)
        elif 'recording' in selected:
            await self.e.wait(self.options.minutes*60)
        if 'surround' in selected and allowed['surround']['available']:
            await self.step('surround', self.surround)
        for key in ('can', 'modbus', 'ws'):
            if key in selected:
                await self.step(key, lambda key=key: self.protocol(key))
        if 'e2e' in selected and allowed['e2e']['available']:
            await self.step('e2e', self.e2e)
        if 'faults' in selected:
            await self.step('faults', self.faults)
        if 'recording' in selected:
            await self.step('recording', self.recording)
        self.e.report['progress'] = 95

    async def services(self):
        status = await self.target.rpc('sample')
        if len(status['services'])!=7 or any(not row['running'] or row['health']=='unhealthy' for row in status['services'].values()):
            raise RuntimeError('One or more application services are not healthy')
        revisions = await self.applied()
        self.e.artifact('services.json', {'host': status, 'configuration': revisions})
        return {'summary': '7 сервисов доступны; ревизии согласованы', 'services': status['services'], 'configuration': revisions}

    async def streams(self):
        cameras = (await self.target.request('mc', 'GET', '/camera')).get('cameras', {})
        streams = [{'device': self.device, 'camera': camera, 'stream': key} for camera, body in cameras.items() for key, stream in body.get('streams', {}).items() if 'view' in stream.get('purposes', []) and stream.get('status')==3]
        surround = None
        try:
            state = await self.target.request('mc', 'GET', '/linker/status')
            if state.get('running') and state.get('stream_id'):
                surround = {'camera': state['stream_id'], 'device': self.device}
        except Exception:
            pass
        return streams, surround

    async def browser(self, seconds, name, surround_only=False):
        streams, surround = await self.streams()
        if surround_only:
            streams = [surround] if surround else []
        if not streams:
            raise Unavailable('Нет доступных потоков для просмотра')
        if not shutil.which('node') or not (shutil.which(os.environ.get('CHROME_BIN', 'chromium'))):
            raise Unavailable('Headless-браузер или Node.js не установлен')
        config = self.root/(name+'-config.json')
        config.write_text(json.dumps({'base': self.target.config.frontend, 'streams': streams, 'surround': surround, 'parallel': self.options.parallel, 'repeats': self.options.repeats}), encoding='utf-8')
        path = self.root/(name+'.jsonl')
        worker = Path(__file__).with_name('browser.cjs')
        process = await asyncio.create_subprocess_exec('node', str(worker), str(config), str(path), str(seconds), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, start_new_session=os.name!='nt')
        self.e.child = process
        started = time.monotonic()
        read_at = 0
        partial = ''
        try:
            while process.returncode is None:
                self.e.check_cancel()
                if path.exists() and path.stat().st_size>self.target.config.trace_mb*1024**2:
                    raise RuntimeError('Browser trace limit exceeded')
                elapsed = time.monotonic()-started
                self.e.report['progress'] = min(80, round(elapsed/max(1, seconds)*80, 1))
                if path.exists():
                    with path.open(encoding='utf-8') as stream:
                        stream.seek(read_at)
                        partial += stream.read()
                        read_at = stream.tell()
                    lines = partial.split('\n')
                    partial = lines.pop()
                    for line in lines:
                        row = json.loads(line)
                        if row.get('event')=='cycle':
                            current = next((c for c in self.e.report['checks'] if c['status']=='running'), None)
                            if current:
                                self.e.result(current['id'], 'running', f'Завершён цикл {row["cycle"]+1}; потоков {len(row["ids"])}; после закрытия {row.get("remaining", "?")}', metrics={'last_cycle': row['cycle']+1, 'parallel': len(row['ids']), 'remaining': row.get('remaining')})
                if elapsed>seconds+45:
                    raise RuntimeError('Browser test exceeded its deadline')
                await self.e.wait(.5)
            rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
            self.e.artifact(name+'.json', rows)
            cycles = [row for row in rows if row.get('event')=='cycle']
            ordinary = [row for row in cycles if not row['abrupt']]
            attempted = sum(len(row['ids']) for row in ordinary)
            rendered = sum(sum(any(item['id']==identity and item.get('width', 0)>0 and item.get('time', 0)>0 for batch in row['snapshots'] for item in batch) for identity in row['ids']) for row in ordinary)
            if process.returncode or not attempted or attempted!=rendered or any(row.get('remaining') for row in cycles):
                raise RuntimeError(f'WebRTC rendered {rendered}/{attempted}; browser exit {process.returncode}')
            return {'summary': f'Кадры получены в {rendered}/{attempted} сеансах; циклов {len(cycles)}', 'cycles': len(cycles), 'rendered': rendered, 'attempted': attempted}
        finally:
            if process.returncode is None:
                if process.stdin:
                    process.stdin.write(b'stop\n')
                    with __import__('contextlib').suppress(Exception):
                        await process.stdin.drain()
                try:
                    await asyncio.wait_for(process.wait(), 15)
                except asyncio.TimeoutError:
                    if os.name!='nt' and os.getpgid(process.pid)==process.pid:
                        os.killpg(process.pid, signal.SIGKILL)
                    else:
                        process.kill()
                    await process.wait()
            self.e.child = None

    async def cameras(self):
        start = time.monotonic()
        value = await self.browser(self.options.minutes*60, 'webrtc')
        await self.e.wait(max(0, self.options.minutes*60-(time.monotonic()-start)))
        streams, _ = await self.streams()
        unavailable = sorted(set(self.bodies.get('camera', {}))-{row['camera'] for row in streams})
        if unavailable:
            value.update(status='unavailable', unavailable_cameras=unavailable)
            value['summary'] += '; недоступные камеры: '+', '.join(unavailable)
        return value

    async def neural(self):
        original = copy.deepcopy(self.bodies.get('neural_slot', {}))
        if not original:
            raise Unavailable('В исходном профиле нет слотов')
        configurations = {}
        slots = copy.deepcopy(original)
        applied = []
        try:
            for key, slot in slots.items():
                stream = self.bodies.get('video_stream', {}).get(slot['stream_id'], {})
                source_id = slot.get('config_id') or stream.get('config_id')
                if source_id not in self.bodies.get('neural_config', {}):
                    raise Unavailable('Слот не содержит совместимую конфигурацию: '+key)
                config_id = 'test_config_'+self.e.active['id'][-8:]+'_'+str(len(configurations))
                body = copy.deepcopy(self.bodies['neural_config'][source_id])
                await self.source('neural_config', config_id, body)
                configurations[config_id] = body
                slot['config_id'] = config_id
            for cycle in range(self.options.slot_repeats):
                self.e.result('neural', 'running', f'Новые конфигурации и слоты: цикл {cycle+1}/{self.options.slot_repeats}')
                for key in original:
                    await self.source('neural_slot', key, None)
                await self.e.wait(3)
                for key, body in slots.items():
                    await self.source('neural_slot', key, body)
                expected = {(body['stream_id'], body['config_id']) for body in slots.values()}
                deadline = time.monotonic()+45
                while time.monotonic()<deadline:
                    value = await self.target.request('mc', 'GET', '/neural/status')
                    actual = value if isinstance(value, list) else value.get('slots', [])
                    live = {(row.get('stream_id'), row.get('config_id')) for row in actual if row.get('running') and row.get('fps', 0)>0}
                    if live==expected and len(actual)==len(expected):
                        break
                    await self.e.wait(2)
                else:
                    raise RuntimeError('New neural configurations were not applied with live inference on every slot')
                applied.append({'cycle': cycle+1, 'expected': sorted(expected), 'actual': actual})
                for key, body in original.items():
                    await self.source('neural_slot', key, body)
                await self.e.wait(3)
            return {'summary': f'Конфигураций {len(configurations)}, слотов {len(slots)}, повторов {self.options.slot_repeats}; инференс подтверждён', 'cycles': applied}
        finally:
            self.e.artifact('neural.json', applied)
            if not self.e.cancel.is_set() and not self.e.monitor_error:
                for key, body in original.items():
                    await self.source('neural_slot', key, body)
                for config_id in configurations:
                    await self.source('neural_config', config_id, None)

    async def surround(self):
        presets = self.bodies.get('preset', {})
        if not presets:
            raise Unavailable('В исходном профиле нет пресетов 360')
        results = []
        for key, original in presets.items():
            self.e.result('surround', 'running', 'Проверяется пресет '+key)
            before = await self.target.rpc('derived')
            changed = copy.deepcopy(original)
            changed['name'] = str(original.get('name', key))+' test'
            await self.source('preset', key, changed)
            after = await self.target.rpc('derived')
            await self.source('preset', key, original)
            if not before or before!=after:
                raise RuntimeError('360 rename changed or lost derived map files')
            results.append({'preset': key, 'files': len(before)})
        frames = await self.browser(24, 'surround', surround_only=True)
        self.e.artifact('surround.json', results)
        return {'summary': f'Пресетов {len(results)}; живой поток подтверждён', 'presets': results, 'frames': frames}

    async def select_integration(self, name, modules):
        original = self.bodies.get('integration', {}).get(name)
        if not original:
            raise Unavailable('В профиле нет интеграции '+name)
        effective = await self.target.request('api', 'GET', '/api/config/effective')
        previous = effective['entities'].get('machine', {}).get('settings', {}).get('body', {}).get('active_integration')
        body = copy.deepcopy(original)
        for key, module in body.get('modules', {}).items():
            module['enabled'] = key in modules
            if key in modules:
                module.update(modules[key])
        await self.source('integration', name, body)
        machine = copy.deepcopy(self.bodies.get('machine', {}).get('settings', {}))
        machine['active_integration'] = name
        start = round(time.time()*1000)
        await self.source('machine', 'settings', machine)
        await self.applied()
        if previous!=name:
            self.expected_pauses.append({'reason': 'Смена интеграции '+name, 'expected_pause': True, 'start_ms': start, 'end_ms': round(time.time()*1000)})
        await self.e.wait(3)

    async def inject(self, module, identifier):
        try:
            import grpc
            import frame_ingress_pb2 as pb
            import frame_ingress_pb2_grpc as rpc
        except ImportError as error:
            raise Unavailable('gRPC-модули не собраны в контейнере') from error
        state = await self.target.request('gateway', 'GET', '/runtime')
        request = pb.FrameRequest(ver=1, id=identifier, session=round(time.time()*1000), ts=round(time.time()*1000), event=pb.TRACK_EVENT_CONFIRMED if module!='modbus' else pb.TRACK_EVENT_REMOVED, runtime_id=state.get('transition_id', ''), camera_no=2, modules=[module], camera_id='test-service', width=1, height=1, format='png')
        request.dets.add(cid=0, cls='person', cf=.9, box=[0, 0, 1, 1], detection_id=identifier, type=1, danger=3)
        request.image = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=')
        request.record.code, request.record.frame_id, request.record.camera_mask, request.record.zone, request.record.count = 1, identifier, 1, 3, 1
        async with grpc.aio.insecure_channel(self.target.config.gateway_grpc) as channel:
            reply = await rpc.FrameIngressStub(channel).SendFrame(request, timeout=15)
        if not reply.accepted:
            raise RuntimeError('Gateway rejected the control message: '+reply.error)
        return {'accepted': reply.accepted, 'transport': reply.transport, 'wire_size': reply.wire_size}

    async def configure_transport(self, kind, endpoints, settings):
        if kind=='can':
            await self.select_integration('rsm-2000', {'can': {'enabled': True, 'mode': 'socketcan', 'iface': endpoints['can_gateway'], 'tx_period_ms': 100, 'tx_continuous': True, 'payload_ttl_enabled': False}})
        elif kind=='modbus':
            await self.select_integration('iskra', {'modbus': {'enabled': True, 'device': endpoints['modbus_gateway'], 'slave': settings.slave, 'baud': settings.baud}})
        else:
            await self.select_integration('rsm-2000', {'websocket': {'enabled': True, 'host': '127.0.0.1', 'port': str(settings.ws_port), 'target': '/ws/frames'}})

    async def control(self, kind, emulator):
        from oracle import control_matches
        identifier = int(time.time()*1000)&0xffffffff
        offset = self.trace.sequence
        reply = await self.inject(kind, identifier)
        deadline = time.monotonic()+30
        matched = []
        while time.monotonic()<deadline:
            self.e.check_cancel()
            with self.trace.lock:
                matched = [row for row in self.trace.rows if row['seq']>=offset and control_matches(kind, row, identifier)]
            acknowledged = kind!='modbus' or bool(matched and emulator.master.marked is not None and ((emulator.master.marked-matched[0]['value']['number']) & 0xffff)<0x8000)
            if matched and acknowledged:
                break
            await self.e.wait(.2)
        if not matched or not acknowledged:
            raise RuntimeError('Control message was not delivered and acknowledged by the external receiver')
        return {'reply': reply, 'matched': matched, 'snapshot': emulator.snapshot()}

    async def modbus_faults(self, emulator):
        finished = threading.Event()
        result = {}
        def job():
            try:
                master = emulator.master
                baseline = master.counters['violations']
                master.armed['crc'] = True
                silent = master.send(struct.pack('>BHH', 4, 0x1000, 6))
                if not silent or not silent.get('silent') or master.counters['violations']!=baseline:
                    raise RuntimeError('Bad CRC request was not ignored')
                master.armed['garbage'] = True
                valid = master.send(struct.pack('>BHH', 4, 0x1000, 6))
                if not valid or not valid.get('regs'):
                    raise RuntimeError('Slave did not recover after leading garbage')
                invalid = master.send(struct.pack('>BHH', 4, 0xffff, 2))
                if not invalid or invalid.get('exc') not in (2, 3):
                    raise RuntimeError('Invalid register range did not return a protocol exception')
                result.update(crc_ignored=True, garbage_recovered=True, range_exception=invalid['exc'])
            except Exception as error:
                result['error'] = str(error)
            finally:
                finished.set()
        emulator.master.jobs.put(job)
        deadline = time.monotonic()+10
        while not finished.is_set() and time.monotonic()<deadline:
            await self.e.wait(.1)
        if not finished.is_set() or result.get('error'):
            raise RuntimeError(result.get('error', 'Modbus fault requests timed out'))
        return result

    async def protocol(self, kind):
        settings = self.options.emulation.model_copy(update={'protocols': [kind], 'auto_ack': kind=='modbus'})
        emulator = Emulators(self.target, settings, self.trace, self.e.active['snapshot'].get('journal_max_id'))
        self.e.emulator = emulator
        evidence = {'scope': 'gateway-to-external-receiver; bypasses MC and detection', 'physical': kind!='ws' and (settings.can_line if kind=='can' else settings.modbus_line)=='physical', 'old_queue_ack_allowed': kind=='modbus'}
        self.e.event('Протокольная проверка '+kind, scope='gateway-to-receiver')
        try:
            try:
                endpoints = await emulator.start()
            except Exception as error:
                raise Unavailable('Линия недоступна: '+str(error)) from error
            for key in self.bodies.get('neural_slot', {}):
                await self.source('neural_slot', key, None)
            await self.configure_transport(kind, endpoints, settings)
            pause = round(time.time()*1000)
            await self.transition(self.profile)
            self.expected_pauses.append({'reason': 'Protocol fixture lifecycle reset', 'expected_pause': True, 'start_ms': pause, 'end_ms': round(time.time()*1000)})
            evidence['initial'] = await self.control(kind, emulator)
            if kind=='can':
                value = await self.target.request('gateway', 'GET', '/time')
                evidence['gateway_time'] = value
                if not value.get('gps', {}).get('valid') or abs(value['gps']['lat']-settings.lat)>0.0001 or abs(value['gps']['lon']-settings.lon)>0.0001:
                    raise RuntimeError('CAN GPS did not reach the gateway')
            if kind=='modbus':
                evidence['faults'] = await self.modbus_faults(emulator)
                snapshot = emulator.snapshot()
                if snapshot['modbus']['counters']['crc'] or snapshot['modbus']['counters']['violations']:
                    raise RuntimeError('Modbus response CRC or register validation failed')
                evidence['acknowledgements'] = {'counts': snapshot['counts'], 'old_entries': snapshot['old_ack_entries']}
            await emulator.stop()
            self.e.emulator = None
            self.e.result(kind, 'running', 'Проверка обрыва и повторного подключения')
            await self.e.wait(1)
            emulator = Emulators(self.target, settings, self.trace, self.e.active['snapshot'].get('journal_max_id'))
            self.e.emulator = emulator
            endpoints = await emulator.start()
            await self.configure_transport(kind, endpoints, settings)
            evidence['after_disconnect'] = await self.control(kind, emulator)
            return {'summary': 'Поля сообщений совпали; обрыв и восстановление проверены', 'scope': 'gateway-component', 'physical': evidence['physical'], 'acknowledgements': evidence.get('acknowledgements')}
        finally:
            evidence['last_state'] = emulator.snapshot()
            await emulator.stop()
            self.e.emulator = None
            self.e.artifact(kind+'-exchange.json', evidence)
            if not self.e.cancel.is_set() and not self.e.monitor_error:
                for key, body in self.bodies.get('neural_slot', {}).items():
                    await self.source('neural_slot', key, body)

    async def faults(self):
        results = []
        for service in self.options.restarts:
            self.e.check_cancel()
            self.e.report['phase'] = 'Перезапуск '+service
            self.e.result('faults', 'running', 'Проверяется остановка, запуск и восстановление '+service)
            before = await self.target.request('mc', 'GET', '/config')
            checkpoint_pause = await self.begin_pause('Restart '+service, service=='mc')
            start = round(time.time()*1000)
            if service=='mc':
                process = await self.target.rpc('discover')
                stopped = await self.target.rpc('stop', {'expected': process}, timeout=90)
                if stopped.get('forced'):
                    raise RuntimeError('MC required forced termination')
                await self.e.start_mc(self.target)
            else:
                if service=='storage-service':
                    self.e.expected_storage_outage_until = time.monotonic()+60
                await self.target.rpc('restart', {'service': service}, timeout=150)
            deadline = time.monotonic()+120
            while time.monotonic()<deadline:
                try:
                    await self.target.ready(timeout=5)
                    sample = await self.target.rpc('sample')
                    if all(row['running'] and row['health'] not in ('starting', 'unhealthy') for row in sample['services'].values()):
                        await self.applied(timeout=10)
                        break
                except Exception:
                    pass
                await self.e.wait(2)
            else:
                raise RuntimeError('Service did not recover: '+service)
            after = await self.target.request('mc', 'GET', '/config')
            await self.recording_ready()
            await self.end_pause(checkpoint_pause)
            self.e.expected_storage_outage_until = 0
            if before.get('revision')!=after.get('revision'):
                raise RuntimeError('MC configuration revision changed after restart: '+service)
            pause = {'reason': 'Перезапуск '+service, 'expected_pause': service=='mc', 'start_ms': start, 'end_ms': round(time.time()*1000)}
            self.expected_pauses.append(pause)
            self.e.event('Перезапуск и восстановление '+service, **pause)
            results.append({'service': service, 'revision': after.get('revision'), 'recovered': True})
        if 'cameras' in self.options.cases:
            results.append({'post_restart_webrtc': await self.browser(24, 'post-restart')})
        self.e.artifact('faults.json', results)
        return {'summary': f'Восстановлено после перезапуска: {len(self.options.restarts)}', 'results': results}

    async def recording(self):
        from oracle import classify_gaps
        end = round(time.time()*1000)
        checkpoint = await self.target.rpc('recording', {'list_only': True})
        window = {'since_ms': self.since, 'until_ms': end, 'after_id': self.archive_after_id, 'through_id': checkpoint['last_id'], 'initial_ids': self.archive_initial_ids}
        snapshot = self.e.active['snapshot']
        await self.target.transition(snapshot['profile'])
        raw = await self.target.rpc('recording', {**window, 'metadata_only': True})
        analyzer = load('rjd_recording', 'system', 'recording.py')
        rows = []
        for index in range(0, len(raw['rows']), 2):
            self.e.check_cancel()
            paths = [row['path'] for row in raw['rows'][index:index+2]]
            batch = await self.target.rpc('recording', {**window, 'only_paths': paths}, timeout=100)
            if set(paths)!={row['path'] for row in batch['rows']}:
                raise RuntimeError('An indexed segment disappeared during verification')
            for row in batch['rows']:
                packets = row.pop('packets', [])
                rows.append({**row, **analyzer.packet_span(packets)})
            self.e.result('recording', 'running', f'Проверено сегментов {len(rows)}/{len(raw["rows"])}', metrics={'probed': len(rows), 'total': len(raw['rows'])})
        gaps = []
        for camera in {row['camera_id'] for row in rows}:
            gaps.extend(analyzer.boundary_gaps([row for row in rows if row['camera_id']==camera], []))
        classify_gaps(gaps, rows, self.expected_pauses)
        invalid = [row for row in rows if not row.get('exists') or not row.get('closed') or not row.get('verified') or row.get('error')]
        holes = [row['file'] for row in rows if row.get('holes_ms')]
        unexpected = [g for g in gaps if not g['expected']]
        deleted = sorted(set(self.archive_before)-set(raw['all_paths']))
        sessions = {row['session_uid'] for row in rows}
        coverage = {session: {(row['camera_id'], row['stream_key']) for row in rows if row['session_uid']==session and row.get('verified')} for session in sessions}
        missing = {session: sorted(self.recording_streams-streams) for session, streams in coverage.items() if not self.recording_streams.issubset(streams)}
        expected_sessions = 1+sum(p['reason']=='Перезапуск mc' for p in self.expected_pauses)
        self.e.artifact('recordings.json', {'rows': rows, 'gaps': gaps, 'unindexed': raw['unindexed_files'], 'expected_pauses': self.expected_pauses, 'previous_archive_deleted': deleted, 'expected_streams': sorted(self.recording_streams), 'missing_coverage': missing})
        if not rows:
            raise Unavailable('За время проверки нет новых сегментов: включите запись в профиле')
        if invalid or holes or unexpected or raw['unindexed_files'] or deleted or missing or len(sessions)!=expected_sessions:
            raise RuntimeError(f'Recording: {len(invalid)} invalid/open files; {len(holes)} files with internal holes; {len(unexpected)} unexpected boundaries; {len(raw["unindexed_files"])} unindexed; {len(deleted)} previous archive files removed; missing coverage in {len(missing)} sessions; sessions {len(sessions)}/{expected_sessions}')
        return {'summary': f'Сегментов {len(rows)}; читаемость и индекс подтверждены; неожиданных разрывов нет', 'segments': len(rows), 'expected_gaps': len(gaps)-len(unexpected)}

    async def journal_after(self, identifier, camera_id, config_id, duration):
        from target import RequestError
        rows = []
        live_samples = []
        next_sample = time.monotonic()+3
        deadline = time.monotonic()+duration
        while time.monotonic()<deadline:
            head = await self.target.request('detection', 'GET', '/api/journal/head')
            if head['max_id']<identifier or head['max_id']-identifier>10000:
                raise RuntimeError('Journal checkpoint reset or observation capacity exceeded')
            for key in range(identifier+1, head['max_id']+1):
                try:
                    row = await self.target.request('detection', 'GET', '/api/journal/detections/'+str(key))
                except RequestError as error:
                    if error.status==404:
                        raise RuntimeError('A new journal record disappeared before observation') from error
                    raise
                if row['camera_id']==camera_id and row.get('config_id')==config_id:
                    rows.append({**row, 'observed_ms': round(time.time()*1000)})
            identifier = head['max_id']
            if time.monotonic()>=next_sample and time.monotonic()<deadline-10:
                value = await self.target.request('mc', 'GET', '/neural/status')
                slots = value if isinstance(value, list) else value.get('slots', [])
                live = [row for row in slots if row.get('config_id')==config_id and row.get('running') and row.get('fps', 0)>0]
                if not live:
                    raise RuntimeError('Reference inference is not running during playback')
                live_samples.append({'observed_ms': round(time.time()*1000), 'slots': live})
                next_sample = time.monotonic()+5
            self.e.check_cancel()
            await self.e.wait(.5)
        if not live_samples:
            raise RuntimeError('Reference duration did not allow live inference verification')
        return rows, live_samples

    async def e2e(self):
        from oracle import compare
        scenario = self.e.store.read(self.e.store.path('scenarios', self.options.scenario)/'scenario.json')
        if not scenario:
            raise Unavailable('Эталон не найден')
        camera_id = scenario['camera_id']
        source = self.bodies.get('camera', {}).get(camera_id)
        if not source:
            raise Unavailable('Камера эталона отсутствует в профиле')
        reference_streams = {key: body for key, body in self.bodies.get('video_stream', {}).items() if any(tile.get('camera')==camera_id for tile in body.get('tiles', []))}
        reference_slots = {key: body for key, body in self.bodies.get('neural_slot', {}).items() if body.get('stream_id') in reference_streams}
        if not reference_slots:
            raise Unavailable('Камера эталона не назначена ни одному слоту техзрения')
        requested = {row['channel'] for row in scenario['expectations']}
        if 'journal' not in requested or not requested.intersection({'can', 'modbus', 'ws'}):
            raise Unavailable('Для сквозного зачёта нужны ожидания журнала и хотя бы одного внешнего протокола')
        groups = []
        if requested.intersection({'can', 'ws'}):
            groups.append(('rsm-2000', sorted(requested.intersection({'can', 'ws'}))))
        if 'modbus' in requested:
            groups.append(('iskra', ['modbus']))
        results = []
        try:
            for key, body in reference_streams.items():
                isolated = copy.deepcopy(body)
                isolated['tiles'] = [tile for tile in isolated.get('tiles', []) if tile.get('camera')==camera_id]
                await self.source('video_stream', key, isolated)
            for key in self.bodies.get('neural_slot', {}):
                if key not in reference_slots:
                    await self.source('neural_slot', key, None)
            for integration, protocols in groups:
                settings = self.options.emulation.model_copy(update={'protocols': protocols, 'auto_ack': True})
                emulator = Emulators(self.target, settings, self.trace, self.e.active['snapshot'].get('journal_max_id'))
                self.e.emulator = emulator
                worker = None
                observation = None
                try:
                    try:
                        endpoints = await emulator.start()
                    except Exception as error:
                        raise Unavailable('Линия эталона недоступна: '+str(error)) from error
                    modules = {}
                    if 'can' in protocols:
                        modules['can'] = {'enabled': True, 'mode': 'socketcan', 'iface': endpoints['can_gateway'], 'tx_period_ms': 100, 'tx_continuous': True}
                    if 'ws' in protocols:
                        modules['websocket'] = {'enabled': True, 'host': '127.0.0.1', 'port': str(settings.ws_port), 'target': '/ws/frames'}
                    if 'modbus' in protocols:
                        modules['modbus'] = {'enabled': True, 'device': endpoints['modbus_gateway'], 'slave': settings.slave, 'baud': settings.baud}
                    await self.select_integration(integration, modules)
                    for key, body in reference_slots.items():
                        changed = {**body, 'config_id': scenario['config_id']}
                        await self.source('neural_slot', key, changed)
                    reference_pause = await self.begin_pause('Reference source replacement')
                    pause_start = reference_pause['start_ms']
                    changed = copy.deepcopy(source)
                    changed['camera'].update(ip_adress='127.0.0.1', port='8554', user='', password='', production=2)
                    for stream in changed['streams'].values():
                        stream.update(channel=1, substream=1, use_udp=False, reconnect_delay=1)
                    await self.source('camera', camera_id, changed)
                    await self.target.transition(self.profile)
                    self.expected_pauses.append({'reason': 'Reference lifecycle reset', 'expected_pause': True, 'start_ms': pause_start, 'end_ms': round(time.time()*1000)})
                    head = await self.target.request('detection', 'GET', '/api/journal/head')
                    offset = self.trace.sequence
                    worker = await asyncio.create_subprocess_exec('python', str(Path(__file__).with_name('rtsp.py')), str(self.e.store.path('scenarios', scenario['id'])/'video'), '--port', '8554', '--mount', '/ISAPI/Streaming/Channels/101', stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                    self.e.child = worker
                    line = await asyncio.wait_for(worker.stdout.readline(), 15)
                    if not line or not json.loads(line).get('ready'):
                        raise RuntimeError('Reference RTSP source did not start')
                    play = await asyncio.wait_for(worker.stdout.readline(), 30)
                    if not play:
                        raise RuntimeError('MC did not play the reference RTSP stream')
                    since = json.loads(play)['play_ms']
                    self.expected_pauses.append({'reason': 'Reference camera startup', 'camera': camera_id, 'expected_pause': True, 'start_ms': pause_start, 'end_ms': since+2000})
                    observation = asyncio.create_task(self.journal_after(head['max_id'], camera_id, scenario['config_id'], scenario['duration']+10))
                    await self.recording_ready()
                    await self.end_pause(reference_pause)
                    rows, inference = await observation
                    with self.trace.lock:
                        trace = [row for row in self.trace.rows if row['seq']>=offset]
                        if self.trace.rows and self.trace.rows[0]['seq']>offset:
                            raise RuntimeError('Trace capacity was exhausted before reference comparison')
                    expected = [item for item in scenario['expectations'] if item['channel']=='journal' or item['channel'] in protocols]
                    verdict = compare(expected, rows, trace, since, camera_id)
                    result = {'integration': integration, 'play_ms': since, 'journal': rows, 'inference': inference, 'timing': 'Tester observation time; journal poll interval 500 ms plus API latency', 'comparison': verdict, 'emulation': emulator.snapshot(), 'scenario': {key: scenario.get(key) for key in ('id', 'name', 'video_sha256', 'model_sha256', 'config_id', 'camera_id', 'duration')}, 'isolated_streams': sorted(reference_streams)}
                    results.append(result)
                    self.e.artifact('reference-'+integration+'.json', result)
                    if not verdict['passed']:
                        raise RuntimeError('Reference expectations do not match real journal and external receiver results')
                finally:
                    if observation and not observation.done():
                        observation.cancel()
                    if observation:
                        await asyncio.gather(observation, return_exceptions=True)
                    if not self.e.cancel.is_set() and not self.e.monitor_error:
                        start = round(time.time()*1000)
                        await self.source('camera', camera_id, source)
                        self.expected_pauses.append({'reason': 'Возврат живой камеры', 'camera': camera_id, 'expected_pause': True, 'start_ms': start, 'end_ms': round(time.time()*1000)})
                    if worker and worker.returncode is None:
                        worker.terminate()
                        await worker.wait()
                    self.e.child = None
                    await emulator.stop()
                    self.e.emulator = None
            return {'summary': f'Эталон прошёл через MC, журнал и внешние приёмники; повторов {len(results)}', 'scope': 'MC-to-journal-to-external-receiver', 'passes': len(results)}
        finally:
            if not self.e.cancel.is_set() and not self.e.monitor_error:
                for key, body in reference_streams.items():
                    await self.source('video_stream', key, body)
                for key, body in self.bodies.get('neural_slot', {}).items():
                    await self.source('neural_slot', key, body)
