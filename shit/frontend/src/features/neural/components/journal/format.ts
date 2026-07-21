// Мелкие форматтеры журнала. Время показываем в локальной зоне оператора.

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtDateTime(ts: number): string {
  return `${fmtDate(ts)} ${fmtTime(ts)}`;
}

export function fmtCoord(v: number): string {
  return v.toFixed(5);
}

/** unix ms из значения <input type="datetime-local"> (локальная зона) или undefined. */
export function localInputToMs(v: string): number | undefined {
  if (!v) return undefined;
  const ms = new Date(v).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}
