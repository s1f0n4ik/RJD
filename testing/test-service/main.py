import asyncio
import hashlib
import hmac
import json
import os
import secrets
import shutil
import time
import uuid
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from engine import BusyError, CATALOG, Engine
from models import Emulation, RunOptions, Scenario, Target as TargetConfig
from store import Store, atomic, html_report, now, redacted
from target import storage_budget


HERE = Path(__file__).parent


def create_app(data=None, password=None, engine_factory=Engine):
    password = password or os.environ.get('TEST_PASSWORD')
    if not password or len(password)<12:
        raise RuntimeError('TEST_PASSWORD must contain at least 12 characters')
    store = Store(data or os.environ.get('TEST_DATA', '/data'))
    engine = engine_factory(store)
    sessions = {}
    attempts = {}

    async def observer():
        while True:
            if not engine.active and (store.root/'private'/'target.json').exists() and (store.root/'private'/'ssh-key').exists():
                try:
                    sample = await engine.target().rpc('sample')
                    sample['storage'] = await engine.target().request('storage', 'GET', '/api/storage/pool', timeout=8)
                    sample['at'] = now()
                    engine.status = sample
                except Exception as error:
                    engine.status = {'error': str(error), 'at': now()}
            await asyncio.sleep(5)

    @asynccontextmanager
    async def lifespan(app):
        await engine.startup()
        watcher = asyncio.create_task(observer())
        try:
            yield
        finally:
            watcher.cancel()
            with suppress(asyncio.CancelledError):
                await watcher
            await engine.shutdown()

    app = FastAPI(title='RJD Testing', lifespan=lifespan)
    app.state.engine = engine
    app.state.store = store

    @app.exception_handler(RuntimeError)
    async def runtime_error(request, error):
        return JSONResponse({'detail': redacted(str(error))}, status_code=409)

    def authenticated(request):
        auth = request.headers.get('authorization', '')
        if auth.startswith('Bearer ') and hmac.compare_digest(hashlib.sha256(auth[7:].encode()).digest(), hashlib.sha256(password.encode()).digest()):
            return True
        token = request.cookies.get('rjd-testing')
        return bool(token and sessions.get(token, 0)>time.time())

    @app.middleware('http')
    async def access(request, call_next):
        public = request.url.path in ('/', '/health', '/api/login') or request.url.path.startswith(('/static/', '/fonts/'))
        if not public and not authenticated(request):
            return JSONResponse({'detail': 'Authentication required'}, status_code=401)
        if request.method not in ('GET', 'HEAD', 'OPTIONS') and not request.headers.get('authorization', '').startswith('Bearer '):
            origin = request.headers.get('origin')
            if origin and origin.rstrip('/')!=str(request.base_url).rstrip('/'):
                return JSONResponse({'detail': 'Cross-origin mutation rejected'}, status_code=403)
        try:
            response = await call_next(request)
        except BusyError as error:
            response = JSONResponse({'detail': str(error)}, status_code=409)
        except (ValueError, FileNotFoundError) as error:
            response = JSONResponse({'detail': str(error)}, status_code=400)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        if not request.url.path.startswith('/static/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.get('/health')
    async def health():
        return {'ok': True, 'busy': bool(engine.active)}

    @app.get('/')
    async def index(request: Request):
        return FileResponse(HERE/'static'/('index.html' if authenticated(request) else 'login.html'))

    @app.post('/api/login')
    async def login(request: Request, body: dict = Body(...)):
        key = request.client.host
        current = time.monotonic()
        attempts[key] = [t for t in attempts.get(key, []) if current-t<60]
        if len(attempts[key])>=8:
            raise HTTPException(429, 'Too many login attempts; retry in one minute')
        attempts[key].append(current)
        supplied = str(body.get('password', ''))
        if not hmac.compare_digest(hashlib.sha256(supplied.encode()).digest(), hashlib.sha256(password.encode()).digest()):
            raise HTTPException(401, 'Invalid operator password')
        token = secrets.token_urlsafe(32)
        sessions.update({token: time.time()+12*3600})
        for old in list(sessions):
            if sessions[old]<time.time():
                del sessions[old]
        if len(attempts)>1000:
            attempts.clear()
        response = JSONResponse({'ok': True})
        response.set_cookie('rjd-testing', token, max_age=12*3600, httponly=True, samesite='strict', secure=request.url.scheme=='https')
        return response

    @app.post('/api/logout')
    async def logout(request: Request):
        sessions.pop(request.cookies.get('rjd-testing'), None)
        response = JSONResponse({'ok': True})
        response.delete_cookie('rjd-testing')
        return response

    def idle():
        if engine.active:
            raise HTTPException(409, 'Configuration changes are blocked during an active session or recovery')

    @app.get('/api/target')
    async def get_target():
        return {'config': engine.config().model_dump(), 'key_present': (store.root/'private'/'ssh-key').is_file()}

    @app.put('/api/target')
    async def put_target(config: TargetConfig):
        async with engine.lock:
            idle()
            atomic(store.root/'private'/'target.json', config.model_dump())
        return {'ok': True}

    @app.post('/api/target/key')
    async def key(request: Request):
        async with engine.lock:
            idle()
            content = bytearray()
            async for chunk in request.stream():
                content.extend(chunk)
                if len(content)>65536:
                    raise HTTPException(413, 'SSH key exceeds 64 KiB')
            if len(content)>65536 or b'PRIVATE KEY' not in content:
                raise HTTPException(400, 'An unencrypted SSH private key up to 64 KiB is required')
            path = store.root/'private'/'ssh-key'
            temporary = path.with_suffix('.tmp')
            temporary.write_bytes(content)
            temporary.chmod(0o600)
            try:
                import paramiko
                try:
                    paramiko.PKey.from_path(temporary)
                except (ValueError, paramiko.SSHException):
                    raise HTTPException(422, 'Invalid or encrypted SSH private key')
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
        return {'ok': True}

    @app.post('/api/preflight')
    async def preflight(options: RunOptions):
        return await engine.preflight(options)

    @app.get('/api/catalog')
    async def catalog():
        return {'cases': CATALOG}

    def state():
        report = {**engine.report, 'samples': [], 'events': engine.report['events'][-100:]} if engine.report else None
        if report:
            report.pop('emulation', None)
        return {'active': {'id': engine.active['id'], 'kind': engine.active['kind'], 'phase': engine.active['phase']} if engine.active else None, 'run': report if engine.active else None, 'last_run': report if not engine.active else None, 'system': engine.status, 'emulation': engine.emulator.snapshot() if engine.emulator else None}

    @app.get('/api/state')
    async def get_state():
        return state()

    @app.get('/api/events')
    async def events(request: Request):
        async def generate():
            while not await request.is_disconnected():
                yield 'data: '+json.dumps(state(), ensure_ascii=False)+'\n\n'
                await asyncio.sleep(1)
        return StreamingResponse(generate(), media_type='text/event-stream', headers={'X-Accel-Buffering': 'no'})

    @app.post('/api/sessions/tests', status_code=202)
    async def start_tests(options: RunOptions):
        return await engine.start('tests', options)

    @app.post('/api/sessions/emulation', status_code=202)
    async def start_emulation(options: Emulation):
        return await engine.start('emulation', options)

    @app.post('/api/sessions/stop', status_code=202)
    async def stop():
        return await engine.stop()

    @app.post('/api/recovery', status_code=202)
    async def recover():
        await engine.retry()
        return {'state': 'recovering'}

    @app.get('/api/runs')
    async def runs():
        return {'runs': store.runs()}

    def run(run_id):
        report = store.read(store.path('runs', run_id)/'report.json')
        if not report:
            raise HTTPException(404, 'Run not found')
        return report

    @app.get('/api/runs/{run_id}')
    async def get_run(run_id: str):
        return run(run_id)

    @app.get('/api/runs/{run_id}/report.html')
    async def download_html(run_id: str, request: Request):
        return HTMLResponse(html_report(run(run_id), str(request.base_url)), headers={'Content-Disposition': f'attachment; filename="{run_id}.html"'})

    @app.get('/api/runs/{run_id}/report.json')
    async def download_json(run_id: str):
        return JSONResponse(run(run_id), headers={'Content-Disposition': f'attachment; filename="{run_id}.json"'})

    @app.get('/api/runs/{run_id}/artifacts/{name}')
    async def artifact(run_id: str, name: str):
        report = run(run_id)
        if name not in {item['name'] for item in report['artifacts']}:
            raise HTTPException(404, 'Artifact not found')
        return FileResponse(store.path('runs', run_id)/name, filename=name)

    @app.delete('/api/runs/{run_id}')
    async def delete_run(run_id: str):
        async with engine.lock:
            if engine.active and engine.active['id']==run_id:
                raise HTTPException(409, 'Active or recovering report cannot be deleted')
            run(run_id)
            shutil.rmtree(store.path('runs', run_id))
        return {'ok': True}

    @app.get('/api/scenarios')
    async def scenarios():
        return {'scenarios': store.scenarios()}

    @app.post('/api/scenarios')
    async def create_scenario(scenario: Scenario):
        idle()
        for row in scenario.expectations:
            if row.start>row.end or row.end>scenario.duration or row.minimum>row.maximum:
                raise HTTPException(422, 'Invalid expectation time window or count range')
        key = 'scenario-'+uuid.uuid4().hex
        value = {**scenario.model_dump(), 'id': key, 'created_at': now(), 'video_present': False}
        atomic(store.path('scenarios', key)/'scenario.json', value)
        return value

    @app.put('/api/scenarios/{scenario_id}')
    async def edit_scenario(scenario_id: str, scenario: Scenario):
        idle()
        path = store.path('scenarios', scenario_id)/'scenario.json'
        old = store.read(path)
        if not old:
            raise HTTPException(404, 'Scenario not found')
        for row in scenario.expectations:
            if row.start>row.end or row.end>scenario.duration or row.minimum>row.maximum:
                raise HTTPException(422, 'Invalid expectation time window or count range')
        value = {**old, **scenario.model_dump()}
        atomic(path, value)
        return value

    @app.post('/api/scenarios/{scenario_id}/video')
    async def upload_video(scenario_id: str, request: Request):
        async with engine.lock:
            idle()
            folder = store.path('scenarios', scenario_id)
            scenario = store.read(folder/'scenario.json')
            if not scenario:
                raise HTTPException(404, 'Scenario not found')
            target = engine.target()
            pool = await target.request('storage', 'GET', '/api/storage/pool')
            storage_budget(pool, target.config.reserve_gib*1024**3)
            part = folder/'video.part'
            digest = hashlib.sha256()
            total = 0
            budget_at = time.monotonic()
            process = None
            try:
                with part.open('wb') as out:
                    async for chunk in request.stream():
                        if not chunk:
                            continue
                        total += len(chunk)
                        if total>2*1024**3:
                            raise HTTPException(413, 'Reference video exceeds 2 GiB')
                        store.budget(target.config.data_reserve_mb)
                        if time.monotonic()-budget_at>1:
                            pool = await target.request('storage', 'GET', '/api/storage/pool')
                            storage_budget(pool, 2*1024**3)
                            budget_at = time.monotonic()
                        digest.update(chunk)
                        out.write(chunk)
                process = await asyncio.create_subprocess_exec('ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', str(part), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                output, _ = await asyncio.wait_for(process.communicate(), 30)
                metadata = json.loads(output)
                if process.returncode or not any(v['codec_type']=='video' for v in metadata.get('streams', [])):
                    raise HTTPException(422, 'Reference file has no readable video stream')
                duration = float(metadata.get('format', {}).get('duration', 0))
                if duration<scenario['duration']:
                    raise HTTPException(422, 'Reference video is shorter than the declared scenario duration')
                part.replace(folder/'video')
                scenario.update(video_present=True, video_sha256=digest.hexdigest(), bytes=total, metadata=metadata)
                atomic(folder/'scenario.json', scenario)
            finally:
                if process and process.returncode is None:
                    process.kill()
                    await process.wait()
                part.unlink(missing_ok=True)
        return scenario

    @app.delete('/api/scenarios/{scenario_id}')
    async def delete_scenario(scenario_id: str):
        async with engine.lock:
            idle()
            shutil.rmtree(store.path('scenarios', scenario_id))
        return {'ok': True}

    app.mount('/static', StaticFiles(directory=HERE/'static'), name='static')
    app.mount('/fonts', StaticFiles(directory=HERE/'static/fonts', check_dir=False), name='fonts')
    return app


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(create_app(), host='0.0.0.0', port=int(os.environ.get('TEST_PORT', '8088')), workers=1, access_log=False, timeout_graceful_shutdown=5)
