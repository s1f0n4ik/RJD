import concurrent.futures
import hashlib
import json
import os
import select
import shlex
import signal
import socket
import sqlite3
import subprocess
import sys
import termios
import time
import tty
from pathlib import Path


SERVICES = ('frontend', 'fastapi', 'detection-service', 'message-gateway', 'storage-service', 'signaling-server', 'camera-scanner')


def identity(pid):
    try:
        base = Path('/proc') / str(pid)
        return {'pid': pid, 'exe': str((base/'exe').resolve(strict=True)), 'started': (base/'stat').read_text().split(') ', 1)[1].split()[19], 'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    except (OSError, IndexError):
        return None


def discover(config):
    matches = [value for proc in Path('/proc').iterdir() if proc.name.isdigit() and (value := identity(int(proc.name))) and value['exe'] == config['binary']]
    if len(matches) > 1:
        raise RuntimeError('Multiple matching MC processes; ownership is ambiguous')
    if not matches:
        return {'running': False, 'argv': [config['binary'], *config['argv']], 'cwd': config['cwd'], 'env': config['env']}
    value = matches[0]
    proc = Path('/proc')/str(value['pid'])
    env = dict(item.split('=', 1) for item in (proc/'environ').read_bytes().decode().strip('\0').split('\0') if '=' in item)
    value.update(running=True, owner=env.get('RJD_TEST_RUN'), argv=(proc/'cmdline').read_bytes().decode().strip('\0').split('\0'), cwd=str((proc/'cwd').resolve()), env={k:v for k,v in env.items() if k in ('DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'LD_LIBRARY_PATH', 'GST_PLUGIN_PATH', 'GST_PLUGIN_SYSTEM_PATH', 'PATH')})
    value['argv'][0] = value['exe']
    return value


def stop(config, expected):
    current = discover(config)
    if not current['running']:
        return {'stopped': True, 'forced': False}
    if not expected or any(current.get(k) != expected.get(k) for k in ('pid', 'exe', 'started', 'boot')):
        raise RuntimeError('MC identity changed; refusing to signal an unowned process')
    token = identity(current['pid'])
    for sig, seconds in ((signal.SIGINT, 60), (signal.SIGTERM, 10)):
        if identity(current['pid']) != token:
            return {'stopped': True, 'forced': sig != signal.SIGINT}
        os.kill(current['pid'], sig)
        deadline = time.monotonic()+seconds
        while identity(current['pid']) == token and time.monotonic() < deadline:
            time.sleep(.2)
        if identity(current['pid']) != token:
            return {'stopped': True, 'forced': sig != signal.SIGINT}
    raise RuntimeError('MC did not stop; forced kill was not issued')


def start(config, saved):
    current = discover(config)
    if current['running']:
        return current
    argv = saved['argv']
    if not argv or argv[0] != config['binary']:
        raise RuntimeError('Saved executable does not match configured MC')
    command = ['bash', '-c', 'source '+shlex.quote(config['gst_env'])+' && exec "$@"', 'rjd-testing', *argv]
    child = subprocess.Popen(command, cwd=saved['cwd'], env={**os.environ, **saved['env']}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(100):
        result = identity(child.pid)
        if result and result['exe'] == config['binary']:
            return discover(config)
        if child.poll() is not None:
            raise RuntimeError('MC exited during startup')
        time.sleep(.1)
    raise RuntimeError('MC startup identity was not confirmed')


def containers():
    result = subprocess.run(['docker', 'inspect', *SERVICES], capture_output=True, timeout=20)
    if result.returncode:
        raise RuntimeError('Cannot inspect application containers')
    return {row['Name'].lstrip('/'): {'running': row['State']['Running'], 'health': row['State'].get('Health', {}).get('Status', 'unknown'), 'image': row['Image'], 'started_at': row['State']['StartedAt']} for row in json.loads(result.stdout)}


def capabilities(payload):
    interfaces = json.loads(subprocess.check_output(['ip', '-details', '-json', 'link', 'show'], timeout=10))
    can_interfaces = {row['ifname']: {'virtual': row.get('linkinfo', {}).get('info_kind')=='vcan', 'up': 'UP' in row.get('flags', [])} for row in interfaces if row.get('link_type')=='can'}
    status = Path('/proc/self/status').read_text()
    effective = int(next(line.split()[1] for line in status.splitlines() if line.startswith('CapEff:')), 16)
    serial = {name: {'exists': Path(name).is_char_device(), 'writable': os.access(name, os.R_OK|os.W_OK), 'resolved': str(Path(name).resolve())} for name in payload.get('serial', [])}
    vcan = subprocess.run(['modprobe', '-n', 'vcan'], capture_output=True, timeout=10).returncode==0
    return {'can_interfaces': can_interfaces, 'software_can': bool(effective & (1<<12)) and vcan, 'serial': serial}


def metrics(config, payload=None):
    current = discover(config)
    result = {'mc': current, 'binary_exists': os.access(config['binary'], os.X_OK), 'wall_ms': round(time.time()*1000), 'load': os.getloadavg(), 'services': containers()}
    mem = dict((line.split(':')[0], int(line.split()[1])) for line in Path('/proc/meminfo').read_text().splitlines())
    result['available_mb'] = mem['MemAvailable']/1024
    result['temperatures'] = [int(p.read_text())/1000 for p in Path('/sys/class/thermal').glob('thermal_zone*/temp')]
    if current['running']:
        proc = Path('/proc')/str(current['pid'])
        status = dict(line.split(':', 1) for line in (proc/'status').read_text().splitlines())
        result.update(rss_mb=int(status.get('VmRSS', '0 kB').split()[0])/1024, fd=len(list((proc/'fd').iterdir())), threads=int(status['Threads']))
        ticks = (proc/'stat').read_text().split(') ', 1)[1].split()
        result.update(cpu_ticks=int(ticks[11])+int(ticks[12]), clock_ticks=os.sysconf('SC_CLK_TCK'), dma_buf=sum('dmabuf' in str(p.resolve()) for p in (proc/'fd').iterdir()))
    for name in ('/sys/kernel/debug/rknpu/load', '/sys/kernel/debug/rknpu/load/0'):
        try:
            result['npu_load'] = Path(name).read_text().strip()
            break
        except OSError:
            pass
    try:
        conn = sqlite3.connect('file:'+str(Path(config['archive'])/'segments.db')+'?mode=ro', uri=True)
        count, opened = conn.execute('SELECT COUNT(*),COALESCE(SUM(closed=0),0) FROM segments WHERE wall_start_ms>=?', ((payload or {}).get('since_ms', 0),)).fetchone()
        conn.close()
        result['recordings'] = {'indexed': count, 'open': opened}
    except (sqlite3.Error, OSError) as error:
        result['recordings'] = {'error': str(error)}
    return result


def derived(config):
    root = Path(config['varan'])/'surround_view'
    return {str(p.relative_to(root)): {'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'mtime_ns': p.stat().st_mtime_ns} for p in root.rglob('*') if p.is_file() and p.suffix in ('.bin', '.png')}


def recording(config, payload):
    conn = sqlite3.connect('file:'+str(Path(config['archive'])/'segments.db')+'?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    only = payload.get('only_paths', [])
    if only and (not isinstance(only, list) or len(only)>2 or any(not isinstance(name, str) for name in only)):
        raise ValueError('A probe batch accepts at most two indexed files')
    all_paths = set() if only else {row[0] for row in conn.execute('SELECT path FROM segments')}
    last_id = conn.execute('SELECT COALESCE(MAX(rowid), 0) FROM segments').fetchone()[0]
    if payload.get('list_only'):
        latest = [dict(row) for row in conn.execute('SELECT rowid AS checkpoint_id, camera_id, stream_key, session_uid, closed FROM segments WHERE rowid IN (SELECT MAX(rowid) FROM segments GROUP BY camera_id, stream_key)')]
        conn.close()
        return {'paths': sorted(all_paths), 'last_id': last_id, 'latest': latest}
    query = 'SELECT rowid AS checkpoint_id, * FROM segments WHERE rowid > ? AND rowid <= ?'
    params = [payload.get('after_id', 0), payload.get('through_id', last_id)]
    initial = payload.get('initial_ids', [])
    if initial:
        if len(initial)>1000 or any(type(value) is not int or value<0 for value in initial):
            raise ValueError('Invalid initial segment checkpoints')
        query = 'SELECT rowid AS checkpoint_id, * FROM segments WHERE (rowid > ? OR rowid IN ('+','.join('?' for _ in initial)+')) AND rowid <= ?'
        params = [payload.get('after_id', 0), *initial, payload.get('through_id', last_id)]
    if only:
        query += ' AND path IN ('+','.join('?' for _ in only)+')'
        params.extend(only)
    rows = [dict(row) for row in conn.execute(query+' ORDER BY mono_start_ms', params)]
    conn.close()
    def probe(row):
        path = Path(row['path'])
        value = {**row, 'file': path.name, 'exists': path.is_file()}
        if path.is_file():
            output = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', str(path)], capture_output=True, timeout=45)
            if output.returncode == 0:
                value['packets'] = json.loads(output.stdout).get('packets', [])
            else:
                value['probe_error'] = output.stderr.decode(errors='replace')[-1000:]
        return value
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        details = rows if payload.get('metadata_only') else list(pool.map(probe, rows))
    if only:
        return {'rows': details}
    target = json.loads((Path(config['archive'])/'target.json').read_text())
    root = Path(target['path'])
    indexed = {str(Path(value).resolve()) for value in all_paths}
    unindexed = [str(p) for p in root.rglob('*.mp4') if payload['since_ms'] <= p.stat().st_mtime*1000 <= payload.get('until_ms', round(time.time()*1000))+3000 and str(p.resolve()) not in indexed]
    return {'rows': details, 'unindexed_files': unindexed, 'all_paths': sorted(all_paths)}


def bridge(payload):
    slave = None
    if payload['line'] == 'software':
        fd, slave = os.openpty()
        tty.setraw(slave)
        device = os.ttyname(slave)
        visible = subprocess.run(['docker', 'exec', 'message-gateway', 'test', '-e', device], timeout=10).returncode == 0
        if not visible:
            raise RuntimeError('Host PTY is not visible inside message-gateway; expose host /dev/pts before using software RTU')
    else:
        device = payload['device']
        if not device.startswith('/dev/') or '..' in device.split('/'):
            raise ValueError('Invalid serial path')
        fd = os.open(device, os.O_RDWR | os.O_NOCTTY)
        tty.setraw(fd)
        attrs = termios.tcgetattr(fd)
        attrs[4] = attrs[5] = getattr(termios, 'B'+str(payload['baud']))
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
    try:
        print(json.dumps({'device': device}), flush=True)
        while True:
            ready, _, _ = select.select([fd, sys.stdin.fileno()], [], [], 20)
            for source in ready:
                raw = os.read(source, 4096)
                if not raw:
                    return
                os.write(fd if source == sys.stdin.fileno() else sys.stdout.fileno(), raw)
    finally:
        os.close(fd)
        if slave is not None:
            os.close(slave)


def can(payload):
    interface = payload['iface']
    if not interface.isascii() or not interface.replace('_', '').replace('-', '').isalnum() or len(interface)>15:
        raise ValueError('Invalid CAN interface')
    created = False
    pending = bytearray()
    try:
        if payload['line']=='software':
            subprocess.run(['modprobe', 'vcan'], check=True, capture_output=True)
            subprocess.run(['ip', 'link', 'add', 'dev', interface, 'type', 'vcan'], check=True, capture_output=True)
            created = True
            subprocess.run(['ip', 'link', 'set', interface, 'up'], check=True, capture_output=True)
        with socket.socket(socket.PF_CAN, socket.SOCK_RAW, socket.CAN_RAW) as bus:
            bus.bind((interface,))
            print(json.dumps({'iface': interface, 'created': created}), flush=True)
            while True:
                ready, _, _ = select.select([bus, sys.stdin.fileno()], [], [], 20)
                for source in ready:
                    if source == sys.stdin.fileno():
                        raw = os.read(sys.stdin.fileno(), 4096)
                        if not raw:
                            return
                        pending.extend(raw)
                        while b'\n' in pending:
                            line, _, pending = pending.partition(b'\n')
                            value = json.loads(line)
                            import struct
                            data = bytes.fromhex(value['data'])
                            if len(data)>8:
                                raise ValueError('CAN payload exceeds 8 bytes')
                            bus.send(struct.pack('=IB3x8s', int(value['id']) | 0x80000000, len(data), data.ljust(8, b'\0')))
                    else:
                        import struct
                        identifier, length, data = struct.unpack('=IB3x8s', bus.recv(16))
                        print(json.dumps({'id': identifier & 0x1fffffff, 'data': data[:length].hex(), 'extended': bool(identifier & 0x80000000)}), flush=True)
    finally:
        if created:
            subprocess.run(['ip', 'link', 'del', interface], capture_output=True, timeout=10)


def main():
    payload = json.loads(sys.stdin.buffer.readline())
    operation, config = payload['operation'], payload['config']
    if operation == 'serial':
        return bridge(payload)
    if operation == 'can':
        return can(payload)
    if operation == 'discover':
        result = discover(config)
    elif operation == 'sample':
        result = metrics(config, payload)
    elif operation == 'capabilities':
        result = capabilities(payload)
    elif operation == 'start':
        result = start(config, payload['saved'])
    elif operation == 'stop':
        result = stop(config, payload['expected'])
    elif operation == 'derived':
        result = derived(config)
    elif operation == 'recording':
        result = recording(config, payload)
    elif operation == 'restart':
        if payload['service'] not in SERVICES:
            raise ValueError('Unknown service')
        subprocess.run(['docker', 'restart', payload['service']], check=True, capture_output=True, timeout=120)
        result = containers()
    else:
        raise ValueError('Unknown operation')
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
