import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../../../../app/Icons';
import { Popover } from './Filters';

// Свой календарь диапазона. Нативный datetime-local не подходит: его выпадающую
// панель браузер рисует вне DOM, и под тему её не привести.

const DOW = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const MONTHS = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

interface Props {
  anchor: HTMLElement;
  from?: number;
  to?: number;
  onApply: (from?: number, to?: number) => void;
  onClose: () => void;
  /** Одна дата вместо диапазона: второй клик переставляет выбор, время одно,
   *  onApply приходит только с from. Используется очисткой «старше даты». */
  single?: boolean;
  // Поверх модалки
  over?: boolean;
  // Блок над календарём: пресеты периода
  head?: ReactNode;
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

// ts журнала — настенное время шлюза, закодированное как UTC. Календарь внутри
// работает на локальных Date с теми же настенными компонентами; конверсия
// туда-обратно идёт через UTC-геттеры и Date.UTC, чтобы пояс браузера не влиял.
function wallToDate(ms: number): Date {
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
}

function fmtTimeInput(ms?: number, fallback = ''): string {
  if (ms == null) return fallback;
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function DateRangePicker({ anchor, from, to, onApply, onClose, single = false, over, head }: Props) {
  const initStart = from != null ? wallToDate(from) : null;
  const initEnd = to != null ? wallToDate(to) : null;

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
    if (single) {
      setStart(d);
      setEnd(null);
      return;
    }
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
    let cls = 'cal-d';
    if (!inMonth) cls += ' is-out';
    if ((s != null && k === s) || (e != null && k === e)) cls += ' is-on';
    else if (s != null && e != null && k > s && k < e) cls += ' has';
    return cls;
  };

  const apply = () => {
    if (!start) {
      onApply(undefined, undefined);
      onClose();
      return;
    }
    const [sh, sm] = parseTime(startTime, 0, 0);
    const fromMs = Date.UTC(
      start.getFullYear(), start.getMonth(), start.getDate(), sh, sm, 0, 0,
    );

    if (single) {
      onApply(fromMs, undefined);
      onClose();
      return;
    }

    // Конец не выбран — считаем диапазоном один день.
    const endDate = end ?? start;
    const [eh, em] = parseTime(endTime, 23, 59);
    const toMs = Date.UTC(
      endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), eh, em, 59, 999,
    );

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
    <Popover anchor={anchor} onClose={onClose} over={over} className="j-cal-pop">
      <div className="j-cal-body">
        {head}
        <div className="cal">
          <div className="cal-h">
            <button type="button" className="icon-btn" onClick={() => shift(-1)} aria-label="Предыдущий месяц">
              <Icon name="chev" size={12} className="ico is-back" />
            </button>
            <b>{MONTHS[view.m]} {view.y}</b>
            <button type="button" className="icon-btn" onClick={() => shift(1)} aria-label="Следующий месяц">
              <Icon name="chev" size={12} />
            </button>
          </div>
          <div className="cal-grid">
            {DOW.map((d) => (
              <span key={d}>{d}</span>
            ))}
            {cells.map(({ date, inMonth }, i) => (
              <button type="button" key={i} className={cellClass(date, inMonth)} onClick={() => pick(date)}>
                {date.getDate()}
              </button>
            ))}
          </div>
        </div>
        <div className="tf-row">
          <div className="tf">
            <span className="tf-cap">{single ? 'Время' : 'С'}</span>
            <input
              className="tf-in"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              placeholder="00:00"
              inputMode="numeric"
              maxLength={5}
            />
          </div>
          {!single && (
            <div className="tf">
              <span className="tf-cap">По</span>
              <input
                className="tf-in"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                placeholder="23:59"
                inputMode="numeric"
                maxLength={5}
              />
            </div>
          )}
        </div>
      </div>
      <div className="j-cal-foot">
        <button type="button" className="btn btn--ghost" onClick={reset}>Сбросить</button>
        <button type="button" className="btn btn--acc spacer" onClick={apply}>Применить</button>
      </div>
    </Popover>
  );
}
