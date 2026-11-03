import './styles/tokens.css';
import './styles/test-report.css';

type Check = { id: string; block: string; title: string; status: string; summary: string; metrics?: Record<string, unknown> };
type Sample = { at: string; rss_mb?: number; fd?: number; dma_buf?: number };
type Run = { id: string; started_at: string; finished_at?: string; state: string; phase: string; progress: number; target: string;
  checks: Check[]; samples: Sample[]; events?: unknown[]; artifacts: { name: string; label: string }[];
  cleanup?: { mc_stopped?: boolean; restored?: boolean; errors?: string[] }; duration_seconds?: number };
type Summary = Omit<Run, 'checks' | 'samples' | 'artifacts'> & { counts: Record<string, number> };

const blocks: Record<string, [string, string]> = {
  cameras: ['Камеры', 'WebRTC · параллельные подключения'], recording: ['Запись', 'MP4 · границы сегментов · индекс'],
  neural: ['Техзрение', 'Слоты · модели · конфигурации'], surround: ['Обзор 360', 'Пресеты · проекции · живой поток'],
  can: ['CAN', 'Виртуальная линия'], modbus: ['Modbus RTU', 'Виртуальная последовательная линия'],
};
const states: Record<string, string> = { running: 'Выполняется', completed: 'Завершён', aborted: 'Прерван', failed: 'Завершён с ошибкой' };
const h = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const date = (value?: string) => value ? new Intl.DateTimeFormat('ru', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '—';
const num = (value?: number) => value == null ? '—' : new Intl.NumberFormat('ru', { maximumFractionDigits: 1 }).format(value);
const root = document.querySelector<HTMLDivElement>('#test-report')!;
let summaries: Summary[] = [], selected: Run | undefined, picked = new URLSearchParams(location.search).get('run') || '', busy = false;
let lastFocus: HTMLElement | null = null;

async function get<T>(path: string): Promise<T> {
  const response = await fetch('/api/tests/' + path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function resource(label: string, key: 'rss_mb' | 'fd', unit: string) {
  const values = (selected?.samples || []).map(x => x[key]).filter((x): x is number => Number.isFinite(x));
  if (!values.length) return `<section class="tr-panel tr-resource"><h3>${label}<span>${unit}</span></h3><p class="tr-muted">Замеры ещё не получены</p></section>`;
  const low = Math.min(...values), high = Math.max(...values), range = high - low || 1;
  const points = values.map((v, i) => `${i * 440 / Math.max(values.length - 1, 1)},${56 - (v - low) / range * 46}`).join(' ');
  return `<section class="tr-panel tr-resource"><h3>${label}<span>${unit}</span></h3><svg class="tr-chart" viewBox="0 0 440 64" preserveAspectRatio="none" role="img" aria-label="${label}"><path class="tr-grid" d="M0 15H440 M0 40H440 M0 63H440"/><polyline class="tr-line" points="${points}"/></svg><div class="tr-chart-labels"><span>До ${num(values[0])}</span><span>Пик ${num(high)}</span><span>После ${num(values.at(-1))}</span></div></section>`;
}

function body() {
  if (!selected) return '<section class="tr-panel tr-empty"><h2>Прогоны ещё не выполнялись</h2><p>Здесь появятся результаты после первого запуска испытаний.</p></section>';
  const run = selected, checks = run.checks || [];
  const count = (status: string) => checks.filter(x => x.status === status).length;
  const failed = count('failed'), unread = count('blocked') + count('skipped');
  const critical = checks.filter(x => x.status === 'failed' && x.metrics?.severity === 'critical');
  const elapsed = run.duration_seconds ?? (Date.now() - Date.parse(run.started_at)) / 1000;
  const duration = `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`;
  const done = Object.keys(blocks).filter(block => checks.some(x => x.block === block && ['passed', 'failed'].includes(x.status))).length;
  const state = run.state === 'completed' && failed ? 'Завершён с замечаниями' : states[run.state] || run.state;
  return `<div class="tr-run-header"><div><h2>Прогон <span class="tr-mono">${h(run.id)}</span></h2><p>${date(run.started_at)} · МСК · ${h(run.target)}</p></div><div class="tr-run-header-right"><span class="tr-pill ${failed || run.state === 'aborted' ? 'tr-warn' : ''}">${h(state)}</span><a class="tr-btn" href="/api/tests/runs/${encodeURIComponent(run.id)}" download="${h(run.id)}.json">Экспорт JSON</a></div></div>
  ${run.state === 'running' ? `<div class="tr-progress"><span>${h(run.phase)}</span><span class="tr-mono">${num(run.progress)}%</span><progress max="100" value="${run.progress}"></progress></div>` : ''}
  ${critical.map(check => `<section class="tr-critical" role="alert"><strong>Критическая проблема: ${h(check.title)}</strong><p>${h(check.summary)}</p><button class="tr-open" data-check="${h(check.id)}">Открыть доказательства →</button></section>`).join('')}
  <div class="tr-summary"><div><strong class="tr-good">${count('passed')}</strong><span>Пройдено</span></div><div><strong class="tr-warn">${failed}</strong><span>Проблемы</span></div><div><strong class="tr-muted">${unread}</strong><span>Не проверено</span></div><div><strong>${duration}</strong><span>Длительность</span></div><div><strong>${done} / 6</strong><span>Блоков выполнено</span></div></div>
  <section class="tr-panel"><header class="tr-panel-head"><h3>Проверки по блокам</h3><small>Нажмите на блок для деталей</small></header><div class="tr-scroll"><table class="tr-table"><thead><tr><th>Блок</th><th>Результат</th><th class="tr-num">Пройдено</th><th class="tr-num">Проблемы</th><th>Ключевой замер</th></tr></thead><tbody>${Object.entries(blocks).map(([key, [label, sub]]) => {
    const items = checks.filter(x => x.block === key), faults = items.filter(x => x.status === 'failed');
    const pass = items.filter(x => x.status === 'passed').length;
    const summary = faults[0]?.summary || items.filter(x => x.status === 'passed').at(-1)?.summary || items[0]?.summary || 'Ожидает проверки';
    const pending = items.some(x => ['blocked', 'skipped'].includes(x.status));
    return `<tr><td><button class="tr-open" data-block="${key}">${label}<small>${sub}</small></button></td><td class="${faults.length ? 'tr-warn' : pass ? 'tr-good' : 'tr-muted'}">${faults.length ? '! Замечание' : pass ? pending ? '✓ Частично' : '✓ Пройдено' : '— Не проверено'}</td><td class="tr-num">${pass}</td><td class="tr-num ${faults.length ? 'tr-warn' : 'tr-muted'}">${faults.length}</td><td class="tr-measure">${h(summary)}</td></tr>`;
  }).join('')}</tbody></table></div><div class="tr-note">Физические CAN/RS485, отключение питания и USB-дисков не входят в этот набор.</div></section>
  <div class="tr-resources">${resource('Память MC', 'rss_mb', 'МБ')}${resource('Открытые дескрипторы', 'fd', 'шт.')}</div>
  ${checks.some(x => x.status === 'failed') ? `<section class="tr-panel tr-findings"><header class="tr-panel-head"><h3>Выявленные проблемы</h3><small>${failed}</small></header>${checks.filter(x => x.status === 'failed').map(x => `<button class="tr-finding" data-check="${h(x.id)}"><span class="tr-warn">${h(blocks[x.block]?.[0] || x.block)}</span><strong>${h(x.title)}</strong><span>${h(x.summary)}</span></button>`).join('')}</section>` : ''}
  ${run.artifacts?.length ? `<div class="tr-artifacts"><span class="tr-muted">Доказательства</span>${run.artifacts.map(x => `<a href="/api/tests/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(x.name)}">${h(x.label)}</a>`).join('')}</div>` : ''}`;
}

function render() {
  root.innerHTML = `<header class="tr-top"><div><span class="tr-mark">✓</span><strong>Испытания</strong><span class="tr-muted tr-mono">.102</span></div><a href="/app/">Открыть приложение ↗</a></header><main class="tr-work"><header class="tr-heading"><h1>Результаты испытаний</h1><p>Камеры, запись, техзрение, обзор 360 и связь</p></header><div class="tr-layout"><aside class="tr-aside"><div class="tr-aside-title"><h3>Прогоны</h3><span>${summaries.length}</span></div>${summaries.map(run => `<button class="tr-run" data-run="${h(run.id)}" aria-pressed="${run.id === picked}"><strong>${date(run.started_at)}</strong><small>${h(states[run.state] || run.state)}</small><div><span class="tr-good">✓ ${run.counts.passed}</span><span class="tr-warn">! ${run.counts.failed}</span><span class="tr-muted">— ${run.counts.blocked + run.counts.skipped}</span></div></button>`).join('')}<div class="tr-aside-note"><p>Данные MC изолированы</p><p>CAN: программная линия</p><p>Modbus: виртуальный порт</p></div></aside><div class="tr-main" id="tr-main">${body()}</div></div><footer class="tr-footer"><span>${selected?.cleanup?.mc_stopped === true ? '✓ MC после прогона остановлен' : selected?.state === 'running' ? 'MC выполняет испытания' : selected ? 'Остановка MC не подтверждена' : 'Нет активного прогона'}</span><span>${selected?.cleanup?.restored === true ? 'Настройки восстановлены' : 'Отдельные данные и записи'} · запуск только командой</span></footer></main><div class="tr-overlay" id="tr-overlay" hidden><section class="tr-drawer" role="dialog" aria-modal="true" aria-labelledby="tr-detail-title"><header><h2 id="tr-detail-title"></h2><button id="tr-close" aria-label="Закрыть">×</button></header><div id="tr-details"></div></section></div>`;
}

function closeDetails() {
  document.querySelector<HTMLElement>('#tr-overlay')!.hidden = true;
  document.body.style.overflow = '';
  lastFocus?.focus();
}

function details(title: string, checks: Check[]) {
  lastFocus = document.activeElement as HTMLElement;
  document.querySelector('#tr-detail-title')!.textContent = title;
  document.querySelector('#tr-details')!.innerHTML = checks.length ? checks.map(check => `<section class="tr-check"><span class="${check.status === 'passed' ? 'tr-good' : check.status === 'failed' ? 'tr-warn' : 'tr-muted'}">${h({ passed: '✓ Пройдено', failed: '! Проблема', blocked: '— Заблокировано', skipped: '— Не проверено', running: 'Выполняется' }[check.status] || check.status)}</span><h3>${h(check.title)}</h3><p>${h(check.summary)}</p>${check.metrics ? `<pre>${h(JSON.stringify(check.metrics, null, 2))}</pre>` : ''}</section>`).join('') : '<p class="tr-muted">Проверки блока ещё не выполнены.</p>';
  document.querySelector<HTMLElement>('#tr-overlay')!.hidden = false;
  document.body.style.overflow = 'hidden';
  document.querySelector<HTMLButtonElement>('#tr-close')!.focus();
}

async function refresh() {
  if (busy || !document.querySelector<HTMLElement>('#tr-overlay')?.hidden && selected) return;
  busy = true;
  try {
    const result = await get<{ runs: Summary[]; unreadable: number }>('runs');
    summaries = result.runs;
    if (!picked || !summaries.some(x => x.id === picked)) picked = summaries[0]?.id || '';
    selected = picked ? await get<Run>('runs/' + encodeURIComponent(picked)) : undefined;
    render();
    if (result.unreadable) document.querySelector('#tr-main')!.insertAdjacentHTML('afterbegin', `<p class="tr-warning">Не удалось прочитать отчётов: ${result.unreadable}</p>`);
  } catch {
    if (!document.querySelector('#tr-main')) render();
    document.querySelector('#tr-main')!.innerHTML = '<section class="tr-panel tr-empty"><h2>Отчёты недоступны</h2><p>Проверьте связь с сервером. Обновление повторится автоматически.</p></section>';
  } finally { busy = false; }
}

root.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('button');
  if (!button) { if ((event.target as HTMLElement).id === 'tr-overlay') closeDetails(); return; }
  if (button.dataset.run) { picked = button.dataset.run; history.replaceState(null, '', '?run=' + encodeURIComponent(picked)); void refresh(); }
  if (button.dataset.block) details(blocks[button.dataset.block][0], selected?.checks.filter(x => x.block === button.dataset.block) || []);
  if (button.dataset.check) details('Выявленная проблема', selected?.checks.filter(x => x.id === button.dataset.check) || []);
  if (button.id === 'tr-close') closeDetails();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeDetails();
  const overlay = document.querySelector<HTMLElement>('#tr-overlay');
  if (event.key === 'Tab' && overlay && !overlay.hidden) { event.preventDefault(); document.querySelector<HTMLButtonElement>('#tr-close')!.focus(); }
});
render();
void refresh();
window.setInterval(() => { void refresh(); }, 5000);
