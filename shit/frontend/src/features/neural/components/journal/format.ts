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

// Длительность обнаружения: 3,0 с · 2 мин 5 с · 1 ч 4 мин
export function fmtDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1).replace('.', ',')} с`;
  if (s < 3600) return `${Math.floor(s / 60)} мин ${Math.floor(s % 60)} с`;
  return `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`;
}

// У открытого обнаружения конца ещё нет
export function durationLabel(det: { started_at: number; ended_at: number | null }): string {
  return det.ended_at == null ? 'открыто' : fmtDuration(det.ended_at - det.started_at);
}

export const REASON_LABEL: Record<string, string> = {
  removed: 'цель ушла',
  device_restart: 'перезапуск устройства',
  link_lost: 'нет связи',
  config_changed: 'смена конфигурации',
  master_restart: 'перезапуск мастера',
};

// Метка в строке: причина закрытия, если цель не просто ушла
export const reasonTag = (reason: string | null) => (reason && reason !== 'removed' ? REASON_LABEL[reason] ?? reason : null);

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
