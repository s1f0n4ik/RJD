// Сценарий экрана «Конфигурации» в headless Chrome против живого мастера.
// node profile-switch-ui.mjs <фаза a|b> <папка профилей> <папка вывода> [python для сверки zip]
// RJD_FROM=<часть названия шага> начинает прогон с этого шага. Адрес берётся из RJD_UI (по умолчанию http://localhost:3000); экран действует только кликами, проверки — по API мастера.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

const [PHASE = 'a', PROFILES_DIR, OUT, PYTHON = 'python'] = process.argv.slice(2);
if (!PROFILES_DIR || !OUT) throw new Error('usage: profile-switch-ui.mjs <a|b> <profiles folder> <output folder> [python]');
const UI = process.env.RJD_UI || 'http://localhost:3000';
const CHROME = process.env.RJD_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const RSM = 'test-rsm-2000';
const ISKRA = 'test-iskra';
const MODULE_NAMES = { websocket: 'WebSocket', can: 'CAN', modbus: 'Modbus RTU' };
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const isFree = (port) => new Promise((done) => { const server = net.createServer(); server.once('error', () => done(false)); server.listen(port, '127.0.0.1', () => server.close(() => done(true))); });
let port = 9471;
while (!(await isFree(port))) port++;
const profileDir = mkdtempSync(join(tmpdir(), 'rjd-ui-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--window-size=1440,1000', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} try { rmSync(profileDir, { recursive: true, force: true }); } catch {} });
let target;
for (let i = 0; i < 60 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page'); } catch {}
}
if (!target) throw new Error('chrome did not start');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((done) => socket.addEventListener('open', done, { once: true }));
let sequence = 0;
const pending = new Map();
const consoleErrors = [];
socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
});
const send = (method, params = {}) => new Promise((resolveSend, reject) => { const id = ++sequence; pending.set(id, { resolve: resolveSend, reject }); socket.send(JSON.stringify({ id, method, params })); });
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${encode({ alg: 'HS256' })}.${encode({ sub: 'ui-check', role: 'admin', exp: 4102444800 })}.x`;
await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
// Выгрузки профилей остаются в странице: файл не скачивается, а читается из blob
await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('token', ${JSON.stringify(token)}); localStorage.setItem('role', 'admin'); localStorage.setItem('username', 'ui-check');
    window.__downloads = []; const create = URL.createObjectURL.bind(URL); URL.createObjectURL = (blob) => { const url = create(blob); window.__downloads.push({ url, blob }); return url; };
    const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__lastDownload = this.download; else click.call(this); };`,
});

