import { useEffect, useMemo, useState } from 'react';

import type { DaySummary } from './model';
import { dateKey, fetchDays, fmtHoursShort } from './model';

const MONTHS = [
    'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

const FULL_DAY_RATIO = 0.97;
const DAY = 86_400_000;

interface Props {
    month: string;
    onMonth: (month: string) => void;
    todayKey: string | null;
    // Одиночный выбор — from и to совпадают
    from: string | null;
    to: string | null;
    onPick: (key: string) => void;
}

export function Calendar({ month, onMonth, todayKey, from, to, onPick }: Props) {
    const [days, setDays] = useState<Map<string, DaySummary>>(new Map());

    useEffect(() => {
        const [year, monthNumber] = month.split('-').map(Number);
        let alive = true;

        fetchDays(`${month}-01`, dateKey(Date.UTC(year, monthNumber, 0)))
            .then(data => { if (alive) setDays(new Map(data.days.map(day => [day.date, day]))); })
            .catch(() => alive && setDays(new Map()));

        return () => { alive = false; };
    }, [month]);

    const cells = useMemo(() => buildMonth(month), [month]);
    const [year, monthNumber] = month.split('-').map(Number);

    return (
        <>
            <div className="arch-cal-head">
                <button type="button" onClick={() => onMonth(shiftMonth(month, -1))}>‹</button>
                <b>{MONTHS[monthNumber - 1]} {year}</b>
                <button type="button" onClick={() => onMonth(shiftMonth(month, 1))}>›</button>
            </div>

            <div className="arch-cal-grid">
                {['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map(name => (
                    <span key={name}>{name}</span>
                ))}

                {cells.map(cell => {
                    const summary = days.get(cell.key);
                    const classes = ['arch-cal-d'];

                    if (!cell.inMonth) classes.push('is-out');
                    if (summary) {
                        // recorded_ms — сумма по всем потокам, полные сутки меряются на дорожку
                        const full = DAY * Math.max(1, summary.track_count);
                        if (!summary.trusted) classes.push('is-doubt');
                        else if (summary.recorded_ms >= full * FULL_DAY_RATIO) classes.push('is-full');
                        else classes.push('is-part');
                    }

                    const edge = cell.key === from || cell.key === to;
                    const inside = from && to && cell.key > from && cell.key < to;
                    if (edge) classes.push('is-on');
                    else if (inside) classes.push('is-range');
                    else if (cell.key === todayKey) classes.push('is-today');

                    return (
                        <button
                            key={cell.key}
                            type="button"
                            className={classes.join(' ')}
                            onClick={() => onPick(cell.key)}
                            title={summary ? fmtHoursShort(summary.recorded_ms) : 'записей нет'}
                        >
                            <b>{cell.day}</b>
                            {summary && <em>{fmtHoursShort(summary.recorded_ms)}</em>}
                        </button>
                    );
                })}
            </div>
        </>
    );
}

export function shiftMonth(month: string, delta: number): string {
    const [year, monthNumber] = month.split('-').map(Number);
    const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Сетка месяца с понедельника, с хвостами соседних месяцев
function buildMonth(month: string) {
    const [year, monthNumber] = month.split('-').map(Number);
    const first = new Date(Date.UTC(year, monthNumber - 1, 1));
    const offset = (first.getUTCDay() + 6) % 7;
    const start = Date.UTC(year, monthNumber - 1, 1 - offset);

    return Array.from({ length: 42 }, (_, index) => {
        const ms = start + index * DAY;
        const date = new Date(ms);
        return {
            key: dateKey(ms),
            day: date.getUTCDate(),
            inMonth: date.getUTCMonth() === monthNumber - 1,
        };
    });
}
