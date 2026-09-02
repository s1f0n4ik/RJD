import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../../app/Icons';
import { elementAnchor, usePopover } from '../../app/popover';
import type { Anchor } from '../../app/popover';
import type { DaySummary } from './model';
import { dateKey, dayStartMs, fetchDays, weekdayShort } from './model';

/*
    Выбор дня. Календарь только выбирает дату и больше ничего не делает:
    подсвечивает сутки, за которые есть записи, и различает полные сутки,
    часть суток и сутки с недостоверным временем.
*/

interface Props {
    date: string;
    todayKey: string | null;
    onChange: (date: string) => void;
}

const MONTHS = [
    'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

const FULL_DAY_RATIO = 0.97;

export function DayPicker({ date, todayKey, onChange }: Props) {
    const [open, setOpen] = useState(false);
    const [month, setMonth] = useState(() => date.slice(0, 7));
    const [days, setDays] = useState<Map<string, DaySummary>>(new Map());
    const box = useRef<HTMLDivElement | null>(null);
    const button = useRef<HTMLButtonElement | null>(null);
    const [anchor, setAnchor] = useState<Anchor | null>(null);
    const pop = usePopover<HTMLDivElement>(anchor, { side: 'top', align: 'start' });

    useEffect(() => {
        if (!open) return;

        // Попап лежит в body, поэтому снаружи считается всё, что не он и не кнопка
        const onDocumentDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (box.current?.contains(target) || pop.current?.contains(target)) return;
            setOpen(false);
        };
        const onEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        const close = () => setOpen(false);

        document.addEventListener('mousedown', onDocumentDown);
        document.addEventListener('keydown', onEscape);
        window.addEventListener('resize', close);
        return () => {
            document.removeEventListener('mousedown', onDocumentDown);
            document.removeEventListener('keydown', onEscape);
            window.removeEventListener('resize', close);
        };
    }, [open, pop]);

    useEffect(() => {
        if (!open) return;

        const [year, monthNumber] = month.split('-').map(Number);
        const from = `${month}-01`;
        const to = dateKey(Date.UTC(year, monthNumber, 0));

        let alive = true;
        fetchDays(from, to)
            .then(data => {
                if (!alive) return;
                setDays(new Map(data.days.map(day => [day.date, day])));
            })
            .catch(() => alive && setDays(new Map()));

        return () => { alive = false; };
    }, [open, month]);

    const cells = useMemo(() => buildMonth(month), [month]);
    const [year, monthNumber] = month.split('-').map(Number);

    return (
        <div className="arch-daypick" ref={box}>
            <div className="arch-step">
                <button type="button" className="arch-step-arrow" onClick={() => onChange(shift(date, -1))} aria-label="Предыдущий день">‹</button>
                <button
                    type="button"
                    className="arch-step-day"
                    ref={button}
                    onClick={() => {
                        if (button.current) setAnchor(elementAnchor(button.current));
                        setOpen(value => !value);
                    }}
                >
                    <b>{formatDay(date)}</b>
                    <em>{weekdayShort(date)}</em>
                    <Icon name="cal" />
                </button>
                <button type="button" className="arch-step-arrow" onClick={() => onChange(shift(date, 1))} aria-label="Следующий день">›</button>
            </div>

            {open && anchor && createPortal(
                <div className="arch-pop" ref={pop}>
                    <div className="arch-cal-head">
                        <button type="button" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
                        <b>{MONTHS[monthNumber - 1]} {year}</b>
                        <button type="button" onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
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
                                if (!summary.trusted) classes.push('is-doubt');
                                else if (summary.recorded_ms >= 86_400_000 * FULL_DAY_RATIO) classes.push('is-full');
                                else classes.push('is-part');
                            }
                            if (cell.key === date) classes.push('is-on');
                            else if (cell.key === todayKey) classes.push('is-today');

                            return (
                                <button
                                    key={cell.key}
                                    type="button"
                                    className={classes.join(' ')}
                                    onClick={() => { onChange(cell.key); setOpen(false); }}
                                    title={summary ? `${Math.round(summary.recorded_ms / 60000)} мин записи` : 'записей нет'}
                                >
                                    {cell.day}
                                </button>
                            );
                        })}
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
}

function formatDay(key: string): string {
    const [year, month, day] = key.split('-');
    return `${day}.${month}.${year}`;
}

function shift(key: string, days: number): string {
    return dateKey(dayStartMs(key) + days * 86_400_000);
}

function shiftMonth(month: string, delta: number): string {
    const [year, monthNumber] = month.split('-').map(Number);
    const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Сетка месяца с понедельника, с хвостами соседних месяцев. */
function buildMonth(month: string) {
    const [year, monthNumber] = month.split('-').map(Number);
    const first = new Date(Date.UTC(year, monthNumber - 1, 1));
    const offset = (first.getUTCDay() + 6) % 7;
    const start = Date.UTC(year, monthNumber - 1, 1 - offset);

    return Array.from({ length: 42 }, (_, index) => {
        const ms = start + index * 86_400_000;
        const date = new Date(ms);
        return {
            key: dateKey(ms),
            day: date.getUTCDate(),
            inMonth: date.getUTCMonth() === monthNumber - 1,
        };
    });
}