const ev = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`page: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    return result.result.value;
};
const waitFor = async (expression, label, timeout = 25000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        try { const value = await ev(expression); if (value) return value; } catch {}
        await sleep(150);
    }
    throw new Error(`timeout: ${label}`);
};
const q = JSON.stringify;
const clickText = async (selector, text, label = `${selector} «${text}»`) => {
    const found = await ev(`(() => { const list = [...document.querySelectorAll(${q(selector)})].filter((e) => ${q(text)} === '' || e.textContent.includes(${q(text)})); if (!list.length || list[0].disabled) return false; list[0].click(); return true; })()`);
    if (!found) throw new Error(`no clickable: ${label}`);
};
const api = async (path, init) => (await fetch(`${UI}/api${path}`, init)).json();
const texts = (selector) => ev(`[...document.querySelectorAll(${q(selector)})].map((e) => e.textContent.trim())`);
const toastText = () => ev(`(() => { const t = document.querySelector('.toast'); return t ? t.textContent : ''; })()`);
const clearToasts = () => waitFor(`!document.querySelector('.toast')`, 'прежние уведомления исчезли', 12000);
const waitToast = (text) => waitFor(`(() => { const t = document.querySelector('.toast'); return t && t.textContent.includes(${q(text)}); })()`, `уведомление «${text}»`);
const timezone = (minutes) => `UTC${minutes < 0 ? '−' : '+'}${Math.floor(Math.abs(minutes) / 60)}${minutes % 60 ? ':' + String(Math.abs(minutes) % 60).padStart(2, '0') : ''}`;

const results = [];
const exports = {};
let skipping = !!process.env.RJD_FROM;
async function step(name, action) {
    if (skipping && name.includes(process.env.RJD_FROM)) skipping = false;
    if (skipping) return console.log('– ' + name + ' (пропущен)');
    const started = Date.now();
    try {
        await action();
        results.push({ name, ok: true });
        console.log(`✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)} c)`);
    } catch (error) {
        results.push({ name, ok: false, error: error.message });
        console.log(`✗ ${name}: ${error.message}`);
        const shot = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
        if (shot) writeFileSync(join(OUT, `fail-${results.length}.png`), Buffer.from(shot.data, 'base64'));
        if (PHASE === 'b') await revert().catch((failure) => console.log('Возврат:', failure.message));
        await finish(1);
    }
}
async function finish(code) {
    const failed = results.filter((item) => !item.ok).length;
    console.log(`\nИтого: ${results.length - failed} из ${results.length} шагов`);
    const noise = [...new Set(consoleErrors)].filter((text) => !/WebSocket Error/.test(text));
    if (noise.length) console.log('Ошибки консоли страницы:\n' + noise.join('\n'));
    chrome.kill();
    process.exit(code);
}
const expect = (condition, message) => { if (!condition) throw new Error(message); };
const same = (actual, wanted, label) => expect(JSON.stringify(actual) === JSON.stringify(wanted), `${label}: на экране ${JSON.stringify(actual)}, в мастере ${JSON.stringify(wanted)}`);

// ── Экран ──
const open = async (path) => {
    await send('Page.navigate', { url: UI + path });
    await waitFor(`!!document.querySelector('.lb-pbar')`, 'панель профиля', 40000);
};
const rail = (name) => clickText('.rsub', name);
const profileName = () => ev(`document.querySelector('.lb-switch-nm b')?.textContent`);
const openSwitch = async () => { await clickText('.lb-switch .uisel-btn', ''); await waitFor(`!!document.querySelector('.uisel-pop')`, 'список профилей'); };
async function choose(name) {
    await openSwitch();
    await clickText('.uisel-pop .uisel-opt', name);
    await waitFor(`document.querySelector('.lb-switch-nm b')?.textContent === ${q(name)}`, `выбран ${name}`);
}
const optionNames = async () => { await openSwitch(); const list = await texts('.uisel-pop .uisel-opt .lbl-t'); await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.querySelector('.lb-switch .uisel-btn').click()`); await sleep(300); return list; };
async function expected(id) {
    const workspace = await api(`/config/profiles/${id}/workspace`);
    const entities = workspace.entities;
    const names = (kind, pick) => Object.entries(entities[kind] ?? {}).map(([key, entry]) => pick(entry.body, key)).sort();
    const integration = entities.machine?.settings?.body?.active_integration;
    return {
        cameras: names('camera', (body, key) => body.camera.display_name || key),
        neural: names('neural_config', (body, key) => body.name || key),
        gateway: Object.keys(entities.integration?.[integration]?.body?.modules ?? {}).map((key) => MODULE_NAMES[key] || key),
        layouts: names('layout', (body, key) => body.name || key),
        time: timezone(Number(entities.machine?.settings?.body?.tz_offset_min ?? 180)),
        version: workspace.version.number,
        differences: Object.entries(entities).flatMap(([kind, items]) => Object.entries(items).filter(([key, entry]) => entry.state !== 'profile' && kind !== 'binding' && !(kind === 'machine' && key === 'identity'))).length + workspace.removed.length,
        broken: workspace.broken.length,
    };
}
const overview = () => ev(`(() => {
    const t = (s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim());
    const vital = (label) => { const v = [...document.querySelectorAll('.lb-vital')].find((e) => e.querySelector('.k')?.textContent === label); return v ? { value: v.querySelector('.v').textContent.trim(), sub: v.querySelector('.s').textContent.trim() } : null; };
    return { cameras: t('#lb-cameras .lb-cam.is-click .lb-name > b').sort(), neural: t('#lb-neural .lb-mini .t > b').sort(), gateway: t('#lb-gateway .lb-mini .t > b'), layouts: t('#lb-display .lb-layout-heading > b').sort(),
        time: document.querySelector('#lb-display .lb-time b')?.textContent, apply: vital('Применение'), passport: vital('Изменения паспорта'), conflicts: vital('Конфликты с новой версией'), broken: vital('Ошибки ссылок') };
})()`);
async function verifyOverview(id, label) {
    const want = await expected(id);
    await waitFor(`document.querySelectorAll('#lb-cameras .lb-cam.is-click').length === ${want.cameras.length}`, `${label}: камеры ${want.cameras.length}`);
    const seen = await overview();
    same(seen.cameras, want.cameras, `${label}: камеры`);
    same(seen.neural, want.neural, `${label}: нейроконфигурации`);
    same(seen.gateway, want.gateway, `${label}: модули шлюза`);
    same(seen.layouts, want.layouts, `${label}: раскладки`);
    expect(seen.time === want.time, `${label}: время ${seen.time} вместо ${want.time}`);
    expect(Number(seen.passport.value) === want.differences, `${label}: изменений паспорта ${seen.passport.value} вместо ${want.differences}`);
    expect(Number(seen.broken.value) === want.broken, `${label}: ошибок ссылок ${seen.broken.value} вместо ${want.broken}`);
    return { seen, want };
}
async function importFile(name, title) {
    await clearToasts();
    await openSwitch();
    await clickText('.uisel-pop .uisel-opt', 'Импорт из файла');
    await waitFor(`!!document.querySelector('.modal input[type=file]')`, 'окно импорта');
    const root = (await send('DOM.getDocument')).root.nodeId;
    const input = (await send('DOM.querySelector', { nodeId: root, selector: '.modal input[type=file]' })).nodeId;
    await send('DOM.setFileInputFiles', { files: [resolve(PROFILES_DIR, name)], nodeId: input });
    await waitFor(`!!document.querySelector('.lb-file')`, 'выбранный файл');
    await clickText('.modal .btn--acc', 'Импортировать');
    await waitToast(title);
    await waitFor(`!document.querySelector('.modal')`, 'окно закрылось');
    return toastText();
}
async function menu(item) {
    await clickText('.lb-more', '');
    await waitFor(`!!document.querySelector('.lb-menu-item')`, 'меню ⋯');
    await clickText('.lb-menu-item', item);
}
async function exported(id, versionLabel) {
    await menu('Экспорт профиля');
    await waitFor(`!!document.querySelector('.modal')`, 'окно экспорта');
    if (versionLabel) {
        await clickText('.modal .uisel-btn', '');
        await clickText('.uisel-pop .uisel-opt', versionLabel);
    }
    await ev(`window.__downloads.length = 0; window.__lastDownload = ''`);
    await clickText('.modal .btn--acc', 'Скачать');
    await waitFor(`window.__downloads.length > 0 && window.__lastDownload`, 'файл выгрузки');
    const file = await ev(`(async () => ({ name: window.__lastDownload, data: await new Promise((done) => { const r = new FileReader(); r.onload = () => done(r.result.split(',')[1]); r.readAsDataURL(window.__downloads[0].blob); }) }))()`);
    const path = join(OUT, file.name);
    writeFileSync(path, Buffer.from(file.data, 'base64'));
    await waitFor(`!document.querySelector('.modal')`, 'окно экспорта закрылось');
    return path;
}
const compareZip = (exportPath, sourcePath) => execFileSync(PYTHON, ['-I', '-c', `
import json, sys, zipfile
a, b = (zipfile.ZipFile(p) for p in sys.argv[1:3])
da, db = json.loads(a.read('profile.json')), json.loads(b.read('profile.json'))
assert da['profile'] == db['profile'], 'profile'
assert da['entities'] == db['entities'], 'entities'
assert set(da['assets']) == set(db['assets']) and all('assets/' + sha in a.namelist() for sha in da['assets']), 'assets'
print(len(da['entities']))
`, exportPath, sourcePath], { encoding: 'utf8' }).trim();
const save = async () => { await clearToasts(); await clickText('.cr-foot .btn--acc', 'Сохранить'); await waitToast('Паспорт сохранён'); await waitFor(`!document.querySelector('.cr-foot .is-warn')`, 'черновик сохранён'); };
async function setTimezone(label) {
    await waitFor(`!!document.querySelector('.lb-passport-field')`, 'карточка машины');
    await ev(`[...document.querySelectorAll('.lb-passport-field')].find((e) => e.textContent.includes('Часовой пояс')).querySelector('.uisel-btn').click()`);
    await clickText('.uisel-pop .uisel-opt', label);
    await save();
}
const differenceRow = (text) => `[...document.querySelectorAll('.lb-diff')].find((e) => e.textContent.includes(${q(text)}))`;

