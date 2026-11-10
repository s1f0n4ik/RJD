// Экран «Камеры»: панель на состоянии, правка кнопкой, поля назначений, колонки на узком экране, кэш сканирования, телефон.
// Ответы /api/cameras, /api/layouts и /api/scan/* подменяются в браузере, остальное идёт на бэкенд интерфейса (только чтение).
// node cameras-drawer-ui.mjs <ui url> [out dir для скриншотов]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [UI, OUT] = process.argv.slice(2);
const port = 9471;
const dir = mkdtempSync(join(tmpdir(), 'camdrawer-'));
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
const viewport = (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });

// Что прислали бы платы: потоки разного состояния
const stream = (n, status, purposes, error, extra = {}) => ({
    status, purposes, codec: 'H264', width: status === 3 ? 1920 : 0, height: status === 3 ? 1080 : 0, fps: status === 3 ? 25 : 0,
    channel: 1, substream: n, latency: 0, reconnect: 10, record_path: purposes.includes('record') ? '/storage/internal' : '', segment: purposes.includes('record') ? 600 : 0,
    rtsp: `rtsp://10.0.0.1/s${n}`, use_udp: false, ...(error ? { error: { code: error, since: Date.now() - 3600000, attempts: 12 } } : {}), ...extra,
});
const camera = (n, ip, streams, extra = {}) => ({ id: `cam_${n}`, display_name: `Камера ${n}`, ip_adress: ip, port: '554', user: 'admin', password: 'p', production: 2, description: 'Образец', device_id: 'dev', device_name: 'Плата', streams, ...extra });
const CAMERAS = {
    cam_ok: camera('ok', '10.0.0.2', { stream_1: stream(1, 3, ['view', 'record', 'neural']), stream_2: stream(2, 3, ['view']) }),
    cam_away: camera('away', '10.0.0.3', { stream_1: stream(1, 1, ['view'], 3007) }),
    cam_mix: camera('mix', '10.0.0.4', { stream_1: stream(1, 3, ['view']), stream_2: stream(2, 1, ['record'], 3003) }),
    cam_off: camera('off', '10.0.0.5', { stream_1: stream(1, 3, ['view']) }, { offline: true }),
    cam_rtp: camera('rtp', '10.0.0.6', { stream_1: stream(1, 3, ['view', 'rtp'], 0, { rtp: { host: '203.0.113.7', port: 5004, mode: 'copy', width: 0, height: 0, bitrate: 0, qp_max: 0 } }) }),
};
const LAYOUT = { name: 'cam-test', gridSize: 4, activeCells: { 0: 'cam_ok' }, timestamp: 1 };
const json = (body, headers = {}) => ({ responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, ...Object.entries(headers).map(([name, value]) => ({ name, value }))], body: Buffer.from(JSON.stringify(body)).toString('base64') });
const sse = (messages) => ({ responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }], body: Buffer.from(messages.map((m) => `data: ${JSON.stringify(m)}\n\n`).join('')).toString('base64') });

// Находки сканирования: 10.0.0.2 уже в системе, 10.0.0.50 и 10.0.0.9 свободны
const SCAN = [
    { stage: 'onvif_start' },
    { stage: 'onvif_done', cameras: [{ ip: '10.0.0.50', port: 80, name: 'DS-2CD' }, { ip: '10.0.0.2', port: 80, name: 'DS-2CD' }] },
    { stage: 'ports_start', total: 254 },
    { stage: 'ports_progress', scanned: 254, total: 254, subnet: '10.0.0.', found: [{ ip: '10.0.0.9', open_ports: [554], has_rtsp: true }] },
    { stage: 'done' },
];
let scanRuns = 0;

