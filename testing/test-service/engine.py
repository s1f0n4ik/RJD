import asyncio
import copy
import io
import json
import time
import uuid
import zipfile
import hashlib
from datetime import datetime
from contextlib import suppress
from pathlib import Path
from urllib.parse import quote

from emulators import Emulators
from models import Emulation, RunOptions, Target as TargetConfig
from store import Trace, atomic, now
from target import Target, storage_budget


CATALOG = [
    {'id': 'services', 'title': 'Сервисы и конфигурация', 'expected': 'Сервисы доступны; применённые ревизии согласованы'},
    {'id': 'cameras', 'title': 'Камеры и потоки', 'expected': 'Каждый поток получает кадры; закрытые сессии освобождаются'},
    {'id': 'recording', 'title': 'Запись и архив', 'expected': 'Все сегменты читаются и индексируются; неожиданных разрывов нет'},
    {'id': 'neural', 'title': 'Техзрение', 'expected': 'Слоты и конфигурации применяются; каждый слот выдаёт кадры'},
    {'id': 'surround', 'title': 'Обзор 360', 'expected': 'Пресеты применяются; карты сохраняют связи; поток получает кадры'},
    {'id': 'can', 'title': 'CAN', 'expected': 'Время, GPS и контрольные кадры совпадают с заданными значениями'},
    {'id': 'modbus', 'title': 'Modbus RTU', 'expected': 'Регистры, CRC и подтверждения очереди соответствуют протоколу'},
    {'id': 'ws', 'title': 'WebSocket', 'expected': 'Внешний приёмник получает корректный заголовок и изображение'},
    {'id': 'e2e', 'title': 'Сквозной сценарий', 'expected': 'Ожидания эталонного видео совпадают с журналом и внешними сообщениями'},
    {'id': 'faults', 'title': 'Сбои и восстановление', 'expected': 'После каждого перезапуска восстанавливаются связь и конфигурация'},
]


class BusyError(Exception):
    pass


class Cancelled(Exception):
    pass


class Unavailable(Exception):
    pass