// ── Фаза A: всё, что не требует работающих модулей платы ──
async function phaseA() {
    await step('Открыт экран, активен stand-102', async () => {
        await open('/app/configurations/overview');
        await waitFor(`document.querySelector('.lb-switch-nm b')?.textContent === 'Стенд .102'`, 'stand-102');
        expect(await ev(`document.querySelector('.lb-meta .tag.is-ok')?.textContent.includes('Активный')`), 'метка «Активный профиль»');
    });
    const stand = {};
    await step('Состав stand-102 на экране совпадает с мастером', async () => {
        stand.view = await verifyOverview('stand-102', 'stand-102');
        expect(stand.view.want.cameras.length === 7, 'у stand-102 7 камер');
    });
    await step('Импорт test-rsm-2000 v1 из файла', async () => expect((await importFile('test-rsm-2000-v1.varan', 'Профиль импортирован')).includes('v1'), 'в уведомлении версия v1'));
    await step('Импорт test-iskra v1 из файла', async () => expect((await importFile('test-iskra-v1.varan', 'Профиль импортирован')).includes('Тест Искра'), 'в уведомлении Тест Искра'));
    await step('В списке три профиля, активный не сменился', async () => {
        const options = await optionNames();
        same(options.filter((name) => name !== 'Импорт из файла'), ['Стенд .102', 'Тест РСМ-2000', 'Тест Искра'], 'профили');
        expect((await api('/config/profiles')).active === 'stand-102', 'активным остался stand-102');
    });
    await step('Тест РСМ-2000: две камеры, РСМ, UTC+3, не загружен', async () => {
        await choose('Тест РСМ-2000');
        const { seen, want } = await verifyOverview(RSM, 'РСМ v1');
        expect(want.cameras.length === 2 && seen.time === 'UTC+3' && seen.apply.value === 'Не загружен', 'РСМ v1: 2 камеры, UTC+3, не загружен');
        expect(seen.layouts[0] === 'РСМ-2000' && seen.neural.length === 1, 'раскладка и нейроконфигурация РСМ');
    });
    let iskra;
    await step('Тест Искра: пять камер, 360, модуль Modbus, UTC+5', async () => {
        await choose('Тест Искра');
        iskra = await verifyOverview(ISKRA, 'Искра v1');
        expect(iskra.want.cameras.length === 5 && iskra.seen.time === 'UTC+5' && iskra.seen.gateway.join() === 'Modbus RTU', 'Искра: 5 камер, UTC+5, Modbus');
        expect(await ev(`!!document.getElementById('lb-surround')`), 'у Искры есть раздел «Система 360»');
    });
    await step('Профили различаются между собой', async () => {
        const rsm = await expected(RSM);
        expect(JSON.stringify(rsm.cameras) !== JSON.stringify(iskra.want.cameras), 'наборы камер различаются');
        expect(JSON.stringify(rsm.neural) !== JSON.stringify(iskra.want.neural) && JSON.stringify(rsm.gateway) !== JSON.stringify(iskra.want.gateway), 'нейроконфигурации и шлюз различаются');
    });
    await step('Переключение просмотра обратно на stand-102 возвращает его состав', async () => {
        await choose('Стенд .102');
        const { seen } = await verifyOverview('stand-102', 'stand-102 снова');
        same(seen.cameras, stand.view.seen.cameras, 'камеры stand-102 не изменились');
    });
    await step('«Обновить паспорт» у незагруженного профиля недоступна', async () => {
        await choose('Тест РСМ-2000');
        expect(await ev(`document.querySelector('.lb-actions .btn--acc-dim').disabled`), 'кнопка отключена');
        expect(await ev(`document.querySelector('.lb-gate[data-tip]')?.dataset.tip.includes('загруженного')`), 'подсказка про загруженный профиль');
    });
    await step('Привязка места к устройству у обоих тестовых профилей', async () => {
        for (const name of ['Тест РСМ-2000', 'Тест Искра']) {
            await choose(name);
            await rail('Паспорт машины');
            await waitFor(`!!document.querySelector('.lb-binding .uisel-btn')`, 'привязки');
            await clickText('.lb-binding .uisel-btn', '');
            await clickText('.uisel-pop .uisel-opt', 'Главное устройство');
            await save();
            await rail('Обзор');
        }
        const device = (await api('/devices')).devices[0].id;
        for (const id of [RSM, ISKRA]) expect((await api(`/config/profiles/${id}/workspace`)).entities.binding['board-1'].body.device_id === device, `${id}: привязка к плате`);
    });
    await step('Паспорт РСМ: часовой пояс UTC+4 даёт отличие', async () => {
        await choose('Тест РСМ-2000');
        await rail('Паспорт машины');
        await setTimezone('UTC+4');
        await waitFor(`!!${differenceRow('settings')}`, 'строка отличия settings');
        expect(await ev(`${differenceRow('settings')}.textContent.includes('240')`), 'значение 240 в отличии');
        await rail('Обзор');
        await waitFor(`document.querySelector('#lb-display .lb-time b')?.textContent === 'UTC+4'`, 'UTC+4 в обзоре');
        expect(Number((await overview()).passport.value) === 1, 'на сводке одно изменение паспорта');
    });
    await step('Паспорт Искры пустой и не видит правку РСМ', async () => {
        await choose('Тест Искра');
        const { seen } = await verifyOverview(ISKRA, 'Искра после правки РСМ');
        expect(seen.time === 'UTC+5' && Number(seen.passport.value) === 0, 'у Искры UTC+5 и нет изменений');
    });
    await step('Версия v2 РСМ: три камеры, у паспорта конфликт', async () => {
        await choose('Тест РСМ-2000');
        await importFile('test-rsm-2000-v2.varan', 'Профиль импортирован');
        const want = await expected(RSM);
        expect(want.version === 2 && want.cameras.length === 3, 'выбрана v2, в ней три камеры');
        await waitFor(`document.querySelectorAll('#lb-cameras .lb-cam.is-click').length === 3`, 'три камеры');
        await waitFor(`[...document.querySelectorAll('.lb-vital .k')].some((e) => e.textContent === 'Конфликты с новой версией')`, 'ячейка конфликтов');
        expect((await overview()).time === 'UTC+4', 'паспорт по-прежнему даёт UTC+4');
    });
    await step('«Оставить своё»: паспорт остаётся, конфликт снят', async () => {
        await rail('Паспорт машины');
        await waitFor(`!!${differenceRow('settings')}`, 'строка отличия');
        expect(await ev(`${differenceRow('settings')}.textContent.includes('Профиль обновлён')`), 'метка «Профиль обновлён»');
        await ev(`[...${differenceRow('settings')}.querySelectorAll('button')].find((b) => b.textContent.includes('Оставить своё')).click()`);
        await waitToast('Значение паспорта оставлено');
        await waitFor(`!${differenceRow('settings')}.textContent.includes('Профиль обновлён')`, 'метка пропала');
        expect(await ev(`${differenceRow('settings')}.textContent.includes('240')`), 'значение паспорта сохранено');
        await rail('Обзор');
        await waitFor(`![...document.querySelectorAll('.lb-vital .k')].some((e) => e.textContent === 'Конфликты с новой версией')`, 'ячейка конфликтов исчезла');
    });
    await step('Версия v3: конфликт снова, «Взять из профиля» отдаёт значение профиля', async () => {
        await importFile('test-rsm-2000-v3.varan', 'Профиль импортирован');
        await waitFor(`document.querySelectorAll('#lb-cameras .lb-cam.is-click').length === 4`, 'четыре камеры');
        await waitFor(`[...document.querySelectorAll('.lb-vital .k')].some((e) => e.textContent === 'Конфликты с новой версией')`, 'конфликт v3');
        await rail('Паспорт машины');
        await waitFor(`!!${differenceRow('settings')}`, 'строка отличия');
        await ev(`[...${differenceRow('settings')}.querySelectorAll('button')].find((b) => b.textContent.includes('Взять из профиля')).click()`);
        await save();
        await waitFor(`!document.querySelector('.lb-diff')`, 'отличий нет');
        await rail('Обзор');
        await waitFor(`document.querySelector('#lb-display .lb-time b')?.textContent === 'UTC+1:30'`, 'UTC+1:30 из v3');
        expect(Number((await overview()).passport.value) === 0, 'изменений паспорта нет');
    });
    await step('«Сбросить весь паспорт к профилю» с подтверждением', async () => {
        await rail('Паспорт машины');
        await setTimezone('UTC+5');
        await waitFor(`!!${differenceRow('settings')}`, 'отличие UTC+5');
        await clickText('button', 'Сбросить весь паспорт к профилю');
        await waitFor(`document.querySelector('.modal')?.textContent.includes('Отличий от профиля: 1')`, 'окно подтверждения с числом 1');
        await clickText('.modal .btn--err', 'Сбросить');
        await waitToast('Паспорт сброшен к профилю');
        await waitFor(`!document.querySelector('.lb-diff')`, 'отличия сброшены');
        expect((await api(`/config/profiles/${RSM}/workspace`)).entities.binding['board-1'], 'привязка осталась после сброса');
        await rail('Обзор');
        await waitFor(`document.querySelector('#lb-display .lb-time b')?.textContent === 'UTC+1:30'`, 'время профиля');
    });
    await step('Версии РСМ: v1 → две камеры, v3 → четыре', async () => {
        for (const [label, count] of [['v1', 2], ['v3', 4]]) {
            await menu('Версии профиля');
            await waitFor(`document.querySelectorAll('.modal .lb-vl').length === 3`, 'три версии');
            await ev(`[...document.querySelectorAll('.modal .lb-vl')].find((r) => r.querySelector('.n').textContent === ${q(label)}).querySelector('button.btn').click()`);
            await waitToast('Версия профиля выбрана');
            await waitFor(`document.querySelectorAll('#lb-cameras .lb-cam.is-click').length === ${count}`, `${label}: ${count} камеры`);
            await verifyOverview(RSM, `РСМ ${label}`);
        }
    });
    await step('Экспорт v1, v2, v3 РСМ и Искры повторяет импортированные файлы', async () => {
        for (const [label, file] of [['v1', 'test-rsm-2000-v1.varan'], ['v2', 'test-rsm-2000-v2.varan'], ['v3', 'test-rsm-2000-v3.varan']]) {
            await choose('Тест РСМ-2000');
            const path = await exported(RSM, label);
            expect(path.endsWith(`test-rsm-2000-${label}.varan`), `имя файла ${path}`);
            expect(Number(compareZip(path, resolve(PROFILES_DIR, file))) > 0, `${label}: содержимое`);
        }
        await choose('Тест Искра');
        exports.iskra = await exported(ISKRA);
        expect(Number(compareZip(exports.iskra, resolve(PROFILES_DIR, 'test-iskra-v1.varan'))) > 0, 'Искра: содержимое');
    });
    await step('Повторный импорт выгруженного файла версию не добавляет', async () => {
        const before = (await api('/config/profiles')).profiles.map((item) => item.versions.length);
        await importFile(exports.iskra, 'Профиль импортирован');
        const after = (await api('/config/profiles')).profiles.map((item) => item.versions.length);
        same(after, before, 'число версий');
    });
    await step('Шторка ошибок stand-102: все ошибки, переход к строке и в модуль', async () => {
        await open('/app/configurations/overview');
        await choose('Стенд .102');
        const want = await expected('stand-102');
        await clickText('.lb-vital.is-click.is-err', '');
        await waitFor(`document.querySelectorAll('.lb-drawer .lb-er').length === ${want.broken}`, `в шторке ${want.broken} записей`);
        await clickText('.lb-drawer .lb-er .btn--acc-dim', 'Показать в профиле');
        await waitFor(`!document.querySelector('.lb-drawer')`, 'шторка закрылась');
        await waitFor(`!!document.querySelector('.flash')`, 'строка подсвечена');
        expect(await ev(`document.querySelector('.lb-view').scrollTop > 200`), 'лента прокрутилась к строке');
        await clickText('.lb-vital.is-click.is-err', '');
        await clickText('.lb-drawer .lb-er .btn--ghost', 'Открыть:');
        await waitFor(`location.pathname.startsWith('/app/neural') || location.pathname.startsWith('/app/cameras') || location.pathname.startsWith('/app/surround') || location.pathname.startsWith('/app/live') || location.pathname.startsWith('/app/krsps')`, 'переход в модуль');
    });
    await step('«Обновить паспорт» у загруженного профиля при недоступной плате показывает ошибку и ничего не меняет', async () => {
        await open('/app/configurations/overview');
        const before = JSON.stringify((await api('/config/profiles/stand-102/workspace')).entities.camera);
        await clickText('.lb-actions .btn--acc-dim', 'Обновить паспорт');
        await waitFor(`document.querySelector('.modal')?.textContent.includes('Паспорт не изменён')`, 'сообщение об ошибке', 40000);
        await clickText('.modal .btn', 'Закрыть');
        expect(JSON.stringify((await api('/config/profiles/stand-102/workspace')).entities.camera) === before, 'камеры stand-102 не менялись');
    });
}

