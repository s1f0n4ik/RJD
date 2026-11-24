// Экран КЖТ /kzt: раскладка на 1920×1080, 1280×720, 1280×1024 и телефоне, карта, кадр, уход без КЖТ
// Все запросы /api подменяются в браузере, плата не нужна; видео без сигнализации остаётся в подключении
// node kzt-screen-ui.mjs <ui url> [out dir для скриншотов]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [UI, OUT] = process.argv.slice(2);
const port = 9474;
const dir = mkdtempSync(join(tmpdir(), 'kztscreen-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--window-size=1920,1080', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval'); return r.result?.result?.value; };
const waitFor = async (expression, label, timeout = 20000) => { const start = Date.now(); while (Date.now() - start < timeout) { if (await ev(expression).catch(() => false)) return; await sleep(200); } throw new Error(`нет: ${label}`); };
async function step(name, fn) {
    try { await fn(); results.push(true); console.log(`✓ ${name}`); } catch (failure) { results.push(false); console.log(`✗ ${name}: ${failure.message}`); }
}
const expect = (condition, message) => { if (!condition) throw new Error(message); };
const size = (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
async function shot(name) {
    if (!OUT) return;
    mkdirSync(OUT, { recursive: true });
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
}
const rect = (selector) => ev(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; })()`);
const shown = (selector) => ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; })()`);
const noScroll = () => ev('document.scrollingElement.scrollHeight <= innerHeight + 1 && document.scrollingElement.scrollWidth <= innerWidth + 1');

// ── Подменённые ответы ──
let active = 'kzt';
const NOW = Date.now();
const CLASSES = ['sleeper', 'narrow-grab-closed', 'narrow-grab-open', 'big-bucket-load', 'big-grab-closed', 'wood-sleeper'];
const DETS = Array.from({ length: 12 }, (_, i) => ({
    id: 100 - i, device_id: 'dev1', camera_id: 'kzt_cam', config_id: 'kzt_test', class_id: i % CLASSES.length, class_name: CLASSES[i % CLASSES.length],
    superclass: null, zone: null, started_at: NOW - i * 45_000, ended_at: NOW - i * 45_000 + 8_000, closed_reason: 'removed', late: false,
    tracks: 1 + (i % 2), images: 0, preview: null, gps: i === 5 ? null : { lat: 54.0641 + i * 0.0004, lon: 44.9382 + i * 0.002 },
    verdict: ['unverified', 'true', 'false'][i % 3], verdict_note: null, verdict_at: null, frame_url: null,
}));
const MODBUS = {
    id: 'modbus', title: 'Modbus', transport: 'modbus', heartbeat_sec: 0, protocol_versions: [],
    connection: { connected: true, enabled: true, url: '/dev/ttyUSB0 @ 115200 8N1', error: '' },
    stats: { accepted: 0, undelivered: 0, messages: 0, detections: 0, images: 0, bytes: 0, heartbeats: 0, repeats: 0, rejected: 0, recent: [] },
    slave: { address: 19, device_id: 19, version: 1 }, master: { online: true, age_ms: 400 }, block: [],
    state: { registers: [{ addr: 0x1007, value: 1, label: 'работа', ok: true, code: 'ok', reason: [], error: '' }] },
    time: { synced: true, offset_ms: 0, unix_s: 0, age_ms: 0, updates: 0, invalid: 0 }, gps: { valid: true, lat: 0, lon: 0, age_ms: 0, invalid: 0 },
    queue: { total: 0, visible: 0, hidden: 0, window: 0, dropped: 0, next_number: 1, capacity: 1023, recent: [], head: null, last_mark: null },
    counters: { requests: 1273, broadcasts: 0, exceptions: 0, crc_errors: 0, garbage_bytes: 0, foreign: 0, foreign_last: 0, marks_ok: 0, marks_rejected: 0 },
    log: [],
};
const RULES = {
    id: 'kzt', title: 'КЖТ', description: '', modules: ['modbus'], context: 'c', saved_at: null, env: { late_s: 5, silence_s: 3, link_lost_s: 10 },
    settings: {
        stitch: { gap_s: 2, distance: 1 }, modbus: { enabled: true, period_s: 60 },
        table: { models: {}, camera_id: 'kzt_cam', zone_id: null, cargo_superclass: 'cargo', cargo: ['sleeper', 'wood-sleeper', 'barrel'], allowed: {} },
        dictionaries: { attachment: [{ number: 1, name: 'Грейферный ковш' }, { number: 6, name: 'Узкий грейфер' }] },
    },
};
RULES.defaults = RULES.settings;
const answer = (path) => {
    if (path === '/api/configurations/gateway/status') return { id: active, title: 'КЖТ', description: '', modules: [MODBUS] };
    if (path === '/api/configurations/kzt/rules') return RULES;
    if (path === '/api/configurations/link') return {
        active, rules: active, devices: [], master: { tracks: 0, open: 0, opened: 0, session: 0 },
        gateway: { connected: true, connected_at: NOW, lost_at: null, queue: 0, queue_max: 0, rejected: 0, address: '' },
        feed: [{ seq: 1, t: NOW, module: 'modbus', event: 'state', detection_id: 0, class_name: '', camera_id: 'kzt_cam', status: 'sent', attachments: [6], cargo: [1, 0, 0] }],
        counters: {},
    };
    if (path === '/api/time') return {
        unix_ms: Date.now(), unix_s: Math.floor(Date.now() / 1000), iso: '', tz_offset_min: 180,
        gps: { lat: 54.06609, lon: 44.95563, alt: 0, valid: true, sats: 9, speed: 0, course: 0 }, source: { time: 'modbus', gps: 'modbus' },
    };
    if (path === '/api/cameras') return { data: {
        cameras: { kzt_cam: { id: 'kzt_cam', display_name: 'КЖТ (видео)', description: '', ip_adress: '127.0.0.1', port: '8560', user: 'admin', password: '', production: 2, device_id: 'dev1',
            streams: { stream_1: { codec: 'h264', channel: 1, substream: 1, purposes: ['view', 'neural'], fps: 10, width: 1920, height: 1400, latency: 0, reconnect: 10, record_path: '', segment: 0, status: 3 } } } },
        virtual: [],
    } };
    if (path === '/api/devices') return { devices: [], routing: {} };
    if (path === '/api/journal/detections') return { detections: DETS, total: DETS.length, limit: 30, offset: 0 };
    if (path === '/api/journal/map/style.json') return { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0a0e16' } }] };
    return null;
};
const reply = (body) => body == null
    ? { responseCode: 404, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"detail":"mock"}').toString('base64') }
    : { responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') };

try {
    let targets;
    for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(250); } }
    ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
        if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
        if (d.method !== 'Fetch.requestPaused') return;
        const { requestId, request } = d.params;
        send('Fetch.fulfillRequest', { requestId, ...reply(answer(new URL(request.url).pathname)) });
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: `${UI}/api/*`, requestStage: 'Request' }, { urlPattern: `${UI}/d/*`, requestStage: 'Request' }] });
    await size(1920, 1080);
    await send('Page.navigate', { url: UI + '/kzt' });
    await waitFor('document.querySelectorAll(".kzs-dr").length >= 10', 'список обнаружений');
    await sleep(1500);

    await step('1920×1080: без прокрутки, видео по пропорциям кадра, пакет плитками', async () => {
        expect(await noScroll(), 'страница прокручивается');
        const v = await rect('.kzs-video');
        expect(Math.abs(v.w - v.h * 1920 / 1400) < 4, `видео ${Math.round(v.w)}×${Math.round(v.h)} не по пропорциям`);
        expect(await shown('.kzs-words') && !(await shown('.kzs-pkt')), 'пакет не плитками');
        expect((await ev('document.querySelector(".kzs-words").textContent')).includes('Узкий грейфер'), 'нет имени навесного из словаря');
        expect((await ev('document.querySelector(".kzs-mb .pill").textContent')).includes('на связи'), 'Modbus не на связи');
        expect((await ev('document.querySelector(".kzs-here").textContent')).includes('54.06609'), 'нет координат');
        await waitFor('!!document.querySelector(".kzs-geo-map .jm-here")', 'метка текущего места на мини-карте');
        await shot('1-fhd');
    });

    await step('1280×720: без прокрутки, пакет строкой, в списке видно три записи', async () => {
        await size(1280, 720);
        await sleep(600);
        expect(await noScroll(), 'страница прокручивается');
        expect(!(await shown('.kzs-words')) && await shown('.kzs-pkt'), 'пакет не строкой');
        const list = await rect('.kzs-rows');
        const fit = await ev(`Array.from(document.querySelectorAll('.kzs-dr')).filter(e => e.getBoundingClientRect().bottom <= ${list.y + list.h + 1}).length`);
        expect(fit >= 3, `видно ${fit} записей`);
        await shot('2-hd');
    });

    await step('1280×1024: обнаружения под видео во всю ширину с шапкой колонок', async () => {
        await size(1280, 1024);
        await sleep(600);
        expect(await noScroll(), 'страница прокручивается');
        const list = await rect('.kzs-list');
        const video = await rect('.kzs-video');
        expect(list.w > 1200 && list.y > video.y + video.h, 'список не под видео');
        expect(await shown('.kzs-jh'), 'нет шапки колонок');
        await shot('3-sxga');
    });

    await step('Карта разворачивается на всё поле с фиксациями и закрывается по Esc', async () => {
        await size(1920, 1080);
        await sleep(400);
        await ev('document.querySelector(".kzs-expand").click()');
        await waitFor('document.querySelectorAll(".kzs-cls").length >= 3', 'классы фиксаций');
        const over = await rect('.kzs-over');
        const body = await rect('.kzs-body');
        expect(Math.abs(over.w - body.w) < 2 && Math.abs(over.h - body.h) < 2, 'карта не на всё поле');
        await waitFor('!!document.querySelector(".kzs-over .jm-here")', 'метка текущего места на карте');
        expect(!(await ev('!!document.querySelector(".kzs-over .close")')), 'на карте остался свой крестик');
        expect(await ev('document.querySelector(".tr-bar").textContent.includes("карта открыта")'), 'шапка не показывает, что карта открыта');
        expect((await ev('document.querySelector(".tr-exit").getAttribute("aria-label")')) === 'Закрыть карту', 'крестик шапки не закрывает карту');
        expect((await ev('document.querySelector(".kzs-over .j-full").textContent')).includes('54.06609'), 'на карте нет текущего места');
        await shot('4-map');
        await ev('document.querySelector(".tr-exit").click()');
        await waitFor('!document.querySelector(".kzs-over")', 'карта закрыта крестиком шапки');
        await ev('document.querySelector(".kzs-expand").click()');
        await waitFor('!!document.querySelector(".kzs-over")', 'карта открыта снова');
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await waitFor('!document.querySelector(".kzs-over")', 'карта закрыта');
    });

    await step('Строка обнаружения открывает кадр', async () => {
        await ev('document.querySelector(".kzs-dr").click()');
        await waitFor('!!document.querySelector(".fv-modal")', 'просмотрщик кадра');
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await waitFor('!document.querySelector(".fv-modal")', 'просмотрщик закрыт');
    });

    await step('Телефон 390×844: столбиком, без разворота карты, без прокрутки', async () => {
        await size(390, 844, true);
        await send('Page.reload');
        await waitFor('document.querySelectorAll(".kzs-dr").length >= 10', 'список на телефоне');
        await sleep(800);
        expect(await noScroll(), 'страница прокручивается');
        const v = await rect('.kzs-video');
        const m = await rect('.kzs-mb');
        expect(m.y >= v.y + v.h, 'Modbus не под видео');
        expect(!(await ev('!!document.querySelector(".kzs-expand")')), 'есть разворот карты');
        await shot('5-phone');
    });

    await step('Без конфигурации КЖТ экран уходит на /translation', async () => {
        await size(1920, 1080);
        active = 'iskra';
        await waitFor('location.pathname === "/translation"', 'переход на трансляцию', 10000);
    });
} catch (failure) {
    results.push(false);
    console.log('✗ ' + failure.message);
    console.log(await ev('location.pathname + " · " + document.body.innerText.slice(0, 300).replace(/\\s+/g, " ")').catch(() => ''));
    errors.slice(0, 3).forEach((e) => console.log('  ' + String(e).split('\n').slice(0, 4).join(' | ')));
} finally {
    ws?.close();
    chrome.kill();
    const failed = results.filter((ok) => !ok).length;
    console.log(failed ? `kzt-screen-ui: ${failed} FAILED` : 'kzt-screen-ui: OK');
    process.exitCode = failed ? 1 : 0;
}
