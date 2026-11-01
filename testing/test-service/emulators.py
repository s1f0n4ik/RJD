import asyncio
import json
import socket
import struct
import threading
import time
from datetime import datetime, timezone

from reuse import load


class RemoteSerial:
    def __init__(self, target, settings):
        self.client, self.channel = target.channel('serial', {'line': settings.modbus_line, 'device': settings.serial, 'baud': settings.baud})
        try:
            ready = bytearray()
            while not ready.endswith(b'\n'):
                byte = self.channel.recv(1)
                if not byte:
                    raise RuntimeError('Serial bridge exited before readiness')
                ready.extend(byte)
                if len(ready)>4096:
                    raise RuntimeError('Invalid serial bridge greeting')
            self.device = json.loads(ready)['device']
            self.channel.settimeout(.02)
        except BaseException:
            self.close()
            raise

    def read(self, size):
        try:
            raw = self.channel.recv(size)
            if not raw:
                raise ConnectionError('Serial bridge closed')
            return raw
        except socket.timeout:
            return b''

    def write(self, value):
        self.channel.sendall(value)

    def flush(self):
        pass

    def reset_input_buffer(self):
        while self.channel.recv_ready():
            self.channel.recv(4096)

    def close(self):
        self.channel.close()
        self.client.close()


class Emulators:
    def __init__(self, target, settings, trace, old_max_id=None):
        self.target = target
        self.settings = settings
        self.trace = trace
        self.stop_event = threading.Event()
        self.threads = []
        self.channels = []
        self.serial = None
        self.master = None
        self.server = None
        self.counts = {'can_rx': 0, 'can_tx': 0, 'ws_messages': 0, 'ws_connections': 0, 'errors': 0}
        self.endpoints = {}
        self.error = None
        self.old_acks = []
        self.old_max_id = old_max_id if isinstance(old_max_id, int) and 0<=old_max_id<2**32 else None
        self.records = {}
        self.counts.update(acked_records=0, acked_existing=0)

    async def start(self):
        try:
            if 'modbus' in self.settings.protocols:
                self.serial = await asyncio.to_thread(RemoteSerial, self.target, self.settings)
                self.endpoints['modbus'] = self.serial.device
                self.endpoints['modbus_gateway'] = self.settings.gateway_serial if self.settings.modbus_line=='physical' else self.serial.device
                module = load('rjd_rtu', 'modbus', 'server.py')
                settings = {**module.DEFAULTS, 'device': self.serial.device, 'baud': self.settings.baud, 'slave': self.settings.slave, 'period_s': self.settings.period_ms/1000, 'timeout_ms': 500, 'mark': self.settings.auto_ack, 'lat': self.settings.lat, 'lon': self.settings.lon, 'running': True, 'open': True}
                self.master = module.Master(settings)
                self.master.port = self.serial
                offsets = {key: self.counts.get('modbus_'+key, 0) for key in ('requests', 'replies', 'timeouts', 'crc', 'violations')}
                add = self.master.add
                def recorded(kind, item):
                    result = add(kind, item)
                    if kind=='records':
                        self.records[item['number']] = dict(item)
                    for key, offset in offsets.items():
                        self.counts['modbus_'+key] = offset+self.master.counters[key]
                    self.trace.add('modbus-'+kind, result)
                    return result
                self.master.add = recorded
                write = self.master.write_multi
                def acknowledged(start, values, *args, **kwargs):
                    result = write(start, values, *args, **kwargs)
                    if result and start==0x1000 and len(values)==3 and values[0]==1:
                        consumed = [row for number, row in self.records.items() if (number-values[1]) & 0xffff <= (values[2]-values[1]) & 0xffff]
                        for row in consumed:
                            self.records.pop(row['number'], None)
                        old = [row for row in consumed if self.old_max_id is not None and row.get('frame', self.old_max_id+1)<=self.old_max_id]
                        self.counts['acked_records'] += len(consumed)
                        self.counts['acked_existing'] += len(old)
                        self.old_acks.extend({'number': row['number'], 'frame': row.get('frame')} for row in old)
                        self.old_acks = self.old_acks[-1000:]
                        self.trace.add('modbus-ack', {'first': values[1], 'last': values[2], 'records': len(consumed), 'existing_known': len(old), 'entries': [{'number': row['number'], 'frame': row.get('frame')} for row in consumed]})
                    return result
                self.master.write_multi = acknowledged
                self.thread(self.modbus_loop)
            if 'can' in self.settings.protocols:
                await asyncio.to_thread(self.open_can)
            if 'ws' in self.settings.protocols:
                from websockets.asyncio.server import serve
                self.server = await serve(self.websocket, '0.0.0.0', self.settings.ws_port, max_size=16*1024**2, max_queue=8)
                self.endpoints['ws'] = f'ws://{self.target.config.public_host}:{self.settings.ws_port}/ws/frames'
            return self.endpoints
        except BaseException:
            await self.stop()
            raise

    def thread(self, action):
        worker = threading.Thread(target=action, daemon=True)
        self.threads.append(worker)
        worker.start()

    def modbus_loop(self):
        try:
            while not self.stop_event.is_set():
                self.master.cycle()
                self.stop_event.wait(self.settings.period_ms/1000)
        except Exception as error:
            if not self.stop_event.is_set():
                self.error = str(error)
                self.counts['errors'] += 1
                self.trace.add('modbus-error', {'error': str(error)})

    def open_can(self):
        client, channel = self.target.channel('can', {'iface': self.settings.can_iface, 'line': self.settings.can_line})
        self.channels.append((client, channel))
        first = bytearray()
        while not first.endswith(b'\n'):
            byte = channel.recv(1)
            if not byte:
                error = channel.recv_stderr(4096).decode(errors='replace')
                raise RuntimeError('CAN line unavailable: '+error[-500:])
            first.extend(byte)
            if len(first)>4096:
                raise RuntimeError('Invalid CAN bridge greeting')
        self.endpoints['can'] = json.loads(first)['iface']
        self.endpoints['can_gateway'] = self.settings.gateway_can_iface if self.settings.can_line=='physical' else self.endpoints['can']
        channel.settimeout(.1)
        self.thread(lambda: self.can_loop(channel))

    def can_loop(self, channel):
        codec = load('rjd_can_codec', 'can', 'codec.py')
        buffer = bytearray()
        sent = 0
        try:
            while not self.stop_event.is_set():
                if time.monotonic()-sent>=self.settings.period_ms/1000:
                    for identifier, data in ((codec.GPS_ID, codec.encode_gps(self.settings.lat, self.settings.lon)), (codec.TIME_ID, codec.encode_time(datetime.now(timezone.utc), self.settings.speed_kmh/3.6))):
                        channel.sendall((json.dumps({'id': identifier, 'data': data.hex()})+'\n').encode())
                        self.counts['can_tx'] += 1
                    sent = time.monotonic()
                try:
                    chunk = channel.recv(4096)
                    if not chunk:
                        raise RuntimeError('CAN bridge closed')
                    buffer.extend(chunk)
                except socket.timeout:
                    continue
                while b'\n' in buffer:
                    line, _, buffer = buffer.partition(b'\n')
                    frame = json.loads(line)
                    self.counts['can_rx'] += 1
                    self.trace.add('can', frame)
        except Exception as error:
            if not self.stop_event.is_set():
                self.error = str(error)
                self.counts['errors'] += 1
                self.trace.add('can-error', {'error': str(error)})

    async def websocket(self, connection):
        if connection.request.path != '/ws/frames':
            await connection.close(1008, 'Unknown receiver path')
            return
        self.counts['ws_connections'] += 1
        started = time.monotonic()
        try:
            async for raw in connection:
                if self.settings.ws_mode=='slow':
                    await asyncio.sleep(2)
                if self.settings.ws_mode=='disconnect' and time.monotonic()-started>self.settings.fault_seconds:
                    await connection.close(1012, 'Configured test disconnection')
                    return
                if isinstance(raw, bytes):
                    if len(raw)<4:
                        raise ValueError('WS binary frame is shorter than its length prefix')
                    length = struct.unpack('>I', raw[:4])[0]
                    if not 0<length<=1024**2 or 4+length>len(raw):
                        raise ValueError('Invalid WS header length')
                    header = json.loads(raw[4:4+length])
                    self.trace.add('ws', {'header': header, 'image_bytes': len(raw)-4-length})
                else:
                    self.trace.add('ws-text', {'message': str(raw)[:4096]})
                self.counts['ws_messages'] += 1
        except Exception as error:
            self.counts['errors'] += 1
            self.trace.add('ws-error', {'error': str(error)})

    def snapshot(self, full=False):
        with self.trace.lock:
            trace = list(self.trace.rows[-300 if full else -100:])
        modbus = self.master.snapshot(0, -1) if self.master else None
        if modbus and not full:
            modbus['log'] = modbus['log'][-30:]
            modbus['records'] = modbus['records'][-20:]
        return {'endpoints': self.endpoints, 'counts': dict(self.counts), 'error': self.error, 'modbus': modbus, 'trace': trace, 'trace_total': self.trace.total, 'old_ack_entries': list(self.old_acks), 'old_ack_entries_truncated': self.counts['acked_existing']>1000, 'old_ack_journal_cutoff': self.old_max_id, 'old_ack_count_is_lower_bound': True}

    async def stop(self):
        self.stop_event.set()
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
        if self.serial:
            self.serial.close()
        if self.master:
            self.master.port = None
            self.master.online = False
        for client, channel in self.channels:
            if channel.closed:
                client.close()
                continue
            channel.shutdown_write()
            deadline = time.monotonic()+5
            while not channel.exit_status_ready() and time.monotonic()<deadline:
                await asyncio.sleep(.1)
            channel.close()
            client.close()
        for worker in self.threads:
            await asyncio.to_thread(worker.join, 5)
        if any(worker.is_alive() for worker in self.threads):
            raise RuntimeError('Emulator worker has not stopped')
