// Камера на плате в «Камерах»: адрес в списке, шторка, правка, мастер с камерами платы и их состояниями.
// Ответы /api/cameras и /d/*/mc/camera/local подменяются в браузере, остальное идёт на бэкенд интерфейса (только чтение).
// node local-camera-ui.mjs <ui url> [out dir для скриншотов]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [UI, OUT] = process.argv.slice(2);
const port = 9472;
const dir = mkdtempSync(join(tmpdir(), 'localcam-'));
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

const USB = '/dev/v4l/by-path/platform-fc000000.usb-usb-0:1.2:1.0-video-index0';
const stream = (purposes) => ({
    status: 3, purposes, codec: 'H264', width: 1280, height: 720, fps: 30, channel: 1, substream: 1, latency: 0, reconnect: 10,
    record_path: purposes.includes('record') ? '/storage/internal' : '', segment: purposes.includes('record') ? 600 : 0, rtsp: '', use_udp: false,
});
const CAMERAS = {
    cam_net: { id: 'cam_net', display_name: 'Передняя', ip_adress: '10.0.0.2', port: '554', user: 'admin', password: 'p', production: 2, description: '', device_id: 'dev', device_name: 'Плата', streams: { stream_1: stream(['view']) } },
    cam_usb: {
        id: 'cam_usb', display_name: 'Камера у кабины', ip_adress: '', port: '', user: '', password: '', production: 0, description: 'Образец', device_id: 'dev', device_name: 'Плата',
        source: 'v4l2', v4l2: { device: USB, format: 'MJPG', width: 1280, height: 720, fps: 30, rotation: 0, swap_uv: false, bitrate: 0, gop: 1 },
        streams: { stream_1: stream(['view', 'record']) },
    },
};
const RANGE = { min_width: 32, max_width: 3280, step_width: 8, min_height: 32, max_height: 2464, step_height: 8 };
const LOCAL = [
    { device: USB, node: '/dev/video21', name: 'HD USB Camera', kind: 'usb', sensor: '', used_by: 'cam_usb', formats: [
        { format: 'MJPG', sizes: [{ width: 1920, height: 1080, fps: [30, 15] }, { width: 1280, height: 720, fps: [60, 30] }] },
        { format: 'YUYV', sizes: [{ width: 640, height: 480, fps: [30] }] },
    ] },
    { device: '/dev/v4l/by-path/platform-fc400000.usb-usb-0:1:1.0-video-index0', node: '/dev/video23', name: 'USB 2.0 Camera', kind: 'usb', sensor: '', used_by: 'camera_7', formats: [{ format: 'YUYV', sizes: [{ width: 640, height: 480, fps: [30] }] }] },
    { device: 'rkisp_mainpath', node: '/dev/video0', name: 'rkisp_mainpath', kind: 'csi', sensor: 'IMX219', used_by: null, formats: [{ format: 'UYVY', range: RANGE }, { format: 'NV12', range: RANGE }] },
];
// Ответ списка камер платы: камеры, ошибка или долгий опрос
let localMode = 'filled';
const json = (body, code = 200) => ({ responseCode: code, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });

