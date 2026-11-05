import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [UI, OUT] = process.argv.slice(2);
const port = 9466;
const dir = mkdtempSync(join(tmpdir(), 'tips-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'ошибка страницы'); return r.result?.result?.value; };
const waitFor = async (expression, label, timeout = 15000) => { const start = Date.now(); while (Date.now() - start < timeout) { if (await ev(expression).catch(() => false)) return; await sleep(100); } throw new Error(`timeout: ${label}`); };
async function step(name, fn) {
    try { await fn(); results.push(true); console.log(`✓ ${name}`); } catch (failure) { results.push(false); console.log(`✗ ${name}: ${failure.message}`); }
}
const expect = (condition, message) => { if (!condition) throw new Error(message); };
const move = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
const center = (selector, index = 0) => ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height }; })()`);
const tipState = () => ev(`(() => { const t = document.getElementById('tip-layer'); if (!t) return null; const b = t.querySelector('.tip-body'); const cs = getComputedStyle(b); return { hidden: t.hidden, side: t.dataset.side, cls: t.className, text: b.textContent, anim: cs.animationName, opacity: cs.opacity, fs: cs.fontSize, ax: t.style.getPropertyValue('--ax'), described: document.querySelectorAll('[aria-describedby="tip-layer"]').length }; })()`);
async function shot(name, selector) {
    const clip = await ev(`(() => { const t = document.getElementById('tip-layer'); const r = t.getBoundingClientRect(); const a = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); const x = Math.min(r.left, a.left) - 16, y = Math.min(r.top, a.top) - 16; return { x: Math.max(0, x), y: Math.max(0, y), width: Math.max(r.right, a.right) - x + 32, height: Math.max(r.bottom, a.bottom) - y + 32 }; })()`);
    const data = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 2 } });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data.result.data, 'base64'));
}

try {
    let targets;
    for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(250); } }
    ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    await send('Page.enable');
    await send('Animation.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, role: 'admin', sub: 't' })).toString('base64url');
    await send('Page.navigate', { url: UI + '/app/' });
    await sleep(2500);
    await ev(`localStorage.setItem('token', 'e30.${payload}.x'); localStorage.setItem('role','admin'); localStorage.setItem('username','t'); true`);
    await send('Page.navigate', { url: UI + '/app/configurations/overview' });
    await waitFor(`!!document.querySelector('.lb-pbar')`, 'панель профиля', 40000);
    // stand-102 в просмотре: там значения, изменённые паспортом, с подсказками
    await ev(`document.querySelector('.lb-switch .uisel-btn').click(); true`);
    await sleep(300);
    await ev(`[...document.querySelectorAll('.uisel-pop .uisel-opt')].find((e) => e.textContent.includes('Стенд')).click(); true`);
    await waitFor(`document.querySelectorAll('.lb-pass').length >= 1`, 'значения паспорта', 20000);
    await sleep(800);

    await step('Нативных title= на DOM-элементах не осталось', async () => {
        const n = await ev(`document.querySelectorAll('button[title], span[title], div[title], a[title], b[title]').length`);
        expect(n === 0, `title= на ${n} элементах`);
    });
    await step('Первая подсказка: появляется после задержки, снизу, шрифт 12.5px, стрелка, aria-describedby', async () => {
        const p = await center('.lb-tags .tag:last-child');
        await move(p.x, p.y);
        await sleep(150);
        expect((await tipState()).hidden !== false, 'подсказка не должна появляться раньше задержки');
        await sleep(450);
        const s = await tipState();
        expect(s.hidden === false && s.side === 'below' && /Только чтение|только для чтения/.test(s.text), JSON.stringify(s));
        expect(s.fs === '12.5px' && s.described === 1 && s.anim === 'tip-in', JSON.stringify(s));
        await sleep(300);
        await shot('tip-below', '.lb-tags .tag:last-child');
    });
    await step('Анимация входа в замедлении: прозрачность растёт, подсказка сдвинута к цели', async () => {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
        await sleep(600);
        await send('Animation.setPlaybackRate', { playbackRate: 0.08 });
        const p = await center('.lb-tags .tag:last-child');
        await move(p.x, p.y);
        await sleep(380 + 700);
        const mid = await tipState();
        const o = Number(mid.opacity);
        await shot('tip-enter-mid', '.lb-tags .tag:last-child');
        await send('Animation.setPlaybackRate', { playbackRate: 1 });
        expect(o > 0 && o < 1, `непрозрачность в середине входа ${mid.opacity}`);
    });
    await step('Соседняя подсказка скользит: слой не прячется и не играет вход заново', async () => {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
        await sleep(600);
        const pts = await ev(`(() => [...document.querySelectorAll('[data-tip]')].map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tip: e.dataset.tip, ok: r.width > 0 && r.top > 60 && r.bottom < window.innerHeight - 60 }; }).filter((p) => p.ok).filter((p, i, all) => all.findIndex((q) => q.tip === p.tip) === i).slice(0, 2))()`);
        expect(pts.length === 2, `видимых элементов с подсказкой: ${pts.length}`);
        await move(pts[0].x, pts[0].y);
        await sleep(700);
        const first = await tipState();
        await move(pts[1].x, pts[1].y);
        await sleep(60);
        const mid = await tipState();
        expect(mid.hidden === false && mid.cls.includes('is-glide') && !mid.cls.includes('is-out'), JSON.stringify(mid));
        await sleep(400);
        const last = await tipState();
        expect(last.text !== first.text, 'текст не сменился');
        expect(last.hidden === false && last.described === 1 && !last.cls.includes('is-out'), JSON.stringify(last));
    });
    await step('Подсказка у нижнего края уходит наверх, стрелка на центре элемента', async () => {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
        await sleep(600);
        const spot = await center('.lb-tags .tag:last-child');
        await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: Math.round(spot.y + 22), deviceScaleFactor: 1, mobile: false });
        await sleep(400);
        await move(spot.x, spot.y);
        await sleep(800);
        const s = await tipState();
        expect(s.hidden === false && s.side === 'above' && Number.parseFloat(s.ax) > 0, JSON.stringify(s));
        await shot('tip-above', '.lb-tags .tag:last-child');
        await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    });
    await step('Escape закрывает подсказку анимацией ухода, затем слой скрыт, aria-describedby снят', async () => {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await sleep(30);
        const during = await tipState();
        expect(during.cls.includes('is-out') && during.anim === 'tip-out', JSON.stringify(during));
        await sleep(250);
        const after = await tipState();
        expect(after.hidden === true && after.described === 0, JSON.stringify(after));
    });
    await step('Кнопка «⋯» и иконочные кнопки имеют доступное имя', async () => {
        const bad = await ev(`[...document.querySelectorAll('button')].filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title') && b.dataset.tip).length`);
        expect(bad === 0, `кнопок без имени с подсказкой: ${bad}`);
    });
} finally {
    const failed = results.filter((ok) => !ok).length;
    console.log(`\nИтого: ${results.length - failed} из ${results.length} шагов`);
    chrome.kill();
    process.exit(failed ? 1 : 0);
}