const text = (selector) => ev(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`);
const count = (selector) => ev(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const rowOf = (name) => `Array.from(document.querySelectorAll('.cam-row')).find(r => r.textContent.includes(${JSON.stringify(name)}))`;
const clickRow = (name) => ev(`${rowOf(name)}.click(); true`);
const clickButton = (selector, label) => ev(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(b => b.textContent.includes(${JSON.stringify(label)})).click(); true`);
const login = (role) => ev(`localStorage.setItem('token', 'e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, role, sub: 'e' })).toString('base64url')}.x'); localStorage.setItem('role','${role}'); localStorage.setItem('username','e'); true`);
// Ни одна видимая ячейка строки не наезжает на соседнюю и не выходит за область списка
const noOverlap = () => ev(`(() => {
    const box = document.querySelector('.cams-scroll').getBoundingClientRect();
    for (const row of document.querySelectorAll('.cam-row, .cam-head')) {
        const cells = Array.from(row.children).filter(c => getComputedStyle(c).display !== 'none').map(c => c.getBoundingClientRect());
        for (let i = 1; i < cells.length; i++) if (cells[i].left < cells[i - 1].right - 1) return 'overlap ' + row.textContent.slice(0, 30);
        if (cells.length && cells[cells.length - 1].right > box.right + 1) return 'outside ' + row.textContent.slice(0, 30);
    }
    return 'ok';
})()`);

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
        if (request.method === 'GET' && path === '/api/layouts') answer = json([LAYOUT], { 'X-Profile-Id': 'p', 'X-Layout-Context': 'c', 'X-Profile-Phase': 'complete' });
        if (request.method === 'GET' && path === '/api/scan/subnets') answer = json([{ prefix: '10.0.0.', address: '10.0.0.5', iface: 'eth0' }]);
        if (request.method === 'GET' && path === '/api/scan/stream') {
            // Второй поиск идёт долго: видно индикацию поверх прошлого результата
            scanRuns += 1;
            answer = sse(SCAN);
            delay = scanRuns >= 2 ? 2500 : 0;
        }
        if (answer) setTimeout(() => send('Fetch.fulfillRequest', { requestId, ...answer }), delay);
        else send('Fetch.continueRequest', { requestId });
    };
    await send('Page.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/cameras*' }, { urlPattern: '*/api/layouts*' }, { urlPattern: '*/api/scan/*' }] });
    await viewport(1440, 900);
    await send('Page.navigate', { url: UI + '/app/' });
    await sleep(2500);
    await login('admin');

    await send('Page.navigate', { url: UI + '/app/cameras' });
    await waitFor(`document.querySelectorAll('.cam-row').length >= 4`, 'строки камер');
    await sleep(500);

    await step('Панель открывается на состоянии: полоса, модули, карточки потоков, без полей', async () => {
        await clickRow('Камера ok');
        await waitFor(`!!document.querySelector('.cd-drawer .cd-sc')`, 'панель');
        await sleep(400);
        expect((await text('.cd-sum')).includes('в работе'), 'нет состояния в полосе: ' + await text('.cd-sum'));
        expect(await count('.cd-sec') === 2, 'модулей должно быть два');
        expect(await count('.cd-sc') === 2, 'карточек потоков должно быть две');
        expect(await count('.cd-drawer input') === 0, 'в просмотре не должно быть полей');
        expect(await count('.cd-prev .uisel') === 1, 'при нескольких просматриваемых потоках нужен селект');
        expect(await count('.cd-pst > div') === 4, 'таблица статистики должна быть из четырёх ячеек');
        const widths = await ev(`(() => { const p = document.querySelector('.cd-prev').getBoundingClientRect(); const w = (e) => Math.round(document.querySelector(e).getBoundingClientRect().width); return [w('.cd-prev .cam-preview'), w('.cd-prev .uisel'), w('.cd-pst')].map(x => Math.round(p.width - 28 - x)); })()`);
        expect(widths.every((d) => Math.abs(d) <= 2), 'превью, селект и таблица должны быть одной ширины: ' + widths);
        expect(await count('.cd-drawer .drawer-f') === 0, 'в просмотре нет подвала');
        await shot('1-state');
    });

    await step('Причина сбоя в карточке: подпись, время и число попыток', async () => {
        await clickRow('Камера mix');
        await waitFor(`document.querySelectorAll('.cd-fault').length === 1`, 'блок сбоя');
        const fault = await text('.cd-fault');
        expect(fault.includes('ошибка пароля') && fault.includes('попыток 12'), 'сбой: ' + fault);
        expect((await text('.cd-sum')).includes('частично'), 'полоса: ' + await text('.cd-sum'));
        await shot('2-fault');
    });

    await step('Правка включается кнопкой «Изменить», «Отмена» возвращает просмотр', async () => {
        await clickRow('Камера ok');
        await waitFor(`!!document.querySelector('.cd-drawer .cd-sc')`, 'панель');
        await clickButton('.cd-drawer .drawer-h button', 'Изменить');
        await waitFor(`!!document.querySelector('.cd-edit')`, 'режим правки');
        expect(await count('.cd-editbar') === 1, 'нет полосы режима правки');
        expect(await ev(`Array.from(document.querySelectorAll('.drawer-f button')).find(b => b.textContent.includes('Применить')).disabled`), 'Применить доступно без правок');
        await shot('3-edit');
        await clickButton('.drawer-f button', 'Отмена');
        await waitFor(`!document.querySelector('.cd-edit')`, 'возврат в просмотр');
    });

    await step('Поля записи появляются при включении роли; у ролей без полей блока нет', async () => {
        await clickButton('.cd-drawer .drawer-h button', 'Изменить');
        await waitFor(`document.querySelectorAll('.cd-edit').length === 2`, 'правка');
        // у потока 2 только «Просмотр»: блока полей нет
        const before = await ev(`document.querySelectorAll('.cd-sc')[1].querySelectorAll('.cd-role').length`);
        expect(before === 0, 'у потока с просмотром не должно быть блока полей');
        await ev(`Array.from(document.querySelectorAll('.cd-sc')[1].querySelectorAll('.purp-btn')).find(b => b.textContent.includes('Запись')).click(); true`);
        await waitFor(`document.querySelectorAll('.cd-sc')[1].querySelectorAll('.cd-role--record').length === 1`, 'блок записи');
        const path = await ev(`document.querySelectorAll('.cd-sc')[1].querySelector('.cd-role--record input').value`);
        expect(path === '/storage/internal', 'путь записи по умолчанию: ' + path);
        await ev(`Array.from(document.querySelectorAll('.cd-sc')[1].querySelectorAll('.purp-btn')).find(b => b.textContent.includes('Тех. зрение')).click(); true`);
        await sleep(200);
        expect(await ev(`document.querySelectorAll('.cd-sc')[1].querySelectorAll('.cd-role').length`) === 1, 'тех. зрение не должно давать блок');
        await ev(`document.querySelector('.drawer-b').scrollTop = 99999; true`);
        await sleep(300);
        await shot('4-roles');
        await clickButton('.drawer-f button', 'Отмена');
    });

    await step('Роль RTP: сводка в просмотре, в правке адрес и порт, «Перекодировать» открывает кадр, битрейт и сжатие', async () => {
        await clickRow('Камера rtp');
        await waitFor(`!!document.querySelector('.cd-drawer .cd-sc')`, 'панель');
        const summary = await text('.cd-sc-rec');
        expect(summary.includes('203.0.113.7:5004') && summary.includes('без перекодирования'), 'сводка RTP: ' + summary);
        await clickButton('.cd-drawer .drawer-h button', 'Изменить');
        await waitFor(`document.querySelectorAll('.cd-role--rtp').length === 1`, 'блок RTP');
        expect(await count('.cd-role--rtp input') === 2, 'в режиме «Как есть» должно быть два поля');
        await clickButton('.cd-role--rtp .seg--xs button', 'Перекодировать');
        await waitFor(`document.querySelectorAll('.cd-role--rtp input').length === 6`, 'поля перекодирования');
        await ev(`document.querySelector('.drawer-b').scrollTop = 99999; true`);
        await sleep(300);
        await shot('4b-rtp');
        await clickButton('.drawer-f button', 'Отмена');
    });

    await step('Наблюдатель видит панель со статистикой, но без кнопки правки', async () => {
        await login('viewer');
        await send('Page.navigate', { url: UI + '/app/cameras' });
        await waitFor(`document.querySelectorAll('.cam-row').length >= 4`, 'строки камер');
        await clickRow('Камера ok');
        await waitFor(`!!document.querySelector('.cd-drawer .cd-sc')`, 'панель наблюдателя');
        expect(!(await ev(`!!Array.from(document.querySelectorAll('.cd-drawer .drawer-h button')).find(b => b.textContent.includes('Изменить'))`)), 'у наблюдателя есть «Изменить»');
        await login('admin');
    });

    await step('Узкий экран: колонки уходят, ничто не перекрывается ни с панелью, ни без неё', async () => {
        await send('Page.navigate', { url: UI + '/app/cameras' });
        await waitFor(`document.querySelectorAll('.cam-row').length >= 4`, 'строки камер');
        for (const width of [1440, 1280, 1024]) {
            await viewport(width, 900);
            await sleep(400);
            await clickRow('Камера ok');
            await waitFor(`!!document.querySelector('.cd-drawer .cd-sc')`, 'панель');
            await sleep(500);
            const verdict = await noOverlap();
            expect(verdict === 'ok', `${width}: ${verdict}`);
            const tableCheck = await ev(`(() => { const t = document.querySelector('.stab'); if (!t) return 'нет таблицы'; const box = t.getBoundingClientRect(); const cells = Array.from(t.querySelectorAll('thead tr > *')).filter(c => getComputedStyle(c).display !== 'none').map(c => c.getBoundingClientRect()); for (let i = 1; i < cells.length; i++) if (cells[i].left < cells[i - 1].right - 1) return 'overlap ' + i + ' ' + cells.map(c => Math.round(c.left) + '-' + Math.round(c.right)).join(' '); return cells.length && cells[cells.length - 1].right <= box.right + 1 ? 'ok' : 'outside'; })()`);
            expect(tableCheck === 'ok', `${width}, таблица потоков: ${tableCheck}`);
            await shot(`5-width-${width}`);
            await clickRow('Камера ok');
            await sleep(400);
        }
        await viewport(1440, 900);
    });

    await step('Сканирование: свободные сверху, добавленные ниже после разделителя «Уже в системе»', async () => {
        await clickButton('.filters button', 'Сканировать сеть');
        await waitFor(`document.querySelectorAll('.scan-row').length === 3 && !document.querySelector('.scan-sync')`, 'результат');
        const order = await ev(`Array.from(document.querySelectorAll('.scan-list > *')).map(e => e.className.includes('scan-sep') ? '|' : e.querySelector?.('.addr')?.textContent ?? '').join(',')`);
        expect(order === '10.0.0.9,10.0.0.50,|,10.0.0.2', 'порядок: ' + order);
        await shot('6-scan-first');
        await clickButton('.modal button, .scan-side button', 'Закрыть');
        await waitFor(`!document.querySelector('.scan-modal')`, 'закрытие окна');
    });

    await step('Сканирование: при повторном открытии прошлый результат виден сразу, поиск показан индикацией', async () => {
        await clickButton('.filters button', 'Сканировать сеть');
        await waitFor(`document.querySelectorAll('.scan-row').length === 3`, 'строки из кэша');
        await waitFor(`!!document.querySelector('.scan-sync')`, 'индикация поиска');
        expect((await text('.scan-old')).includes('прошлый поиск'), 'нет подписи про прошлый поиск');
        await shot('7-scan-cached');
        await waitFor(`!document.querySelector('.scan-sync')`, 'конец поиска', 10000);
        expect(await count('.scan-row') === 3, 'после поиска строк должно быть три');
        expect(await count('.scan-old') === 0, 'подпись про прошлый поиск должна уйти');
        await clickButton('.scan-side button', 'Закрыть');
    });

    await step('Телефон: нажатие раскрывает состояние и потоки, повторное сворачивает (камеры стенда по сокету)', async () => {
        await viewport(390, 844, true);
        await send('Page.navigate', { url: UI + '/app/cameras' });
        await waitFor(`document.querySelectorAll('.m-li .m-chev').length >= 1`, 'строки камер на телефоне');
        await sleep(500);
        await ev(`document.querySelector('.m-li .m-chev').closest('.m-li').click(); true`);
        await waitFor(`!!document.querySelector('.m-cd .cd-sc')`, 'раскрытие');
        expect(await ev(`document.querySelectorAll('.m-cd .cd-sc').length`) >= 1, 'нет потоков в раскрытии');
        expect(await count('.m-cd .st') >= 1, 'нет состояния в раскрытии');
        await sleep(400);
        await shot('8-mobile-open');
        await ev(`document.querySelector('.m-li.is-open').click(); true`);
        await waitFor(`!document.querySelector('.m-cd')`, 'сворачивание');
    });
} catch (failure) {
    results.push(false);
    console.log(`✗ прогон прерван: ${failure.message}`);
} finally {
    ws?.close();
    chrome.kill();
}
const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? `\nВсе проверки пройдены: ${results.length}` : `\nНе прошло: ${failed} из ${results.length}`);
process.exit(failed === 0 ? 0 : 1);
