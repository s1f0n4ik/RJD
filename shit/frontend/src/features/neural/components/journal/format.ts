// Мелкие форматтеры журнала. ts записей — «настенное» время шлюза,
// закодированное как UTC: шлюз уже сдвинул его на настроенный пользователем
// пояс, поэтому показываем и разбираем без второго сдвига в пояс браузера.

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
  });
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function fmtDateTime(ts: number): string {
  return `${fmtDate(ts)} ${fmtTime(ts)}`;
}

/** Настенные часы оператора, закодированные как UTC — для границ пресетов.
 *  Совпадает со временем шлюза, когда оператор в том же поясе. */
export function wallNow(): number {
  return Date.now() - new Date().getTimezoneOffset() * 60_000;
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

/** Русское склонение: 1 запись, 2-4 записи, 5+ записей (с учётом 11-14). */
export function pluralRecords(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} запись`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} записи`;
  return `${n} записей`;
}

/** unix ms из значения <input type="datetime-local"> как настенного времени
 *  (кодируется в UTC, без пояса браузера) или undefined. */
export function localInputToMs(v: string): number | undefined {
  if (!v) return undefined;
  const ms = new Date(`${v}Z`).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}
