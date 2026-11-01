import argparse
import concurrent.futures
import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from recording import boundary_gaps, packet_span

ZONE = Path('/home/orangepi/media-center/codex')
BINARY = ZONE / 'build/media-center'


def directory(run_id):
    if not re.fullmatch(r'run-[a-z0-9-]{1,70}', run_id):
        raise ValueError('Invalid owned run ID')
    root = (ZONE / 'runs').resolve()
    target = (root / run_id).resolve()
    if not target.is_relative_to(root):
        raise ValueError('Run directory escapes the owned zone')
    return target


def identity(pid):
    try:
        return {'pid': pid, 'exe': str(Path(f'/proc/{pid}/exe').resolve(strict=True)),
                'started': Path(f'/proc/{pid}/stat').read_text().split(') ', 1)[1].split()[19]}
    except (FileNotFoundError, ProcessLookupError):
        return None


def process(run):
    path = run / 'process.json'
    if not path.exists():
        return None
    saved = json.loads(path.read_text())
    if saved.get('exe') != str(BINARY.resolve()) or identity(saved['pid']) != saved:
        return None
    return saved


def stop(run, expected=None):
    owned = process(run)
    if not owned or expected and owned != expected:
        return {'stopped': True, 'forced': False}
    forced = False
    for sig, timeout in ((signal.SIGINT, 50), (signal.SIGTERM, 10), (signal.SIGKILL, 5)):
        if process(run) != owned:
            break
        forced |= sig != signal.SIGINT
        try:
            os.killpg(owned['pid'], sig)
        except ProcessLookupError:
            break
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and process(run) == owned:
            time.sleep(.25)
    return {'stopped': process(run) != owned, 'forced': forced}


def initialize(run, payload):
    import hashlib
    if run.exists():
        raise ValueError('Run directory already exists')
    source = Path('/home/orangepi/varan')
    target = json.loads(Path('/storage/archive/target.json').read_text())
    selected = Path(target['path']).resolve()
    recording_parent = selected.parent / 'codex-test-recordings'
    if selected == selected.parent or recording_parent.is_relative_to(selected):
        raise ValueError('Cannot isolate recordings from the working archive')
    if os.stat(selected).st_dev != os.stat(selected.parent).st_dev:
        raise ValueError('An isolated recording directory on the selected filesystem is required')
    recordings = recording_parent / run.name
    recordings.mkdir(parents=True, exist_ok=False)
    run.mkdir(parents=True)
    for name in ('nvr', 'neural', 'surround_view', 'config'):
        shutil.copytree(source / name, run / 'varan' / name)
    (run/'varan/config/hold.json').write_text(json.dumps({'transition_id':'fixture-init-'+run.name,'held':True,'modules':[]}))
    archive = run / 'archive'
    archive.mkdir()
    marker = recordings / '.varan-volume'
    marker.write_text(json.dumps({'id': run.name}))
    (archive / 'target.json').write_text(json.dumps({'volume_id': run.name, 'path': str(recordings), 'marker': str(marker)}))
    (run / 'owned.json').write_text(json.dumps({'run': run.name, 'recordings': str(recordings), 'source': str(source)}))
    uid, gid = payload.get('uid', 1000), payload.get('gid', 1000)
    if os.geteuid() == 0:
        os.chown(recording_parent,uid,gid)
        for root in (run, recordings):
            for current, directories, files in os.walk(root):
                os.chown(current, uid, gid)
                for name in files:
                    os.chown(Path(current) / name, uid, gid)
    images=json.loads(subprocess.check_output(['docker','inspect','message-gateway','detection-service','fastapi','frontend']))
    return {'recordings': str(recordings), 'free_bytes': shutil.disk_usage(recordings).free,
            'binary_sha256':hashlib.sha256(BINARY.read_bytes()).hexdigest(),
            'images':{item['Name'].lstrip('/'):item['Image'] for item in images}}


def start(run, payload):
    if not (run / 'owned.json').is_file() or process(run):
        raise ValueError('Missing ownership marker or owned MC is already running')
    with socket.socket() as probe:
        try:
            probe.connect(('127.0.0.1', 7777))
        except ConnectionRefusedError:
            pass
        else:
            raise ValueError('Port 7777 is occupied; refusing to interfere with another MC')
    (run / 'lease').touch()
    command = ['bash', '-c', 'source /opt/gstreamer-1.28/env.sh; exec "$@"', 'mc-test', str(BINARY),
               '--rest-port=7777', '--signaling-ip=127.0.0.1', '--signaling-port=8765',
               '--varan-root=' + str(run / 'varan'), '--archive-dir=' + str(run / 'archive'),
               '--modules=birdview,neural', '--gateway-ip=127.0.0.1', '--gateway-port=50051',
               '--detection-ip=127.0.0.1', '--detection-port=50052']
    env = dict(os.environ, DISPLAY=':0', XAUTHORITY='/home/orangepi/.Xauthority', XDG_RUNTIME_DIR='/run/user/1000')
    with (run / 'mc-output.log').open('ab') as log:
        child = subprocess.Popen(command, cwd=BINARY.parent, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    saved = None
    for _ in range(50):
        saved = identity(child.pid)
        if saved and saved['exe'] == str(BINARY.resolve()):
            break
        if child.poll() is not None:
            raise RuntimeError('Owned MC exited during startup')
        time.sleep(.1)
    if not saved or saved['exe'] != str(BINARY.resolve()):
        os.killpg(child.pid, signal.SIGINT)
        raise RuntimeError('Cannot identify owned MC binary')
    (run / 'process.json').write_text(json.dumps(saved))
    with (run / 'watchdog.log').open('ab') as log:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'watch', '--run', run.name,
                          '--identity', json.dumps(saved)], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    return saved


