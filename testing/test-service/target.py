import asyncio
import base64
import hashlib
import json
import shlex
import time
import zlib
from pathlib import Path
from urllib.parse import quote

import httpx
import paramiko

from store import BudgetError, redacted


class RequestError(RuntimeError):
    def __init__(self, service, method, path, status, detail):
        super().__init__(f'{service} {method} {path}: HTTP {status}: {detail}')
        self.status = status


def storage_budget(snapshot, required):
    volumes = snapshot.get('volumes', [])
    target = snapshot.get('target', {}).get('volume_id')
    selected = [v for v in volumes if v.get('internal') or v.get('id') == target]
    if not selected or not any(v.get('id') == target for v in selected):
        raise BudgetError('Selected archive volume accounting is unavailable')
    summary = snapshot.get('summary', {})
    reserve, journal = summary.get('journal_reserve_bytes'), summary.get('journal_bytes')
    if any(isinstance(v, bool) or not isinstance(v, (float, int)) or v < 0 for v in (reserve, journal)):
        raise BudgetError('Journal reserve accounting is unavailable')
    results = []
    for volume in selected:
        total, used, high = (volume.get(k) for k in ('total_bytes', 'used_bytes', 'high'))
        if volume.get('state') != 'online' or any(isinstance(v, bool) or not isinstance(v, (float, int)) for v in (total, used, high)) or total <= 0 or used < 0 or not 0 < high <= 100:
            raise BudgetError('Archive cleaner accounting is invalid')
        margin = total*high/100-used-(max(0, reserve-journal) if volume.get('internal') else 0)
        if margin < required:
            raise BudgetError(f'Logical archive headroom {margin/1024**3:.2f} GiB below required {required/1024**3:.2f} GiB')
        results.append({'volume': volume['id'], 'headroom_bytes': round(margin), 'high': high})
    return results


class Fingerprint(paramiko.MissingHostKeyPolicy):
    def __init__(self, expected):
        self.expected = expected

    def missing_host_key(self, client, hostname, key):
        fingerprint = 'SHA256:'+base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
        if not self.expected or fingerprint != self.expected:
            raise RuntimeError('SSH host fingerprint is not pinned or does not match: '+fingerprint)


class Target:
    def __init__(self, config, root):
        self.config = config
        self.root = root

    async def request(self, service, method, path, body=None, **kwargs):
        async with httpx.AsyncClient(timeout=kwargs.pop('timeout', 30), trust_env=False) as client:
            response = await client.request(method, getattr(self.config, service)+path, json=body, **kwargs)
        if response.is_error:
            try:
                value = response.json()
                detail = value.get('detail', value.get('error', 'Request failed'))
                if isinstance(detail, list):
                    detail = '; '.join(str(item.get('loc', []))+': '+str(item.get('msg', 'Invalid input')) for item in detail if isinstance(item, dict))
            except (ValueError, AttributeError):
                detail = 'Request failed'
            raise RequestError(service, method, path, response.status_code, redacted(str(detail)))
        if not response.content:
            return {}
        result = response.json()
        return result.get('data', result) if isinstance(result, dict) else result

    def ssh(self):
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(Fingerprint(self.config.ssh_fingerprint))
        client.connect(self.config.ssh_host, port=self.config.ssh_port, username=self.config.ssh_user, key_filename=str(self.root/'private'/'ssh-key'), allow_agent=False, look_for_keys=False, timeout=8, banner_timeout=8, auth_timeout=8)
        return client

    def channel(self, operation, payload=None):
        client = self.ssh()
        try:
            code = base64.b64encode(zlib.compress(Path(__file__).with_name('host.py').read_bytes())).decode()
            script = "import base64,zlib;exec(compile(zlib.decompress(base64.b64decode('"+code+"')),'host.py','exec'))"
            command = ('sudo -n ' if self.config.sudo else '')+shlex.join(['python3', '-u', '-c', script])
            channel = client.get_transport().open_session(timeout=10)
            channel.settimeout(20)
            channel.exec_command(command)
            channel.sendall((json.dumps({'operation': operation, 'config': self.config.model_dump(), **(payload or {})})+'\n').encode())
            return client, channel
        except BaseException:
            client.close()
            raise

    def sync_rpc(self, operation, payload=None, timeout=90):
        client, channel = self.channel(operation, payload)
        channel.shutdown_write()
        output = bytearray()
        error = bytearray()
        end = time.monotonic()+timeout
        try:
            while not channel.exit_status_ready() or channel.recv_ready() or channel.recv_stderr_ready():
                if time.monotonic() > end:
                    raise TimeoutError('Host operation timed out: '+operation)
                if channel.recv_ready():
                    output.extend(channel.recv(65536))
                if channel.recv_stderr_ready():
                    error.extend(channel.recv_stderr(65536))
                if len(output)>256*1024**2:
                    raise RuntimeError('Host result exceeds 256 MiB')
                time.sleep(.01)
            if channel.recv_exit_status():
                raise RuntimeError('Host operation failed: '+operation+' / '+error.decode(errors='replace')[-1000:])
            return json.loads(output)
        finally:
            channel.close()
            client.close()

    async def rpc(self, operation, payload=None, timeout=90):
        worker = asyncio.create_task(asyncio.to_thread(self.sync_rpc, operation, payload, timeout))
        try:
            return await asyncio.shield(worker)
        except asyncio.CancelledError:
            try:
                await asyncio.shield(worker)
            except Exception:
                pass
            raise

    async def ready(self, timeout=120):
        end = time.monotonic()+timeout
        while time.monotonic()<end:
            try:
                info = await self.request('mc', 'GET', '/system/info', timeout=5)
                if info.get('device_id'):
                    return info
            except Exception:
                pass
            await asyncio.sleep(1)
        raise RuntimeError('MC API readiness timed out')

    async def transition(self, profile, timeout=240):
        end = time.monotonic()+timeout
        while True:
            try:
                await self.request('api', 'POST', '/api/config/active', {'profile_id': profile})
                break
            except RequestError as error:
                if error.status!=409 or time.monotonic()>=end:
                    raise
                await asyncio.sleep(1)
        while time.monotonic()<end:
            result = await self.request('api', 'GET', '/api/config/status')
            state = result.get('transition') or {}
            if state.get('phase')=='complete':
                return state
            if state.get('error'):
                raise RuntimeError('Profile transition failed: '+str(state['error']))
            await asyncio.sleep(1)
        raise RuntimeError('Profile transition timed out')

    async def source(self, profile, kind, key, body):
        path = '/api/config/entities/'+kind+'/'+quote(key, safe='')+'?profile_id='+quote(profile, safe='')
        return await self.request('api', 'DELETE' if body is None else 'PUT', path, body)
