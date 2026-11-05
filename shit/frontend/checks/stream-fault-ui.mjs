// Причины отказа потока камеры: экран «Камеры» и ячейки трансляции показывают то, что плата прислала в streams[*].error.
// Ответы /api/cameras и /api/layouts подменяются в браузере, остальное идёт на бэкенд интерфейса (только чтение).
// node stream-fault-ui.mjs <ui url> [out dir для скриншотов]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [UI, OUT] = process.argv.slice(2);
const port = 9468;
const dir = mkdtempSync(join(tmpdir(), 'fault-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'ошибка страницы'); return r.result?.result?.value; };
const waitFor = async (expression, label, timeout = 30000) => { const start = Date.now(); while (Date.now() - start < timeout) { if (await ev(expression).catch(() => false)) return; await sleep(150); } throw new Error(`timeout: ${label}`); };
async function step(name, fn) {
    try { await fn(); results.push(true); console.log(`✓ ${name}`); } catch (failure) { results.push(false); console.log(`✗ ${name}: ${failure.message}`); }
}
const expect = (condition, message) => { if (!condition) throw new Error(message); };
async function shot(name) {
    if (!OUT) return;
    mkdirSync(OUT, { recursive: true });
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
}

// Что прислали бы платы: поток 3 — идёт, остальные стоят с причиной или без неё (старая плата)
const stream = (status, error, purposes = ['view']) => ({
    status, purposes, codec: 'H264', width: status === 3 ? 1920 : 0, height: status === 3 ? 1080 : 0, fps: 25,
    channel: 1, substream: 1, latency: 200, reconnect: 10, record_path: '', segment: 600, rtsp: 'rtsp://10.0.0.1/s', use_udp: false,
    ...(error ? { error: { code: error, since: 1, attempts: 3 } } : {}),
});
const camera = (n, streams) => ({ id: `cam_${n}`, display_name: `Камера ${n}`, ip_adress: `10.0.0.${n}`, port: '554', user: 'u', password: 'p', production: 0, device_id: 'dev', device_name: 'Плата', streams });
const CAMERAS = {
    cam_auth: camera('auth', { stream_1: stream(1, 3003) }),
    cam_away: camera('away', { stream_1: stream(1, 3007) }),
    cam_mix: camera('mix', { stream_1: stream(3), stream_2: stream(1, 3002) }),
    cam_ok: camera('ok', { stream_1: stream(3) }),
    cam_old: camera('old', { stream_1: stream(1) }),
};
const LAYOUT = { name: 'fault-test', gridSize: 4, activeCells: { 0: 'cam_auth', 1: 'cam_away', 2: 'cam_ok', 3: 'cam_old' }, timestamp: 1 };
const json = (body, headers = {}) => ({ responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, ...Object.entries(headers).map(([name, value]) => ({ name, value }))], body: Buffer.from(JSON.stringify(body)).toString('base64') });

const text = (selector) => ev(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`);
const rowOf = (name) => `Array.from(document.querySelectorAll('.cam-row')).find(r => r.textContent.includes(${JSON.stringify(name)}))`;

try {
    let targets;
    for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(250); } }
    ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
        if (d.method !== 'Fetch.requestPaused') return;
        const { requestId, request } = d.params;
        const path = new URL(request.url).pathname;
        let answer = null;
        if (request.method === 'GET' && path === '/api/cameras') answer = json({ data: { cameras: CAMERAS, virtual: [], conflicts: {} } });
        if (request.method === 'GET' && path === '/api/layouts') answer = json([LAYOUT], { 'X-Profile-Id': 'p', 'X-Layout-Context': 'c', 'X-Profile-Phase': 'complete' });
        if (answer) send('Fetch.fulfillRequest', { requestId, ...answer });
        else send('Fetch.continueRequest', { requestId });
    };
    await send('Page.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/cameras*' }, { urlPattern: '*/api/layouts*' }] });
    await send('Page.navigate', { url: UI + '/app/' });
    await sleep(2500);
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, role: 'admin', sub: 'e' })).toString('base64url');
    await ev(`localStorage.setItem('token', 'e30.${payload}.x'); localStorage.setItem('role','admin'); localStorage.setItem('username','e'); true`);

    await send('Page.navigate', { url: UI + '/app/cameras' });
    await waitFor(`document.querySelectorAll('.cam-row').length >= 5`, 'строки камер');
    await sleep(500);

    await step('Камеры: причина вместо «нет потоков», у смешанной — по потокам, у старой платы — как раньше', async () => {
        const status = (name) => ev(`${rowOf(name)}.querySelector('.st').textContent.trim()`);
        const auth = await status('Камера auth'), away = await status('Камера away'), mix = await status('Камера mix'), ok = await status('Камера ok'), old = await status('Камера old');
        expect(auth === 'ошибка пароля', `auth: ${auth}`);
        expect(away === 'камера недоступна', `away: ${away}`);
        expect(/частично/.test(mix) && /поток 2: поток не найден/.test(mix), `mix: ${mix}`);
        expect(ok === 'в работе', `ok: ${ok}`);
        expect(old === 'нет потоков', `old: ${old}`);
    });
    await step('Камеры: полная причина лежит в подсказке строки', async () => {
        const tip = await ev(`${rowOf('Камера auth')}.querySelector('.st').dataset.tip`);
        expect(tip === 'Нет доступа к камере: неверный логин или пароль', String(tip));
        const away = await ev(`${rowOf('Камера away')}.querySelector('.st').dataset.tip`);
        expect(/не отвечает по этому адресу/.test(away), String(away));
        expect(!(await ev(`${rowOf('Камера old')}.querySelector('.st').dataset.tip`)), 'у старой платы подсказки быть не должно');
    });
    await step('Камеры: таблица потоков показывает причину в «Состоянии»', async () => {
        await ev(`${rowOf('Камера auth')}.click()`);
        await sleep(1200);
        await shot('cameras');
        await waitFor(`!!document.querySelector('.stab tbody tr')`, 'таблица потоков', 5000);
        const cell = await ev(`document.querySelector('.stab tbody tr .st').textContent.trim()`);
        expect(cell === 'ошибка пароля', cell);
        await shot('cameras');
    });

    await send('Page.navigate', { url: UI + '/translation/fault-test' });
    await waitFor(`document.querySelectorAll('.wall .cell').length >= 4`, 'ячейки трансляции');
    await sleep(1500);

    await step('Трансляция: в ячейке плашка с причиной и подсказкой', async () => {
        const plate = (cell) => ev(`(() => { const p = document.querySelector('.cell[data-cell="${cell}"] .cell-lost'); return p ? { text: p.querySelector('span:nth-child(2)').textContent.trim(), tip: p.dataset.tip } : null; })()`);
        const auth = await plate(0), away = await plate(1);
        expect(auth?.text === 'ошибка пароля' && /неверный логин или пароль/.test(auth.tip), JSON.stringify(auth));
        expect(away?.text === 'камера недоступна', JSON.stringify(away));
        await shot('translation');
    });
    await step('Трансляция: без причины (старая плата, идущий поток) плашки отказа нет', async () => {
        for (const cell of [2, 3]) {
            const has = await ev(`!!document.querySelector('.cell[data-cell="${cell}"] .cell-lost')`);
            expect(!has, `ячейка ${cell} показывает плашку без причины`);
        }
    });
} finally {
    const failed = results.filter((ok) => !ok).length;
    console.log(`\nИтого: ${results.length - failed} из ${results.length} шагов`);
    chrome.kill();
    process.exit(failed ? 1 : 0);
}