def sample(run, payload):
    (run / 'lease').touch()
    owned = process(run)
    if not owned:
        return {'alive': False}
    proc = Path('/proc') / str(owned['pid'])
    status = proc.joinpath('status').read_text()
    descriptors = list(proc.joinpath('fd').iterdir())
    dma = 0
    for descriptor in descriptors:
        try:
            dma += 'dmabuf' in os.readlink(descriptor).lower()
        except OSError:
            pass
    memory=Path('/proc/meminfo').read_text()
    temperatures=[]
    for path in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
        try:temperatures.append(float(path.read_text())/1000)
        except (OSError,ValueError):pass
    return {'alive': True, 'wall_ms':round(time.time()*1000), 'pid': owned['pid'], 'rss_mb': int(re.search(r'VmRSS:\s+(\d+)', status)[1]) / 1024,
            'fd': len(descriptors), 'dma_buf': dma, 'threads': int(re.search(r'Threads:\s+(\d+)', status)[1]),
            'available_mb':int(re.search(r'MemAvailable:\s+(\d+)',memory)[1])/1024,'temperature_c':max(temperatures,default=None),
            'free_bytes': shutil.disk_usage(json.loads((run / 'owned.json').read_text())['recordings']).free,
            'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}


def analyze(run, payload):
    db = sqlite3.connect('file:' + str(run / 'archive/segments.db') + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    rows = [dict(row) for row in db.execute('SELECT * FROM segments ORDER BY session_uid,camera_id,stream_key,mono_start_ms')]
    db.close()
    recording_root = Path(json.loads((run / 'owned.json').read_text())['recordings'])
    files = {str(path.resolve()) for path in recording_root.rglob('*.mp4')}
    def inspect(row):
        path = Path(row['path'])
        result = {key: row[key] for key in ('session_uid','camera_id','stream_key','mono_start_ms','mono_end_ms','wall_start_ms','wall_end_ms','closed','error')}
        result.update(file=path.name, exists=path.is_file(), verified=False, size=path.stat().st_size if path.is_file() else 0)
        if path.is_file():
            probe = subprocess.run(['docker','exec','storage-service','ffprobe','-v','error','-select_streams','v:0',
                                    '-show_packets','-show_entries','packet=pts_time,duration_time','-of','json',str(path)],capture_output=True,timeout=30)
            if probe.returncode == 0:
                result.update(packet_span(json.loads(probe.stdout).get('packets', [])))
            else:
                result['probe_error'] = probe.stderr.decode(errors='replace')[-500:]
        return result
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
        details = list(workers.map(inspect, rows))
    unexpected = boundary_gaps(details, payload.get('events', []))
    indexed = {str(Path(row['path']).resolve()) for row in rows}
    original = sqlite3.connect('file:/storage/archive/segments.db?mode=ro',uri=True)
    mixed = original.execute('SELECT count(*) FROM segments WHERE path LIKE ?', (str(recording_root)+'/%',)).fetchone()[0]
    original.close()
    return {'rows':details,'gaps':unexpected,'unindexed_files':[Path(path).name for path in sorted(files-indexed)],
            'missing_files':[Path(path).name for path in sorted(indexed-files)],'files':len(files),'indexed':len(indexed),'mixed_into_original':mixed}


def logs(run, payload):
    files = sorted((run/'varan/logs').glob('*'),key=lambda path:path.stat().st_mtime)
    paths = [run/'mc-output.log'] + files[-4:]
    text = '\n'.join(path.read_text(errors='replace')[-2000000:] for path in paths if path.is_file())
    text = re.sub(r'(rtsps?://)[^\s/@]+(?::[^\s/@]*)?@',r'\1[redacted]@',text)
    text = re.sub(r'(?i)("?(?:password|credential)"?\s*[:=]\s*)"?[^",\s}]+',r'\1[redacted]',text)
    return {'text':text,'watchdog':(run/'watchdog.json').read_text() if (run/'watchdog.json').exists() else None}


def surround(run,payload):
    import hashlib
    return {str(path.relative_to(run/'varan/surround_view')):{'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'mtime_ns':path.stat().st_mtime_ns}
            for path in (run/'varan/surround_view').rglob('*') if path.is_file() and path.suffix in ('.bin','.png')}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('operation',choices=['init','start','stop','sample','analyze','logs','surround','protocol','watch'])
    parser.add_argument('--run',required=True)
    parser.add_argument('--identity')
    args=parser.parse_args()
    run=directory(args.run)
    if args.operation=='watch':
        saved=json.loads(args.identity)
        while process(run)==saved:
            if time.time()-(run/'lease').stat().st_mtime>120:
                result=stop(run,saved)
                (run/'watchdog.json').write_text(json.dumps(result))
                break
            time.sleep(5)
        return
    payload=json.load(sys.stdin)
    def protocols(r,p):
        from protocol import run as protocol_run
        return protocol_run(r.name)
    operations={'init':initialize,'start':start,'stop':lambda r,p:stop(r),'sample':sample,'analyze':analyze,'logs':logs,'surround':surround,'protocol':protocols}
    print(json.dumps(operations[args.operation](run,payload)),flush=True)


if __name__=='__main__':
    main()
