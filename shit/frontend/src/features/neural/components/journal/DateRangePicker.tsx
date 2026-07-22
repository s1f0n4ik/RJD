import { useMemo, useState } from 'react';

// Свой календарь диапазона. Нативный datetime-local не подходит: его выпадающую
// панель браузер рисует вне DOM, и под тему её не привести.

const DOW = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

interface Props {
  from?: number;
  to?: number;
  onApply: (from?: number, to?: number) => void;
  onClose: () => void;
}

/** Порядковый номер дня — для сравнений без учёта времени. */
function dayKey(d: Date): number {
  return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
}

/** Сетка 6×7, начиная с понедельника недели, в которую попадает 1-е число. */
function buildGrid(year: number, month: number) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // в JS неделя начинается с воскресенья
  const cells: { date: Date; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - offset + i);
    cells.push({ date: d, inMonth: d.getMonth() === month });
  }
  return cells;
}

function parseTime(v: string, fallbackH: number, fallbackM: number): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return [fallbackH, fallbackM];
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const min = Math.min(59, Math.max(0, Number(m[2])));
  return [h, min];
}

function fmtTimeInput(ms?: number, fallback = ''): string {
  if (ms == null) return fallback;
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function DateRangePicker({ from, to, onApply, onClose }: Props) {
  const initStart = from != null ? new Date(from) : null;
  const initEnd = to != null ? new Date(to) : null;

  const [start, setStart] = useState<Date | null>(initStart);
  const [end, setEnd] = useState<Date | null>(initEnd);
  const [startTime, setStartTime] = useState(fmtTimeInput(from, '00:00'));
  const [endTime, setEndTime] = useState(fmtTimeInput(to, '23:59'));

  const base = initStart ?? new Date();
  const [view, setView] = useState({ y: base.getFullYear(), m: base.getMonth() });

  const cells = useMemo(() => buildGrid(view.y, view.m), [view]);

  const shift = (delta: number) => {
    const d = new Date(view.y, view.m + delta, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };

  // Первый клик задаёт начало, второй — конец. Клик раньше начала переставляет их.
  const pick = (d: Date) => {
    if (!start || (start && end)) {
      setStart(d);
      setEnd(null);
      return;
    }
    if (dayKey(d) < dayKey(start)) {
      setEnd(start);
      setStart(d);
    } else {
      setEnd(d);
    }
  };

  const cellClass = (d: Date, inMonth: boolean) => {
    const k = dayKey(d);
    const s = start ? dayKey(start) : null;
    const e = end ? dayKey(end) : null;
    let cls = 'jr-cal-d';
    if (!inMonth) cls += ' mute';
    if (s != null && k === s) cls += ' start';
    if (e != null && k === e) cls += ' end';
    if (s != null && e != null && k > s && k < e) cls += ' in';
    return cls;
  };

  const apply = () => {
    if (!start) {
      onApply(undefined, undefined);
      onClose();
      return;
    }
    const [sh, sm] = parseTime(startTime, 0, 0);
    const fromMs = new Date(
      start.getFullYear(), start.getMonth(), start.getDate(), sh, sm, 0, 0,
    ).getTime();

    // Конец не выбран — считаем диапазоном один день.
    const endDate = end ?? start;
    const [eh, em] = parseTime(endTime, 23, 59);
    const toMs = new Date(
      endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), eh, em, 59, 999,
    ).getTime();

    onApply(fromMs, toMs);
    onClose();
  };

  const reset = () => {
    setStart(null);
    setEnd(null);
    setStartTime('00:00');
    setEndTime('23:59');
    onApply(undefined, undefined);
    onClose();
  };

  return (
    <div className="jr-cal" onClick={(e) => e.stopPropagation()}>
      <div className="jr-cal-head">
        <span className="jr-cal-month">
          {MONTHS[view.m]} {view.y}
        </span>
        <span className="jr-cal-nav">
          <button type="button" onClick={() => shift(-1)} aria-label="Предыдущий месяц">←</button>
          <button type="button" onClick={() => shift(1)} aria-label="Следующий месяц">→</button>
        </span>
      </div>

      <div className="jr-cal-grid">
        {DOW.map((d) => (
          <span className="jr-cal-dow" key={d}>{d}</span>
        ))}
        {cells.map(({ date, inMonth }, i) => (
          <button
            type="button"
            key={i}
            className={cellClass(date, inMonth)}
            onClick={() => pick(date)}
          >
            {date.getDate()}
          </button>
        ))}
      </div>

      <div className="jr-cal-times">
        <label className="jr-cal-t">
          <span className="jr-cal-tk">с</span>
          <input
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            placeholder="00:00"
            inputMode="numeric"
            maxLength={5}
          />
        </label>
        <label className="jr-cal-t">
          <span className="jr-cal-tk">по</span>
          <input
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            placeholder="23:59"
            inputMode="numeric"
            maxLength={5}
          />
        </label>
      </div>

      <div className="jr-cal-foot">
        <button type="button" className="jr-cal-reset" onClick={reset}>Сбросить</button>
        <button type="button" className="jr-cal-apply" onClick={apply}>Применить</button>
      </div>
    </div>
  );
}