const text = (selector) => ev(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`);
const count = (selector) => ev(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const clickText = (selector, label) => ev(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(b => b.textContent.includes(${JSON.stringify(label)})).click(); true`);
const login = (role) => ev(`localStorage.setItem('token', 'e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, role, sub: 'e' })).toString('base64url')}.x'); localStorage.setItem('role','${role}'); localStorage.setItem('username','e'); true`);
// Ширина полей мастера: полоса прокрутки не должна её отнимать
const paneWidth = () => ev(`(() => { const m = document.querySelector('.add-main'); return m ? [m.offsetWidth - m.clientWidth, Math.round(m.querySelector('.add-row').getBoundingClientRect().width)] : null; })()`);

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
        let delay = 0;
        if (request.method === 'GET' && path === '/api/cameras') answer = json({ data: { cameras: CAMERAS, virtual: [], conflicts: {} } });
        if (request.method === 'GET' && path.endsWith('/mc/camera/local')) {
            if (localMode === 'error') answer = json({ data: null, meta: null, error: { code: 502, message: 'Device unreachable' } }, 502);
            else answer = json({ data: { cameras: localMode === 'empty' ? [] : LOCAL } });
            delay = localMode === 'loading' ? 60000 : 0;
        }
        if (answer) setTimeout(() => send('Fetch.fulfillRequest', { requestId, ...answer }).catch(() => {}), delay);
        else send('Fetch.continueRequest', { requestId });
    };
    await send('Page.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/cameras*' }, { urlPattern: '*/mc/camera/local*' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: UI + '/app/' });
    await sleep(2500);
    await login('admin');
    await send('Page.navigate', { url: UI + '/app/cameras' });
    await waitFor(`document.querySelectorAll('.cam-row').length >= 2`, 'строки камер');
    await sleep(500);

    await step('Список: колонка «Адрес», у камеры на плате «USB 1.2»', async () => {
        expect((await text('.cam-head .c-ip')) === 'Адрес', 'заголовок: ' + await text('.cam-head .c-ip'));
        const address = await ev(`Array.from(document.querySelectorAll('.cam-row')).find(r => r.textContent.includes('Камера у кабины')).querySelector('.c-ip').textContent`);
        expect(address === 'USB 1.2', 'адрес: ' + address);
    });

    await step('Шторка: источник и режим вместо адреса и логина, у потока нет задержки и RTSP', async () => {
        await ev(`Array.from(document.querySelectorAll('.cam-row')).find(r => r.textContent.includes('Камера у кабины')).click(); true`);
        await waitFor(`!!document.querySelector('.cd-kv')`, 'шторка');
        await sleep(400);
        const kv = await text('.cd-kv');
        expect(kv.includes('USB 1.2') && kv.includes('MJPG 1280×720, 30 к/с') && kv.includes('авто'), 'сведения: ' + kv);
        expect(!kv.includes('Порт RTSP') && !kv.includes('Логин'), 'остались поля сетевой камеры');
        const card = await text('.cd-sc');
        expect(!card.includes('Задержка') && !card.includes('субпоток'), 'карточка потока: ' + card);
        await shot('1-drawer');
    });

    await step('Правка: камера платы и режим, без IP, без добавления и удаления потока', async () => {
        await clickText('.cd-drawer button', 'Изменить');
        await waitFor(`!!document.querySelector('.cd-drawer .lc-grid')`, 'поля режима');
        await sleep(400);
        const fields = await text('.cd-sec--cam');
        expect(fields.includes('Камера платы') && fields.includes('Формат') && fields.includes('Опорный кадр'), 'поля: ' + fields);
        expect(!fields.includes('IP-адрес') && !fields.includes('Производитель'), 'остались поля сетевой камеры');
        expect(!(await text('.cd-sec--str .cd-sec-h')).includes('Добавить'), 'кнопка добавления потока');
        expect(!(await text('.cd-sec--str')).includes('Удалить поток'), 'кнопка удаления потока');
        await shot('2-edit');
        await clickText('.cd-drawer .drawer-f button', 'Отмена');
        await sleep(300);
    });

    await step('Мастер: «На плате» показывает камеры платы, занятая выключена, CSI с моделью сенсора', async () => {
        await clickText('button', 'Добавить камеру');
        await waitFor(`!!document.querySelector('.add-modal')`, 'мастер');
        await clickText('.add-modal .seg button', 'На плате');
        await waitFor(`document.querySelectorAll('.lc-item').length === 3`, 'камеры платы');
        expect(await count('.lc-item:disabled') === 2, 'занятых должно быть две: своя камера в мастере тоже занята');
        const csi = await ev(`Array.from(document.querySelectorAll('.lc-item')).find(i => i.textContent.includes('CSI')).querySelector('.n').innerHTML`);
        expect(csi.includes('seps') && csi.includes('lc-sensor') && csi.includes('IMX219'), 'подпись CSI: ' + csi);
        expect(await count('.add-modal .lc-grid') === 0, 'режим до выбора камеры не показывается');
        await shot('3-wizard-list');
    });

    await step('Мастер: выбор CSI открывает режим, поток и превью; YUYV/UYVY крутится только на 180', async () => {
        await ev(`Array.from(document.querySelectorAll('.lc-item')).find(i => i.textContent.includes('CSI')).click(); true`);
        await waitFor(`!!document.querySelector('.add-modal .lc-grid')`, 'поля режима');
        const modal = await text('.add-modal');
        expect(modal.includes('Режим') && modal.includes('Кодирование') && modal.includes('Поток'), 'блоки: ' + modal.slice(0, 200));
        expect(modal.includes('32…3280'), 'диапазон ISP не показан');
        const disabled = await ev(`Array.from(document.querySelectorAll('.add-modal .lc-seg button:disabled')).map(b => b.textContent).join(',')`);
        expect(disabled === '90°,270°', 'выключенные углы UYVY на CSI: ' + disabled);
        expect((await text('.add-side')).includes('режим есть у камеры'), 'проверка режима слева: ' + await text('.add-side'));
        await shot('4-wizard-csi');
    });

    await step('Мастер: полоса прокрутки не отнимает ширину при смене состояний', async () => {
        const filled = await paneWidth();
        localMode = 'error';
        await clickText('.add-modal button', 'Обновить');
        await waitFor(`!!document.querySelector('.lc-state.is-err')`, 'ошибка платы');
        const error = await paneWidth();
        expect(filled[0] === 0 && error[0] === 0 && filled[1] === error[1], `ширина: ${filled} / ${error}`);
        expect((await text('.lc-state.is-err')).includes('Device unreachable'), 'текст ошибки: ' + await text('.lc-state.is-err'));
        await shot('5-wizard-error');
        localMode = 'empty';
        await clickText('.add-modal button', 'Обновить');
        await waitFor(`(document.querySelector('.lc-state')?.textContent ?? '').includes('нет камер')`, 'пусто');
        await shot('6-wizard-empty');
        localMode = 'loading';
        await clickText('.add-modal button', 'Обновить');
        await waitFor(`!!document.querySelector('.lc-state .spin')`, 'опрос');
        await shot('7-wizard-loading');
    });
} catch (failure) {
    results.push(false);
    console.log('✗ проверка прервана: ' + failure.message);
} finally {
    ws?.close();
    chrome.kill();
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} из ${results.length} не прошли` : `все ${results.length} прошли`);
process.exit(failed ? 1 : 0);
