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

/** Русское склонение: 1 объект, 2-4 объекта, 5+ объектов (с учётом 11-14). */
export function pluralObjects(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} объект`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} объекта`;
  return `${n} объектов`;
}

/** unix ms из значения <input type="datetime-local"> (локальная зона) или undefined. */
export function localInputToMs(v: string): number | undefined {
  if (!v) return undefined;
  const ms = new Date(v).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}