// ── Фаза B: переключения с работающей платой; плата и модули меняются по-настоящему ──
const deviceOf = async () => (await api('/devices')).devices[0];
const boardGet = async (device, path) => (await fetch(`${UI}/d/${device}/mc${path}`)).json();
const statusOf = () => api('/config/status');
const serviceRevision = async (name) => (await statusOf()).devices.find((item) => item.device_id === name);
const cameraIds = (data) => new Set(Object.keys(data?.cameras ?? {}));
const KNOWN = ['birdview_02', 'camera_1', 'camera_2', 'camera_3', 'camera_4', 'camera_5', 'camera_6'];
async function snapshotBoard(device, id) {
    const want = await api(`/config/profiles/${id}/workspace`);
    const applied = (await boardGet(device, '/config')).data;
    const status = (await statusOf()).devices.find((item) => item.device_id === device);
    const live = cameraIds((await boardGet(device, '/camera')).data);
    return { want, applied, status, live };
}
async function verifyBoard(device, id, label) {
    // Статус мастера обновляется опросом платы, а не самим переходом: ждём сходимости, но не бесконечно
    let seen = await snapshotBoard(device, id);
    for (let i = 0; i < 40 && !(seen.status.state === 'ok' && seen.status.applied === seen.status.expected && seen.applied.revision === seen.status.expected); i++) {
        await sleep(1500);
        seen = await snapshotBoard(device, id);
    }
    const { want, applied, status, live } = seen;
    const expectedCameras = Object.keys(want.entities.camera ?? {}).sort();
    same((applied.parts.cameras ?? []).map((item) => item.camera.id).sort(), expectedCameras, `${label}: камеры в пакете платы`);
    same(Object.keys(applied.parts.neural?.configurations ?? {}).sort(), Object.keys(want.entities.neural_config ?? {}).sort(), `${label}: нейроконфигурации платы`);
    expect(!!applied.parts.surround === !!Object.keys(want.entities.projection ?? {}).length, `${label}: часть 360 на плате`);
    expect(status.state === 'ok' && status.applied === status.expected && applied.revision === status.expected, `${label}: ревизия платы ${applied.revision} / ${status.applied} / ${status.expected}`);
    for (const camera of expectedCameras) expect(live.has(camera), `${label}: камеры ${camera} нет в списке платы`);
    for (const camera of KNOWN.filter((item) => !expectedCameras.includes(item))) expect(!live.has(camera), `${label}: лишняя камера ${camera} на плате`);
    return applied.revision;
}
async function waitComplete(id, previous, timeout = 300000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        const state = (await statusOf()).transition;
        if (state?.id !== previous && state?.profile_id === id && state.phase === 'complete' && !state.error) return state;
        if (state?.id === previous) { await sleep(500); continue; }
        if (state?.error) throw new Error(`переход на ${id} остановился в «${state.phase}»: ${state.error}`);
        await sleep(1500);
    }
    throw new Error(`переход на ${id} не завершился за ${timeout / 1000} с`);
}
let sawBanner = false;
async function switchTo(name, id) {
    await choose(name);
    await clickText('.lb-actions .btn--acc', 'Загрузить профиль');
    await waitFor(`!!document.querySelector('.modal')`, 'окно загрузки');
    const previous = (await statusOf()).transition?.id;
    await clickText('.modal .btn--acc', 'Подтвердить загрузку');
    sawBanner = false;
    const watcher = (async () => {
        for (let i = 0; i < 400 && !sawBanner; i++) {
            sawBanner = !!(await ev(`!!document.querySelector('.lb-trans')`).catch(() => false));
            await sleep(300);
        }
    })();
    await waitComplete(id, previous);
    sawBanner = sawBanner || !!(await ev(`!!document.querySelector('.lb-trans')`).catch(() => false));
    await waitFor(`!document.querySelector('.lb-trans') && document.querySelector('.lb-meta .tag.is-ok')?.textContent.includes('Активный')`, 'баннер закрылся, профиль активен', 60000);
    await watcher;
}
// Сбой перехода: разрешены только штатные кнопки экрана «Загрузить прежний профиль» и «Повторить переход»
async function revert() {
    const state = (await statusOf()).transition;
    if (!state || state.phase === 'complete' || !state.previous_profile_id) return;
    console.log(`Возврат на ${state.previous_profile_id}`);
    await open('/app/configurations/overview');
    await clickText('.lb-trans button', 'Загрузить прежний профиль').catch(() => clickText('.lb-trans button', 'Повторить переход'));
    await waitComplete(state.previous_profile_id, state.id).catch((error) => console.log('Возврат не удался:', error.message));
}
async function phaseB() {
    let device, before, gatewayBefore;
    await step('Плата в сети, переход не идёт, снято состояние «до»', async () => {
        await open('/app/configurations/overview');
        device = await deviceOf();
        expect(device.status === 'online', `плата ${device.id} не в сети (${device.status}); нужен запущенный media-center`);
        const state = (await statusOf()).transition;
        expect(!state || state.phase === 'complete', 'идёт или упал прежний переход');
        if ((await api('/config/profiles')).active !== 'stand-102') await switchTo('Стенд .102', 'stand-102');
        expect((await api('/config/profiles')).active === 'stand-102', 'активен stand-102');
        before = await snapshotBoard(device.id, 'stand-102');
        await verifyBoard(device.id, 'stand-102', 'stand-102 до');
    });
    for (const [name, id] of [['Тест РСМ-2000', RSM], ['Тест Искра', ISKRA], ['Тест РСМ-2000', RSM]]) {
        await step(`Загрузка «${name}»: баннер шагов, экран, мастер и плата совпадают`, async () => {
            await switchTo(name, id);
            expect(sawBanner, 'баннер «Загрузка профиля» показан');
            const { seen } = await verifyOverview(id, name);
            expect(['Применён', 'Модули запущены не все'].includes(seen.apply.value), `сводка: ${seen.apply.value}`);
            await verifyBoard(device.id, id, name);
        });
    }
    await step('РСМ: смена версии у загруженного профиля меняет набор камер на плате', async () => {
        const profile = (await api('/config/profiles')).profiles.find((item) => item.id === RSM);
        const current = profile.versions.find((item) => item.id === profile.version_id).number;
        const target = current === 1 ? 3 : 1;
        await menu('Версии профиля');
        await waitFor(`document.querySelectorAll('.modal .lb-vl').length === 3`, 'три версии');
        const previous = (await statusOf()).transition?.id;
        await ev(`[...document.querySelectorAll('.modal .lb-vl')].find((r) => r.querySelector('.n').textContent === 'v${target}').querySelector('button.btn').click()`);
        await waitComplete(RSM, previous);
        const want = await expected(RSM);
        expect(want.version === target && want.cameras.length === { 1: 2, 3: 4 }[target], `версия ${want.version}, камер ${want.cameras.length}`);
        await waitFor(`document.querySelectorAll('#lb-cameras .lb-cam.is-click').length === ${want.cameras.length}`, 'камеры в обзоре');
        await verifyOverview(RSM, `РСМ v${target} на плате`);
        await verifyBoard(device.id, RSM, `РСМ v${target} на плате`);
    });
    let changed;
    await step('РСМ: правка паспорта на живую меняет пакет шлюза, пакет платы не меняется', async () => {
        const boardRevision = (await boardGet(device.id, '/config')).data.revision;
        gatewayBefore = (await serviceRevision('gateway')).applied;
        await rail('Паспорт машины');
        await setTimezone('UTC+4');
        await waitFor(`!!document.querySelector('.lb-diff')`, 'отличие в списке');
        changed = await waitFor(`fetch('/api/config/status').then((r) => r.json()).then((s) => { const g = s.devices.find((d) => d.device_id === 'gateway'); return g.state === 'ok' && g.applied !== ${q(gatewayBefore)} ? g.applied : false; })`, 'шлюз применил новый пакет', 60000);
        expect((await boardGet(device.id, '/config')).data.revision === boardRevision, 'пакет платы не менялся при смене часового пояса');
    });
    await step('«Обновить паспорт» с живой платой: отличий нет', async () => {
        await rail('Обзор');
        await clickText('.lb-actions .btn--acc-dim', 'Обновить паспорт');
        await waitFor(`document.querySelector('.modal')?.textContent.includes('Отличий нет')`, 'плата совпадает с паспортом', 60000);
        await clickText('.modal .btn', 'Закрыть');
    });
    await step('РСМ: сброс всего паспорта возвращает пакет шлюза', async () => {
        await rail('Паспорт машины');
        await clickText('button', 'Сбросить весь паспорт к профилю');
        await waitFor(`document.querySelector('.modal')?.textContent.includes('Отличий от профиля: 1')`, 'окно подтверждения');
        await clickText('.modal .btn--err', 'Сбросить');
        await waitToast('Паспорт сброшен к профилю');
        await waitFor(`fetch('/api/config/status').then((r) => r.json()).then((s) => { const g = s.devices.find((d) => d.device_id === 'gateway'); return g.state === 'ok' && g.applied === ${q(gatewayBefore)}; })`, 'шлюз вернулся к пакету профиля', 60000);
        await rail('Обзор');
        expect(changed !== gatewayBefore, 'пакеты шлюза различались');
    });
    await step('Возврат на stand-102: плата и мастер как до прогона', async () => {
        await switchTo('Стенд .102', 'stand-102');
        await verifyOverview('stand-102', 'stand-102 после');
        const revision = await verifyBoard(device.id, 'stand-102', 'stand-102 после');
        expect(revision === before.applied.revision, `ревизия платы ${revision} вместо ${before.applied.revision}`);
        same([...(await snapshotBoard(device.id, 'stand-102')).live].sort(), [...before.live].sort(), 'камеры платы как до прогона');
    });
}