class Engine:
    def __init__(self, store, target_factory=Target):
        self.store = store
        self.target_factory = target_factory
        self.lock = asyncio.Lock()
        self.active = store.read(store.root/'private'/'active.json')
        self.task = None
        self.cancel = asyncio.Event()
        self.emulator = None
        self.status = {}
        self.report = None
        self.guard_task = None
        self.child = None
        self.monitor_error = None
        self.process_lock = None
        self.expected_storage_outage_until = 0
        self.last_sample = None
        self.worker_entered = False

    def config(self):
        return TargetConfig.model_validate(self.store.read(self.store.root/'private'/'target.json', {}))

    def target(self):
        return self.target_factory(self.config(), self.store.root)

    def persist(self):
        atomic(self.store.root/'private'/'active.json', self.active)

    async def startup(self):
        if __import__('os').name != 'nt':
            import fcntl
            self.process_lock = (self.store.root/'private'/'process.lock').open('a')
            fcntl.flock(self.process_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if self.active:
            self.report = self.store.read(self.store.path('runs', self.active['id'])/'report.json')
            self.report['state'] = 'interrupted'
            self.report['outcome'] = 'interrupted'
            self.report['phase'] = 'Восстановление после перезапуска контейнера'
            self.store.report(self.report)
            self.task = asyncio.create_task(self.recover())

    async def shutdown(self):
        self.cancel.set()
        if self.task and not self.task.done():
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.shield(self.task), 270)
        if self.process_lock:
            self.process_lock.close()

    async def preflight(self, options):
        target = self.target()
        results = {}
        async def get(name, service, path):
            try:
                results[name] = {'available': True, 'value': await target.request(service, 'GET', path, timeout=10)}
            except Exception as error:
                results[name] = {'available': False, 'error': str(error)}
        await asyncio.gather(get('profile', 'api', '/api/config/effective'), get('configuration', 'api', '/api/config/status'), get('mc', 'mc', '/system/info'), get('storage', 'storage', '/api/storage/pool'), get('gateway', 'gateway', '/status'), get('detection', 'detection', '/health'))
        try:
            results['host'] = {'available': True, 'value': await target.rpc('sample')}
        except Exception as error:
            results['host'] = {'available': False, 'error': str(error)}
        try:
            results['hardware'] = {'available': True, 'value': await target.rpc('capabilities', {'serial': [options.emulation.serial, options.emulation.gateway_serial]})}
        except Exception as error:
            results['hardware'] = {'available': False, 'error': str(error)}
        try:
            self.store.budget(target.config.data_reserve_mb)
            results['budget'] = {'available': True, 'value': storage_budget(results.get('storage', {}).get('value', {}), target.config.reserve_gib*1024**3)}
        except Exception as error:
            results['budget'] = {'available': False, 'error': str(error)}
        profile = results.get('profile', {}).get('value', {})
        bindings = profile.get('entities', {}).get('binding', {})
        device = results.get('mc', {}).get('value', {}).get('device_id')
        if not device:
            devices = {e['body'].get('device_id') for e in bindings.values()}
            device = next(iter(devices)) if len(devices)==1 else None
        local = bool(device and bindings and all(e['body'].get('device_id')==device for e in bindings.values()))
        results['bindings'] = {'available': local, 'error': '' if local else 'Profile bindings must refer to the selected local MC only'}
        ready = bool(local and profile.get('profile') and all(results.get(k, {}).get('available') for k in ('profile', 'configuration', 'host', 'budget', 'gateway', 'detection')))
        if results.get('mc', {}).get('available') and not results.get('host', {}).get('value', {}).get('mc', {}).get('running'):
            ready = False
            results['ownership'] = {'available': False, 'error': 'MC API responds, but the configured executable has no matching process; check the binary path'}
        services = results.get('host', {}).get('value', {}).get('services', {})
        ready &= results.get('host', {}).get('value', {}).get('binary_exists', False)
        ready &= len(services)==7 and all(v.get('running') and v.get('health') not in ('starting', 'unhealthy') for v in services.values())
        results['services'] = {'available': len(services)==7 and all(v.get('running') and v.get('health') not in ('starting', 'unhealthy') for v in services.values()), 'value': services, 'error': 'All seven application services must be running and ready'}
        transition = results.get('configuration', {}).get('value', {}).get('transition') or {}
        ready &= not transition or transition.get('phase')=='complete'
        capabilities = []
        scenario = self.store.read(self.store.path('scenarios', options.scenario)/'scenario.json') if options.scenario else None
        for row in CATALOG:
            reason = ''
            entities = profile.get('entities', {})
            if row['id']=='neural' and not entities.get('neural_slot'):
                reason = 'В профиле нет слотов техзрения'
            if row['id']=='surround' and not entities.get('preset'):
                reason = 'В профиле нет пресетов 360'
            if row['id']=='e2e':
                if not scenario or not (self.store.path('scenarios', scenario['id'])/'video').is_file():
                    reason = 'Нет выбранного видео с ожиданиями'
                elif scenario['config_id'] not in entities.get('neural_config', {}) or scenario['model_sha256'] not in entities['neural_config'][scenario['config_id']]['body'].get('_assets', {}).values():
                    reason = 'Модель или конфигурация эталона несовместима с профилем'
                else:
                    channels = {item['channel'] for item in scenario['expectations']}
                    if 'journal' not in channels or not channels.intersection({'can', 'modbus', 'ws'}):
                        reason = 'Нужны ожидания журнала и хотя бы одного внешнего протокола'
                    camera = entities.get('camera', {}).get(scenario['camera_id'], {}).get('body', {})
                    if not any('neural' in stream.get('purposes', []) for stream in camera.get('streams', {}).values()):
                        reason = 'Камера эталона должна иметь поток техзрения'
                    for channel in channels.intersection({'can', 'modbus'}):
                        capability = next((item for item in capabilities if item['id']==channel), None)
                        if capability and not capability['available']:
                            reason = capability['reason']
            hardware = results.get('hardware', {}).get('value', {})
            if row['id']=='can':
                if options.emulation.can_line=='software' and not hardware.get('software_can'):
                    reason = 'Для vcan недоступны модуль ядра или права NET_ADMIN на хосте'
                elif options.emulation.can_line=='physical':
                    interfaces = hardware.get('can_interfaces', {})
                    pair = (options.emulation.can_iface, options.emulation.gateway_can_iface)
                    if pair[0]==pair[1] or any(not interfaces.get(name, {}).get('up') or interfaces[name].get('virtual') for name in pair):
                        reason = 'Нужны два разных поднятых физических CAN-интерфейса'
            if row['id']=='modbus' and options.emulation.modbus_line=='physical':
                serial = hardware.get('serial', {})
                pair = [serial.get(name, {}) for name in (options.emulation.serial, options.emulation.gateway_serial)]
                if any(not item.get('exists') or not item.get('writable') for item in pair) or pair[0].get('resolved')==pair[1].get('resolved'):
                    reason = 'Нужны два разных доступных физических последовательных порта'
            capabilities.append({**row, 'available': not reason, 'reason': reason})
        return {'ready': bool(ready), 'local_device': device, 'local_bindings': local, 'checks': results, 'cases': capabilities}

    async def start(self, kind, options):
        async with self.lock:
            if self.active:
                raise BusyError('A test, emulation or recovery session is already active')
            if kind=='tests' and (not options.cases or len(set(options.cases))!=len(options.cases) or any(c not in {x['id'] for x in CATALOG} for c in options.cases)):
                raise ValueError('Invalid or duplicate case selection')
            config = self.config()
            self.store.budget(config.data_reserve_mb)
            run_id = 'run-'+time.strftime('%Y%m%d-%H%M%S', time.gmtime())+'-'+uuid.uuid4().hex[:8]
            self.store.path('runs', run_id).mkdir()
            selected = options.cases if kind=='tests' else []
            self.report = {'schema_version': 2, 'id': run_id, 'kind': kind, 'target': config.name, 'started_at': now(), 'state': 'running', 'phase': 'Подготовка', 'progress': 0, 'options': options.model_dump(), 'checks': [{**row, 'status': 'queued', 'actual': ''} for row in CATALOG if row['id'] in selected], 'samples': [], 'events': [], 'artifacts': [], 'cleanup': {}}
            self.store.report(self.report)
            self.active = {'id': run_id, 'kind': kind, 'config': config.model_dump(), 'snapshot': None, 'phase': 'preparing'}
            self.persist()
            self.cancel = asyncio.Event()
            self.monitor_error = None
            self.expected_storage_outage_until = 0
            self.last_sample = None
            self.worker_entered = False
            self.task = asyncio.create_task(self.execute(options) if kind=='tests' else self.emulate(options))
            return {'id': run_id}

    async def stop(self):
        async with self.lock:
            if not self.active:
                raise ValueError('No active session')
            self.cancel.set()
            if self.worker_entered and self.active.get('phase') not in ('recovering', 'recovery_failed') and self.task and not self.task.done():
                self.task.cancel()
            return {'state': 'stopping', 'id': self.active['id']}

    async def retry(self):
        async with self.lock:
            if not self.active or self.active.get('phase')!='recovery_failed' or self.task and not self.task.done():
                raise BusyError('Recovery is not awaiting a retry')
            self.cancel = asyncio.Event()
            self.task = asyncio.create_task(self.recover())

    def check_cancel(self):
        if self.monitor_error:
            raise RuntimeError(self.monitor_error)
        if self.cancel.is_set():
            raise Cancelled('Cancelled by operator')

    async def wait(self, seconds):
        deadline = time.monotonic()+seconds
        while time.monotonic()<deadline:
            self.check_cancel()
            await asyncio.sleep(min(.5, max(0, deadline-time.monotonic())))

    def event(self, text, **values):
        self.report['events'].append({'at': now(), 'text': text, **values})
        self.store.report(self.report)

    def result(self, key, state, actual, **values):
        row = next(item for item in self.report['checks'] if item['id']==key)
        row.update(status=state, actual=actual, **values)
        self.store.report(self.report)

    def artifact(self, name, value):
        self.store.budget(self.config().data_reserve_mb)
        item = self.store.artifact(self.active['id'], name, value)
        self.report['artifacts'] = [v for v in self.report['artifacts'] if v['name']!=name]+[item]
        self.store.report(self.report)

    async def monitor(self, target):
        since = round(datetime.fromisoformat(self.report['started_at']).timestamp()*1000)
        while True:
            try:
                sample = await target.rpc('sample', {'since_ms': since})
                try:
                    snapshot = await target.request('storage', 'GET', '/api/storage/pool', timeout=10)
                except Exception:
                    if time.monotonic()>=self.expected_storage_outage_until:
                        raise
                    sample['storage_unavailable_during_restart'] = True
                else:
                    sample['cleaner'] = storage_budget(snapshot, 2*1024**3)
                self.store.budget(target.config.data_reserve_mb)
                if sample.get('available_mb', 0)<256 or max(sample.get('temperatures') or [0])>95:
                    raise RuntimeError('Host memory or temperature safety limit exceeded')
                self.status = sample
                previous = self.last_sample
                if previous and previous.get('mc', {}).get('pid')==sample.get('mc', {}).get('pid') and sample.get('wall_ms', 0)>previous.get('wall_ms', 0):
                    sample['cpu_percent'] = round((sample.get('cpu_ticks', 0)-previous.get('cpu_ticks', 0))/sample.get('clock_ticks', 100)/((sample['wall_ms']-previous['wall_ms'])/1000)*100, 1)
                self.last_sample = sample
                sample['at'] = now()
                self.report['samples'].append({**sample, 'at': now()})
                self.report['samples'] = self.report['samples'][-6000:]
                self.store.report(self.report)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.monitor_error = str(error)
                self.event('Safety monitor stopped the test', error=str(error))
                if self.task and not self.task.done():
                    self.task.cancel()
                return
            await asyncio.sleep(5)

    async def snapshot(self, target, preflight):
        original = preflight['checks']['profile']['value']
        process = await target.rpc('discover')
        head = await target.request('detection', 'GET', '/api/journal/head')
        self.active['snapshot'] = {'profile': original['profile']['id'], 'process': process, 'effective': original, 'device': preflight['local_device'], 'temporary': 'test-'+self.active['id'], 'journal_max_id': head.get('max_id', 0), 'services': preflight['checks']['host']['value']['services']}
        self.persist()
        self.active['phase'] = 'prepared'
        self.persist()
        if not process['running']:
            await self.start_mc(target)
        await target.ready()

    async def start_mc(self, target):
        saved = copy.deepcopy(self.active['snapshot']['process'])
        saved['env']['RJD_TEST_RUN'] = self.active['id']
        result = await target.rpc('start', {'saved': saved})
        self.active['started_process'] = result
        self.persist()
        return result

    async def clone(self, target):
        snapshot = self.active['snapshot']
        bodies = {kind: {key: copy.deepcopy(entry['body']) for key, entry in rows.items()} for kind, rows in snapshot['effective']['entities'].items()}
        document = {'format': 1, 'profile': {'id': snapshot['temporary'], 'name': 'Испытания '+self.active['id']}, 'version': {'number': 1}, 'entities': [{'kind': kind, 'key': key, 'body': body} for kind, rows in bodies.items() if kind!='binding' for key, body in rows.items()], 'assets': {}}
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
            output.writestr('profile.json', json.dumps(document, ensure_ascii=False))
        self.active['clone_intent'] = True
        self.persist()
        await target.request('api', 'POST', '/api/config/load', files={'file': ('test.varan', archive.getvalue(), 'application/octet-stream')})
        self.active['clone_created'] = True
        self.persist()
        for key, body in bodies.get('binding', {}).items():
            await target.source(snapshot['temporary'], 'binding', key, body)
        self.active['profile_touched'] = True
        self.persist()
        await target.transition(snapshot['temporary'])
        return bodies

    async def execute(self, options):
        from cases import Cases
        target = self.target()
        final = 'completed'
        try:
            self.worker_entered = True
            self.check_cancel()
            preflight = await self.preflight(options)
            self.artifact('preflight.json', preflight)
            if not preflight['ready']:
                raise RuntimeError('Preflight failed: check API, SSH, local bindings, services and logical storage budget')
            await self.snapshot(target, preflight)
            self.guard_task = asyncio.create_task(self.monitor(target))
            bodies = await self.clone(target)
            suite = Cases(self, target, options, bodies)
            await suite.run(preflight['cases'])
            if any(c['status']=='failed' for c in self.report['checks']):
                final = 'failed'
            elif any(c['status']=='unavailable' for c in self.report['checks']):
                final = 'incomplete'
        except Cancelled:
            final = 'cancelled'
            self.event('Cancelled by operator')
        except asyncio.CancelledError:
            final = 'failed' if self.monitor_error else 'cancelled' if self.cancel.is_set() else 'interrupted'
            self.event('Test interrupted', error=self.monitor_error or 'Worker interrupted')
        except Exception as error:
            final = 'failed'
            self.event('Test failed', error=str(error))
            for check in self.report['checks']:
                if check['status']=='running':
                    check.update(status='failed', actual=str(error))
        finally:
            self.report['outcome'] = final
            for check in self.report['checks']:
                if check['status']=='queued':
                    check.update(status='unavailable', actual='Не выполнено: прогон завершён до начала проверки')
            await self.recover()

    async def emulate(self, options):
        target = self.target()
        trace = Trace(self.store.path('runs', self.active['id']), target.config.trace_mb)
        try:
            self.worker_entered = True
            self.check_cancel()
            pool = await target.request('storage', 'GET', '/api/storage/pool')
            storage_budget(pool, target.config.reserve_gib*1024**3)
            self.guard_task = asyncio.create_task(self.monitor(target))
            self.emulator = Emulators(target, options, trace)
            await self.emulator.start()
            self.active['phase'] = 'emulation'
            self.persist()
            self.report['phase'] = 'Эмуляция'
            while not self.cancel.is_set():
                self.store.budget(target.config.data_reserve_mb)
                if self.emulator.error:
                    self.report['phase'] = 'Переподключение эмуляторов'
                    self.event('Emulator connection lost', error=self.emulator.error)
                    counters = dict(self.emulator.counts)
                    old_acks = list(self.emulator.old_acks)
                    await self.emulator.stop()
                    with suppress(asyncio.TimeoutError):
                        await asyncio.wait_for(self.cancel.wait(), 5)
                    if self.cancel.is_set():
                        break
                    self.emulator = Emulators(target, options, trace)
                    self.emulator.counts.update(counters)
                    self.emulator.old_acks = old_acks
                    try:
                        await self.emulator.start()
                        self.report['phase'] = 'Эмуляция'
                        self.event('Emulators reconnected', endpoints=self.emulator.endpoints)
                    except Exception as error:
                        self.emulator.error = str(error)
                        self.emulator.counts['errors'] += 1
                self.report['emulation'] = self.emulator.snapshot()
                self.store.report(self.report)
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            self.report['outcome'] = 'failed' if self.monitor_error else 'completed' if self.cancel.is_set() else 'interrupted'
            self.event('Emulation interrupted', error=self.monitor_error or 'Worker interrupted')
        except Cancelled:
            self.report['outcome'] = 'completed'
        except Exception as error:
            self.report['outcome'] = 'failed'
            self.event('Emulation failed', error=str(error))
        finally:
            await self.recover()

    async def recover(self):
        errors = []
        self.active['phase'] = 'recovering'
        self.report['state'] = 'recovering'
        self.report['phase'] = 'Восстановление исходных настроек и MC'
        try:
            self.persist()
            self.store.report(self.report)
        except OSError as error:
            errors.append('Recovery persistence: '+str(error))
        if self.guard_task:
            self.guard_task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await self.guard_task
            self.guard_task = None
        if self.child:
            try:
                self.child.terminate()
                await asyncio.wait_for(self.child.wait(), 10)
            except Exception as error:
                errors.append('Child process: '+str(error))
                with suppress(ProcessLookupError):
                    self.child.kill()
            self.child = None
        if self.emulator:
            try:
                self.report['emulation'] = self.emulator.snapshot()
                await self.emulator.stop()
                self.emulator = None
            except Exception as error:
                errors.append('Emulators: '+str(error))
        if not errors:
            for name in ('trace.jsonl', 'trace-previous.jsonl'):
                path = self.store.path('runs', self.active['id'])/name
                if path.is_file():
                    with path.open('rb') as source:
                        digest = hashlib.file_digest(source, 'sha256').hexdigest()
                    self.report['artifacts'] = [item for item in self.report['artifacts'] if item['name']!=name]+[{'name': name, 'sha256': digest, 'bytes': path.stat().st_size}]
        snapshot = self.active.get('snapshot')
        if snapshot:
            target = self.target_factory(TargetConfig.model_validate(self.active['config']), self.store.root)
            try:
                services = snapshot.get('services', {})
                if services:
                    current_services = (await target.rpc('sample'))['services']
                    for name, initial in services.items():
                        if initial['running'] and not current_services.get(name, {}).get('running'):
                            await target.rpc('restart', {'service': name}, timeout=150)
                    deadline = time.monotonic()+120
                    while time.monotonic()<deadline:
                        current_services = (await target.rpc('sample'))['services']
                        if all(current_services.get(name, {}).get('running') and current_services[name].get('health') not in ('starting', 'unhealthy') for name, initial in services.items() if initial['running']):
                            break
                        await asyncio.sleep(1)
                    else:
                        raise RuntimeError('Application services did not return to their initial running state')
                current = await target.rpc('discover')
                needs_mc = self.active.get('profile_touched') or snapshot['process']['running']
                if needs_mc:
                    try:
                        pool = await target.request('storage', 'GET', '/api/storage/pool')
                        storage_budget(pool, 2*1024**3)
                    except Exception as error:
                        if current['running']:
                            await target.rpc('stop', {'expected': current}, timeout=90)
                        raise RuntimeError('MC remains stopped: safe archive budget could not be confirmed: '+str(error)) from error
                if needs_mc and not current['running']:
                    await self.start_mc(target)
                if needs_mc:
                    await target.ready()
                if self.active.get('profile_touched'):
                    effective = await target.request('api', 'GET', '/api/config/effective')
                    configuration = await target.request('api', 'GET', '/api/config/status')
                    if effective['profile']['id']!=snapshot['profile'] or (configuration.get('transition') or {}).get('phase') not in (None, 'complete'):
                        await target.transition(snapshot['profile'])
                        effective = await target.request('api', 'GET', '/api/config/effective')
                    if effective['profile']['id']!=snapshot['profile']:
                        raise RuntimeError('Original profile was not restored')
                if not snapshot['process']['running']:
                    current = await target.rpc('discover')
                    if current['running'] and current.get('owner')!=self.active['id']:
                        raise RuntimeError('Current MC has no matching session ownership marker')
                    if current['running']:
                        stopped = await target.rpc('stop', {'expected': current}, timeout=90)
                        if not stopped['stopped']:
                            raise RuntimeError('Original stopped MC state was not restored')
                if self.active.get('clone_created'):
                    await target.request('api', 'DELETE', '/api/config/profiles/'+quote(snapshot['temporary'], safe=''))
                elif self.active.get('clone_intent'):
                    profiles = await target.request('api', 'GET', '/api/config/profiles')
                    if any(row['id']==snapshot['temporary'] for row in profiles.get('profiles', [])):
                        await target.request('api', 'DELETE', '/api/config/profiles/'+quote(snapshot['temporary'], safe=''))
                self.report['cleanup'] = {'restored': True, 'profile': snapshot['profile'], 'mc_running': snapshot['process']['running'], 'data_rollback': False}
            except Exception as error:
                errors.append(str(error))
        if errors:
            self.active['phase'] = 'recovery_failed'
            self.report.update(state='recovery_failed', phase='Ошибка восстановления')
            self.report['cleanup'] = {'restored': False, 'errors': errors}
            with suppress(OSError):
                self.persist()
                self.store.report(self.report)
            return
        self.report.update(state=self.report.get('outcome', 'completed'), phase='Завершено', finished_at=now(), progress=100)
        if not snapshot:
            self.report['cleanup'] = {'restored': True, 'settings_changed': False}
        self.store.report(self.report)
        async with self.lock:
            self.active = None
            self.persist()
