// Разворот ячейки на странице трансляции: кнопка и двойной клик — одно действие, настоящий полный экран у ячейки не используется.
// node cell-expand-ui.mjs <ui url> [path=/translation]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [UI, PATH = '/translation'] = process.argv.slice(2);
const port = 9467;
const dir = mkdtempSync(join(tmpdir(), 'expand-'));
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
const state = () => ev(`JSON.stringify({ expanded: !!document.querySelector('.wall.is-expanded'), solo: document.querySelector('.cell.is-solo')?.dataset.cell ?? null, hidden: document.querySelectorAll('.cell.is-hidden').length, fullscreen: !!document.fullscreenElement, tip: document.querySelector('.cell[data-cell="0"] .cell-btn')?.dataset.tip, icon: document.querySelector('.cell[data-cell="0"] .cell-btn use')?.getAttribute('href') })`).then(JSON.parse);

try {
    let targets;
    for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(250); } }
    ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    await send('Page.enable');
    await send('Page.navigate', { url: UI + '/app/' });
    await sleep(2500);
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, role: 'viewer', sub: 'e' })).toString('base64url');
    await ev(`localStorage.setItem('token', 'e30.${payload}.x'); localStorage.setItem('role','viewer'); localStorage.setItem('username','e'); true`);
    await send('Page.navigate', { url: UI + PATH });
    await waitFor(`document.querySelectorAll('.wall .cell').length >= 2 && !!document.querySelector('.cell[data-cell="0"] .cell-btn')`, 'ячейки с кнопкой');
    await sleep(800);

    await step('Кнопка ячейки: «Развернуть ячейку», раскрывает без Fullscreen API, соседи скрыты', async () => {
        const before = await state();
        expect(before.tip === 'Развернуть ячейку' && !before.expanded, JSON.stringify(before));
        await ev(`document.querySelector('.cell[data-cell="0"] .cell-btn').click()`);
        await sleep(300);
        const after = await state();
        expect(after.expanded && after.solo === '0' && after.hidden >= 1 && !after.fullscreen, JSON.stringify(after));
        expect(after.tip === 'Свернуть ячейку' && /unfull/.test(after.icon ?? ''), JSON.stringify(after));
    });
    await step('Та же кнопка сворачивает', async () => {
        await ev(`document.querySelector('.cell[data-cell="0"] .cell-btn').click()`);
        await sleep(300);
        const s = await state();
        expect(!s.expanded && s.hidden === 0 && s.tip === 'Развернуть ячейку', JSON.stringify(s));
    });
    await step('Двойной клик раскрывает так же, как кнопка', async () => {
        await ev(`document.querySelector('.cell[data-cell="0"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
        await sleep(300);
        const s = await state();
        expect(s.expanded && s.solo === '0' && !s.fullscreen && s.tip === 'Свернуть ячейку', JSON.stringify(s));
    });
    await step('Esc сворачивает', async () => {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await sleep(300);
        const s = await state();
        expect(!s.expanded && s.hidden === 0, JSON.stringify(s));
    });
    await step('Двойной клик по кнопке ячейки не раскрывает дважды (кнопка гасит dblclick)', async () => {
        await ev(`const b = document.querySelector('.cell[data-cell="0"] .cell-tools'); b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
        await sleep(300);
        expect(!(await state()).expanded, 'двойной клик по панели кнопок не должен раскрывать');
    });
} finally {
    const failed = results.filter((ok) => !ok).length;
    console.log(`\nИтого: ${results.length - failed} из ${results.length} шагов`);
    chrome.kill();
    process.exit(failed ? 1 : 0);
}