// Фаза C: загрузить «Тест Искра» и убедиться, что 360 из четырёх камер собран и запущен на плате
async function phaseC() {
    await step('Загрузка «Тест Искра»: экран, мастер и плата совпадают, 360 запущен', async () => {
        await open('/app/configurations/overview');
        const device = await deviceOf();
        expect(device.status === 'online', 'плата в сети');
        await switchTo('Тест Искра', ISKRA);
        await verifyOverview(ISKRA, 'Искра');
        await verifyBoard(device.id, ISKRA, 'Искра');
        const virtual = (await boardGet(device.id, '/camera')).data.virtual ?? [];
        const flat = virtual.find((item) => item.producer === 'birdview');
        expect(flat?.running === true && flat.source_id === 'test_v2_new', `360 не запущен: ${JSON.stringify(virtual.map((item) => [item.id, item.running, item.source_id]))}`);
        const projection = (await api(`/config/profiles/${ISKRA}/workspace`)).entities.projection.test_v2_new.body;
        expect(Object.values(projection.cameras).filter((item) => item.camera_id).length === 4, 'в схеме 360 четыре камеры');
    });
}

// Фаза D: вернуть stand-102 и убедиться, что все семь камер и 360 из четырёх камер запущены
async function phaseD() {
    await step('Возврат на stand-102: семь камер, слот техзрения и 360 из четырёх камер запущены', async () => {
        await open('/app/configurations/overview');
        const device = await deviceOf();
        expect(device.status === 'online', 'плата в сети');
        await switchTo('Стенд .102', 'stand-102');
        await verifyOverview('stand-102', 'stand-102');
        await verifyBoard(device.id, 'stand-102', 'stand-102');
        const data = (await boardGet(device.id, '/camera')).data;
        expect(Object.keys(data.cameras).length === 7, `камер на плате ${Object.keys(data.cameras).length}`);
        const flat = (data.virtual ?? []).find((item) => item.producer === 'birdview');
        expect(flat?.running === true && flat.source_id === 'test_v2_new', `360 не запущен: ${JSON.stringify((data.virtual ?? []).map((item) => [item.id, item.running, item.source_id]))}`);
        const slots = (await boardGet(device.id, '/neural/status')).data;
        expect(JSON.stringify(slots).includes('railway_camera_seg'), 'слот railway_camera_seg есть в состоянии техзрения платы');
    });
}

if (PHASE === 'a') await phaseA();
else if (PHASE === 'd') await phaseD();
else if (PHASE === 'b') await phaseB();
else if (PHASE === 'c') await phaseC();
else throw new Error('phase must be a or b');
await finish(0);
