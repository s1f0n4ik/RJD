// Правила КЖТ в «Конфигурации → Словари и соответствия»: состав, пакет из ленты, коды навесного, слоты, матрица и узкие экраны.
// Рабочая область активного профиля дополняется КЖТ в браузере, лента мастера подменяется; на бэкенд ничего не пишется.
// node kzt-rules-ui.mjs <ui url> [out dir для скриншотов]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [UI, OUT] = process.argv.slice(2);
const port = 9473;
const dir = mkdtempSync(join(tmpdir(), 'kztrules-'));
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
async function shot(name, height = 900) {
    if (!OUT) return;
    mkdirSync(OUT, { recursive: true });
    // Высокое окно вместо captureBeyondViewport: тот на миг сжимает окно, и приложение уходит в телефонную оболочку
    const width = await ev('innerWidth');
    await size(width, height);
    await sleep(400);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    await size(width);
}
const size = (width, height = 900) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
const text = (selector) => ev(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`);
const login = (role) => ev(`localStorage.setItem('token', 'e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, role, sub: 'e' })).toString('base64url')}.x'); localStorage.setItem('role','${role}'); localStorage.setItem('username','e'); true`);
// Таблица шире своей обёртки — уехала вбок
const overflow = (selector) => ev(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(e => e.scrollWidth > e.clientWidth + 1)`);

// Модель КЖТ: состояния навесного — суперклассы, грузы — суперкласс cargo
const CLASSES = [
    ['brush', ''], ['hydro-hammer', ''], ['sleeper', 'cargo'], ['barrel', 'cargo'], ['wood-sleeper', 'cargo'], ['rail', 'cargo'],
    ['base-bucket-empty', 'base-bucket'], ['base-bucket-load', 'base-bucket'], ['hook-empty', 'hook'], ['hook-load', 'hook'],
];
const MODEL = {
    name: 'КЖТ · yolo26 960', model_file: 'kzt.rknn',
    classes: Object.fromEntries(CLASSES.map(([name, superclass], i) => [i, { name, superclass }])),
    superclasses: { hook: { name: 'Крюк', color: '#a36621' }, 'base-bucket': { name: 'Ковш', color: '#ffff00' }, cargo: { name: 'Грузы', color: '#4dff00' } },
    zones: [{ id: 1, name: 'Рабочая зона', color: '#4c9bff' }, { id: 2, name: 'Обочина', color: '#f5a623' }],
};
const DICT = [[1, 'Грейферный ковш'], [2, 'Крюк'], [3, 'Щётка'], [4, 'Ковш'], [11, 'Гидромолот']].map(([number, name]) => ({ number, name }));
const RULES = {
    stitch: { gap_s: 2, distance: 1 },
    modbus: { enabled: true, period_s: 60 },
    table: {
        models: { 'kzt-model': { classes: { 0: 3, 1: 11 }, superclasses: { 0: 2, 1: 4 } } },
        camera_id: '', zone_id: 1, cargo_superclass: 'cargo', cargo: ['sleeper', 'wood-sleeper', 'barrel'], allowed: { 4: ['sleeper', 'barrel'] },
    },
    dictionaries: { attachment: DICT },
};
const LINK = {
    active: 'kzt', rules: 'kzt', devices: [], master: { tracks: 3, open: 3, opened: 3, session: 1 },
    gateway: { connected: true, connected_at: null, lost_at: null, queue: 0, queue_max: 0, rejected: 0, address: '' },
    feed: [{ seq: 1, t: Date.now(), module: 'modbus', event: 'state', detection_id: 0, class_name: '', camera_id: '', status: 'accepted', attachments: [4], cargo: [2, 0, 0] }],
    counters: {},
};

function patchWorkspace(workspace) {
    const put = (kind, key, body) => {
        (workspace.entities[kind] ??= {})[key] = { state: 'profile', body };
        (workspace.base[kind] ??= {})[key] = body;
    };
    const settings = workspace.entities.machine?.settings?.body ?? {};
    put('machine', 'settings', { ...settings, active_integration: 'kzt' });
    put('integration', 'kzt', { modules: { modbus: { enabled: false } } });
    put('rules', 'kzt', RULES);
    put('neural_config', 'kzt-model', MODEL);
    workspace.rules_defaults.kzt = RULES;
    return workspace;
}
const json = (body) => ({ responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });

try {
    let targets;
    for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(250); } }
    ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.onmessage = async (m) => {
        const d = JSON.parse(m.data);
        if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
        if (d.method !== 'Fetch.requestPaused') return;
        const { requestId, request, responseStatusCode } = d.params;
        const path = new URL(request.url).pathname;
        if (path === '/api/configurations/link') return send('Fetch.fulfillRequest', { requestId, ...json(LINK) });
        // Рабочая область: ответ бэкенда с КЖТ сверху
        if (responseStatusCode === 200 && path.endsWith('/workspace')) {
            const r = await send('Fetch.getResponseBody', { requestId });
            const raw = r.result.base64Encoded ? Buffer.from(r.result.body, 'base64').toString('utf8') : r.result.body;
            return send('Fetch.fulfillRequest', { requestId, ...json(patchWorkspace(JSON.parse(raw))) });
        }
        // Изменения на бэкенд не уходят
        if (request.method !== 'GET') { console.log('  blocked', request.method, path); return send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); }
        send('Fetch.continueRequest', { requestId });
    };
    await send('Page.enable');
    await send('Fetch.enable', { patterns: [
        { urlPattern: '*/api/configurations/link*' },
        { urlPattern: '*/workspace*', requestStage: 'Response' },
        { urlPattern: '*/api/config/*' },
    ] });
    await size(1440);
    await send('Page.navigate', { url: UI + '/app/' });
    await sleep(2500);
    await login('admin');
    // После входа приложение может один раз уйти на главную: заходим, пока раздел не устоит
    for (let i = 0; i < 4; i++) {
        if ((await ev('location.pathname')) !== '/app/configurations/mapping') await send('Page.navigate', { url: UI + '/app/configurations/mapping' });
        await waitFor(`!!document.querySelector('.kz-card')`, 'панель КЖТ', 40000).catch(() => {});
        await sleep(3000);
        if ((await ev('location.pathname')) === '/app/configurations/mapping' && (await ev(`!!document.querySelector('.kz-card')`))) break;
    }

    await step('Состав КЖТ: зона, суперкласс грузов, повтор пакета', async () => {
        const card = await text('.kz-card');
        expect(card.includes('Рабочая зона') && card.includes('Грузы') && card.includes('Все камеры'), 'карточка: ' + card);
        expect(await ev(`document.querySelector('.kz-card .tf-in').value`) === '60', 'повтор');
    });

    await step('Пакет сейчас: состав из ленты мастера', async () => {
        await waitFor(`document.querySelectorAll('.kz-w').length === 6`, 'слова пакета');
        const words = await ev(`Array.from(document.querySelectorAll('.kz-w')).map(w => w.querySelector('.v').textContent).join(',')`);
        expect(words === '4,0,0,2,0,0', 'слова: ' + words);
        expect((await text('.kz-w.is-att')).includes('Ковш'), 'название навесного');
        await shot('1-wide', 1500);
    });

    const section = `Array.from(document.querySelectorAll('.mt-model')).find(m => m.textContent.includes('КЖТ · yolo26'))`;
    await step('Коды навесного: грузы в слоты, состояния от суперкласса', async () => {
        await ev(`(() => { const m = ${section}; if (m.classList.contains('is-closed')) m.querySelector('.mt-mh').click(); return true; })()`);
        await waitFor(`!${section}.classList.contains('is-closed')`, 'секция КЖТ открыта');
        const rows = await ev(`${section}.textContent`);
        expect(rows.includes('слово 18') && rows.includes('слово 19') && rows.includes('не в слотах') && rows.includes('от суперкласса'), 'классы: ' + rows.slice(0, 300));
        expect(await ev(`${section}.querySelectorAll('.kz-cargo.is-sc').length`) === 1, 'суперкласс грузов без выбора кода');
        const outs = await ev(`Array.from(${section}.querySelectorAll('.mt-r.has-out:not(.is-head)')).map(r => r.querySelector('.mt-code').textContent).join(',')`);
        expect(outs === '3,11,—,—,—,—,4,4,2,2', 'коды: ' + outs);
    });

    await step('Матрица: строка «Любые грузы», первый клик — только этот груз', async () => {
        const free = await ev(`(() => { const r = Array.from(document.querySelectorAll('.kz-mx tbody tr')).find(t => t.textContent.includes('Щётка')); return r.className; })()`);
        expect(free.includes('is-free'), 'Щётка без ограничения');
        await ev(`Array.from(document.querySelectorAll('.kz-mx tbody tr')).find(t => t.textContent.includes('Щётка')).querySelectorAll('.kz-cb')[1].click(); true`);
        await sleep(300);
        const row = await ev(`(() => { const r = Array.from(document.querySelectorAll('.kz-mx tbody tr')).find(t => t.textContent.includes('Щётка')); return [r.className, r.querySelector('.kz-mode').textContent, r.querySelectorAll('.kz-cb.is-on').length]; })()`);
        expect(!row[0].includes('is-free') && row[1] === '1 из 4' && row[2] === 1, 'строка: ' + row.join(' | '));
        expect((await text('.cr-foot')).includes('Изменено'), 'черновик изменён');
    });

    for (const width of [1100, 920]) {
        await step(`Ширина ${width}: состав над пакетом, таблицы без прокрутки вбок`, async () => {
            await size(width);
            await sleep(500);
            const stacked = await ev(`(() => { const a = document.querySelector('.kz-card').getBoundingClientRect(); const b = document.querySelector('.kz-pkt').getBoundingClientRect(); return b.top >= a.bottom; })()`);
            expect(stacked, 'пакет не под составом');
            expect(!(await overflow('.mt-tab')), 'таблица классов прокручивается вбок');
            await shot(`2-w${width}`, 2600);
        });
    }
} catch (failure) {
    results.push(false);
    console.log('✗ ' + failure.message);
} finally {
    ws?.close();
    chrome.kill();
    const failed = results.filter((ok) => !ok).length;
    console.log(failed ? `kzt-rules-ui: ${failed} FAILED` : 'kzt-rules-ui: OK');
    process.exitCode = failed ? 1 : 0;
}
