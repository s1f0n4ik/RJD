// Форматирование чисел и величин для страницы КРСПС.

export function formatInt(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(n || 0));
}

// Человекочитаемый объём: Б / КБ / МБ / ГБ / ТБ.
export function formatBytes(bytes: number): { value: string; unit: string } {
  const b = Math.max(0, bytes || 0);
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const value = i === 0 ? String(Math.round(v)) : v.toFixed(1);
  return { value, unit: units[i] };
}

// Локальное время ЧЧ:ММ:СС из unix-ms.
export function formatClock(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('ru-RU', { hour12: false });
}
