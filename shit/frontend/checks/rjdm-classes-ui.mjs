// Конфигурация техзрения: модель .rjdm заменяет классы, голый .rknn возвращает свои, после сохранения отложенные забываются.
// Ручки /neural/* подменяются в браузере; на бэкенд ничего не пишется.
// node rjdm-classes-ui.mjs <ui url> [out dir для скриншотов]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [UI, OUT] = process.argv.slice(2);
const port = 9474;
const dir = mkdtempSync(join(tmpdir(), 'rjdmcls-'));
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
const login = (role) => ev(`localStorage.setItem('token', 'e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, role, sub: 'e' })).toString('base64url')}.x'); localStorage.setItem('role','${role}'); localStorage.setItem('username','e'); true`);

const cls = (name, superclass, color) => ({ name, server_id: '', superclass, color });
const OWN = {
    classes: { 0: cls('own-car', 'own', '#ff0000'), 1: cls('own-man', '', '#00ff00') },
    superclasses: { own: { name: 'Свои машины', color: '#ff0000' } },
};
const PACKAGE = {
    id: 'kzt', name: 'КЖТ из пакета', version: '1.2', description: '', author: 'voran', created_at: '', notes: '',
    task: 'detect', family: 'yolo26', target_platform: 'rk3588', toolkit_version: '2.3', quantized: true,
    input_width: 960, input_height: 960, input_channels: 3, output_layout: 'single', class_count: 3, weight_bytes: 8 << 20, weights_sha256: '',
    classes: { 0: cls('pkg-hook-empty', 'hook', '#a36621'), 1: cls('pkg-hook-load', 'hook', '#a36621'), 2: cls('pkg-brush', '', '#4dc4ee') },
    superclasses: { hook: { name: 'Крюк из пакета', color: '#a36621' } },
};
const MODELS = [
    { filename: 'old.rknn', path: '/models/old.rknn', size: 5 << 20 },
    { filename: 'kzt.rjdm', path: '/models/kzt.rjdm', size: 8 << 20, package: PACKAGE },
];
const THRESHOLDS = { nms: 0.45, confidence: 0.5, require_mask: true };
const configs = { cfg: { name: 'Своя', model_path: '/models/old.rknn', thresholds: THRESHOLDS, tracker: null, ...OWN } };
const saves = [];

const json = (body) => ({ responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
function neural(path, query, method, body) {
    const tail = path.slice(path.indexOf('/neural/'));
    if (tail === '/neural/configurations' && method === 'GET') {
        const cfgId = query.get('id');
        return cfgId ? configs[cfgId] : { configurations: Object.entries(configs).map(([key, c]) => ({ id: key, name: c.name })) };
    }
    if (tail.startsWith('/neural/configurations') && method === 'POST') {
        const { data } = JSON.parse(body);
        saves.push(data);
        Object.assign(configs, JSON.parse(JSON.stringify(data)));
        return { ok: true };
    }
    if (tail === '/neural/classes') return { config_id: query.get('config_id'), classes: [] };
    if (tail === '/neural/superclasses') return { config_id: query.get('config_id'), superclasses: [] };
    if (tail === '/neural/models') return MODELS;
    if (tail === '/neural/tracker-types') return { types: [{ type: 'iou', name: 'IoU' }] };
    if (tail === '/neural/state') return [];
    return method === 'GET' ? {} : null;
}

const pageText = () => ev(`(document.querySelector('.nv-stack')?.textContent ?? '') + Array.from(document.querySelectorAll('.nv-stack input')).map(i => ' ' + i.value).join('')`);
const has = async (...words) => { const t = await pageText(); return words.filter((w) => !t.includes(w)); };
const lacks = async (...words) => { const t = await pageText(); return words.filter((w) => t.includes(w)); };
const pickModel = async (filename) => {
    await ev(`document.querySelector('.nv-stack .uisel-btn').click(); true`);
    await waitFor(`!!document.querySelector('.uisel-pop [role=option]')`, 'список моделей');
    await ev(`Array.from(document.querySelectorAll('.uisel-pop [role=option]')).find(o => o.textContent.includes(${JSON.stringify(filename)})).click(); true`);
    await sleep(300);
};
const button = (label) => ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`);

try {
    let targets;
    for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(250); } }
    ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.onmessage = async (m) => {
        const d = JSON.parse(m.data);
        if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
        if (d.method !== 'Fetch.requestPaused') return;
        const { requestId, request, resourceType } = d.params;
        const u = new URL(request.url);
        if ((resourceType === 'Fetch' || resourceType === 'XHR') && u.pathname.includes('/neural/')) {
            const answer = neural(u.pathname, u.searchParams, request.method, request.postData ?? '{}');
            if (answer != null) return send('Fetch.fulfillRequest', { requestId, ...json(answer) });
        }
        // Изменения на бэкенд не уходят
        if (request.method !== 'GET') { console.log('  blocked', request.method, u.pathname); return send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); }
        send('Fetch.continueRequest', { requestId });
    };
    await send('Page.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: UI + '/app/' });
    await sleep(2500);
    await login('admin');
    const target = '/app/neural/configs';
    for (let i = 0; i < 4; i++) {
        if ((await ev('location.pathname')) !== target) await send('Page.navigate', { url: UI + target + '?config=cfg' });
        await waitFor(`(document.querySelector('.nv-stack')?.innerText ?? '').includes('own-car')`, 'конфигурация', 30000).catch(() => {});
        await sleep(1500);
        if ((await ev('location.pathname')) === target && (await has('own-car')).length === 0) break;
    }

    await step('Открыта своя конфигурация с old.rknn', async () => {
        const miss = await has('own-car', 'own-man', 'Свои машины');
        expect(miss.length === 0, `нет: ${miss.join(', ')} на ${await ev('location.href')}: ${(await ev('document.body.innerText')).slice(0, 300)}`);
    });

    await step('Выбор .rjdm заменяет классы и суперклассы, описание модели из манифеста', async () => {
        await pickModel('kzt.rjdm');
        const miss = await has('pkg-hook-empty', 'pkg-hook-load', 'pkg-brush', 'Крюк из пакета', 'классы из модели', '960×960');
        expect(miss.length === 0, 'нет: ' + miss.join(', '));
        const left = await lacks('own-car', 'own-man', 'Свои машины');
        expect(left.length === 0, 'остались: ' + left.join(', '));
        expect(await ev(`document.querySelector('.tf-in:not(.is-ro)').value`) === 'Своя', 'название не трогается');
        await shot('1-rjdm');
    });

    await step('Возврат на .rknn возвращает свои классы', async () => {
        await pickModel('old.rknn');
        const miss = await has('own-car', 'own-man', 'Свои машины');
        expect(miss.length === 0, 'нет: ' + miss.join(', '));
        const left = await lacks('pkg-hook-empty', 'Крюк из пакета');
        expect(left.length === 0, 'остались: ' + left.join(', '));
    });

    await step('Повторный .rjdm и снова .rknn: свои не потерялись', async () => {
        await pickModel('kzt.rjdm');
        expect((await has('pkg-brush')).length === 0, 'нет классов пакета');
        await pickModel('old.rknn');
        expect((await has('own-car', 'Свои машины')).length === 0, 'свои не вернулись');
    });

    await step('Отмена правок: черновик как сохранён, отложенное забыто', async () => {
        await pickModel('kzt.rjdm');
        expect(await button('Отменить'), 'кнопка «Отменить»');
        await sleep(300);
        expect((await has('own-car')).length === 0, 'после отмены свои классы на месте');
        await pickModel('old.rknn');
        expect((await has('own-car')).length === 0, 'свои на месте');
    });

    await step('Сохранение с .rjdm: после него .rknn оставляет классы из модели', async () => {
        await pickModel('kzt.rjdm');
        expect(await button('Сохранить'), 'кнопка «Сохранить»');
        await waitFor(`!Array.from(document.querySelectorAll('button')).some(x => x.textContent.includes('Сохранение'))`, 'сохранение');
        await sleep(500);
        expect(saves.length === 1 && saves[0].cfg?.model_path === '/models/kzt.rjdm', 'ушло: ' + JSON.stringify(saves.map((s) => Object.keys(s))));
        expect(Object.values(saves[0].cfg.classes).some((c) => c.name === 'pkg-brush'), 'сохранены не классы пакета');
        await pickModel('old.rknn');
        const miss = await has('pkg-hook-empty', 'pkg-brush', 'Крюк из пакета');
        expect(miss.length === 0, 'нет: ' + miss.join(', '));
        expect((await lacks('own-car')).length === 0, 'вернулись отложенные до сохранения');
    });

    await step('Новая конфигурация: .rjdm заполняет классы и название, .rknn очищает', async () => {
        expect(await button('Отменить'), 'отмена правки');
        await sleep(300);
        expect(await button('Новая конфигурация'), 'кнопка новой конфигурации');
        await waitFor(`(document.querySelector('.nv-body h2')?.textContent ?? '').includes('Новая')`, 'новая конфигурация');
        await pickModel('kzt.rjdm');
        expect((await has('pkg-hook-empty', 'Крюк из пакета')).length === 0, 'классы пакета');
        expect(await ev(`Array.from(document.querySelectorAll('.tf-in')).some(i => i.value === 'КЖТ из пакета')`), 'название из пакета');
        await shot('2-new');
        await pickModel('old.rknn');
        expect((await lacks('pkg-hook-empty', 'Крюк из пакета')).length === 0, 'классы пакета остались');
    });
} catch (failure) {
    console.log('✗ сбой:', failure.message);
    results.push(false);
} finally {
    ws?.close();
    chrome.kill();
}
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length}`);
process.exit(passed === results.length && results.length > 0 ? 0 : 1);
