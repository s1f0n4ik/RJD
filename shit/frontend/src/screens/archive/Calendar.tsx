import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../../app/Icons';
import type { Anchor } from '../../app/popover';
import { usePopover } from '../../app/popover';
import type { DaySummary } from './model';
import {
    DAY_MS, dateKey, dayStartMs, fetchDays, fmtHoursShort, isAvailable, subtractRuns, unionRuns,
} from './model';

const MONTHS = [
    'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

const MONTHS_OF = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const WEEK = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

// Радиус кольца суток в координатах viewBox 36×36
const RING = 15;

interface Props {
    month: string;
    onMonth: (month: string) => void;
    todayKey: string | null;
    // Одиночный выбор — from и to совпадают
    from: string | null;
    to: string | null;
    onPick: (key: string) => void;
    cameraNames: Map<string, string>;
}

type Load = { status: 'load' } | { status: 'done'; days: Map<string, DaySummary>; offline: string[] } | { status: 'error' };

export function Calendar({ month, onMonth, todayKey, from, to, onPick, cameraNames }: Props) {
    const [load, setLoad] = useState<Load>({ status: 'load' });
    const [attempt, setAttempt] = useState(0);
    const [slide, setSlide] = useState<'next' | 'prev' | null>(null);
    const [tip, setTip] = useState<{ key: string; anchor: Anchor } | null>(null);

    useEffect(() => {
        const [year, monthNumber] = month.split('-').map(Number);
        let alive = true;

        setLoad({ status: 'load' });
        fetchDays(`${month}-01`, dateKey(Date.UTC(year, monthNumber, 0)))
            .then(data => {
                if (alive) setLoad({ status: 'done', days: new Map(data.days.map(day => [day.date, day])), offline: data.offline_devices ?? [] });
            })
            .catch(() => alive && setLoad({ status: 'error' }));

        return () => { alive = false; };
    }, [month, attempt]);

    const cells = useMemo(() => buildMonth(month), [month]);
    const [year, monthNumber] = month.split('-').map(Number);
    const days = load.status === 'done' ? load.days : null;

    const step = (delta: number) => {
        setTip(null);
        setSlide(delta > 0 ? 'next' : 'prev');
        onMonth(shiftMonth(month, delta));
    };

    // Подсказка встаёт сбоку от календаря на уровне клетки, сетку не закрывает
    const showTip = useCallback((key: string, cell: HTMLElement) => {
        const pop = cell.closest('.arch-pop') ?? cell;
        const outer = pop.getBoundingClientRect();
        const box = cell.getBoundingClientRect();
        setTip({ key, anchor: { left: outer.left, right: outer.right, top: box.top, bottom: box.bottom } });
    }, []);

    const unreached = load.status === 'error' || (load.status === 'done' && load.offline.length > 0);
    const tipDay = tip && days?.get(tip.key);

    return (
        <>
            <div className="arch-cal-head">
                <button type="button" onClick={() => step(-1)} aria-label="Предыдущий месяц">‹</button>
                <b>{MONTHS[monthNumber - 1]} {year}</b>
                <button type="button" onClick={() => step(1)} aria-label="Следующий месяц">›</button>
            </div>

            <div className="arch-cal-week">
                {WEEK.map(name => <span key={name}>{name}</span>)}
            </div>

            <div
                key={month}
                className={`arch-cal-grid${slide ? ` is-${slide}` : ''}${load.status === 'load' ? ' is-load' : ''}`}
                onMouseLeave={() => setTip(null)}
            >
                {cells.map((cell, index) => {
                    const summary = cell.inMonth ? days?.get(cell.key) : undefined;
                    const classes = ['arch-cal-d'];

                    if (!cell.inMonth) classes.push('is-out');
                    if (summary) classes.push('has');
                    if (todayKey && cell.key > todayKey) classes.push('is-future');

                    const edge = cell.key === from || cell.key === to;
                    const inside = from && to && cell.key > from && cell.key < to;
                    if (edge) classes.push('is-on');
                    else if (inside) classes.push('is-range');
                    if (cell.key === todayKey) classes.push('is-today');

                    return (
                        <button
                            key={cell.key}
                            type="button"
                            className={classes.join(' ')}
                            onClick={() => { setTip(null); onPick(cell.key); }}
                            onMouseEnter={event => {
                                if (summary) showTip(cell.key, event.currentTarget);
                                else setTip(null);
                            }}
                        >
                            <span className="arch-cal-dial">
                                <svg viewBox="0 0 36 36" aria-hidden="true">
                                    <circle className="t" cx="18" cy="18" r={RING} />
                                    {summary && <Arcs day={summary} index={index} />}
                                </svg>
                                <b>{cell.day}</b>
                            </span>
                            {summary && !summary.trusted && <i className="arch-cal-dot" />}
                        </button>
                    );
                })}
            </div>

            {unreached && (
                <div className="arch-cal-err">
                    <Icon name="warn" size={14} />
                    <span>{unreachedText(load)}</span>
                    <button type="button" className="btn btn--sm" onClick={() => setAttempt(value => value + 1)}>
                        Повторить
                    </button>
                </div>
            )}

            {tip && tipDay && (
                <DayTip key={tip.key} day={tipDay} anchor={tip.anchor} cameraNames={cameraNames} />
            )}
        </>
    );
}

function unreachedText(load: Load): string {
    if (load.status !== 'done') return 'Архив не ответил, дни с записями не показаны.';
    const names = load.offline.map(id => `«${id}»`).join(', ');
    return load.offline.length > 1
        ? `Нет ответа от ${names}. Их записи здесь не показаны.`
        : `Нет ответа от ${names}. Его записи здесь не показаны.`;
}

// Дуги кольца: синие — запись, серые — запись только на неподключённом диске
function Arcs({ day, index }: { day: DaySummary; index: number }) {
    const start = dayStartMs(day.date);
    const runs = day.tracks.flatMap(track => track.runs);
    const recorded = unionRuns(runs.filter(isAvailable));
    const gone = subtractRuns(unionRuns(runs.filter(run => !isAvailable(run))), recorded);
    const hours = (ms: number) => Math.min(24, Math.max(0, (ms - start) / 3_600_000));

    return (
        <>
            {recorded.map(run => (
                <Arc key={`r${run.start_ms}`} from={hours(run.start_ms)} to={hours(run.end_ms)} kind="r" index={index} />
            ))}
            {gone.map(run => (
                <Arc key={`g${run.start_ms}`} from={hours(run.start_ms)} to={hours(run.end_ms)} kind="g" index={index} />
            ))}
        </>
    );
}

function Arc({ from, to, kind, index }: { from: number; to: number; kind: 'r' | 'g'; index: number }) {
    const style = { ['--i' as string]: index };
    if (to - from >= 23.99) {
        return <circle className={`arch-cal-arc ${kind}`} pathLength={100} style={style} cx="18" cy="18" r={RING} transform="rotate(-90 18 18)" />;
    }
    if (to - from <= 0) return null;
    const point = (h: number) => {
        const angle = (h / 24) * Math.PI * 2 - Math.PI / 2;
        return `${(18 + RING * Math.cos(angle)).toFixed(2)} ${(18 + RING * Math.sin(angle)).toFixed(2)}`;
    };
    return (
        <path
            className={`arch-cal-arc ${kind}`}
            pathLength={100}
            style={style}
            d={`M${point(from)} A${RING} ${RING} 0 ${to - from > 12 ? 1 : 0} 1 ${point(to)}`}
        />
    );
}

// Карточка суток: часы записи и полоса каждой камеры на шкале 00–24
function DayTip({ day, anchor, cameraNames }: { day: DaySummary; anchor: Anchor; cameraNames: Map<string, string> }) {
    const ref = usePopover<HTMLDivElement>(anchor, { side: 'right', align: 'center' });
    const start = dayStartMs(day.date);
    const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - start) / DAY_MS) * 100));
    const [, month, date] = day.date.split('-').map(Number);
    const weekday = WEEK[(new Date(start).getUTCDay() + 6) % 7];
    const total = unionRuns(day.tracks.flatMap(track => track.runs))
        .reduce((sum, run) => sum + run.end_ms - run.start_ms, 0);

    const rows = day.tracks.map(track => {
        const twins = day.tracks.filter(t => t.camera_id === track.camera_id && t.device_id === track.device_id).length > 1;
        const name = cameraNames.get(track.camera_id) || track.camera_id;
        return { track, name: twins ? `${name} · ${track.stream_key.replace('stream_', 'канал ')}` : name };
    }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    return createPortal(
        <div className="arch-cal-tip" ref={ref}>
            <div className="arch-cal-tip-h">
                <b>{date} {MONTHS_OF[month - 1]}, {weekday}</b>
                <span>{fmtHoursShort(total)} записи</span>
                {!day.trusted && <em>время недостоверно</em>}
            </div>
            <div className="arch-cal-axis">
                <span />
                <div>
                    <i style={{ left: 0 }}>00</i>
                    <i style={{ left: '25%' }}>06</i>
                    <i style={{ left: '50%' }}>12</i>
                    <i style={{ left: '75%' }}>18</i>
                    <i style={{ left: '100%' }}>24</i>
                </div>
                <span />
            </div>
            {rows.map(({ track, name }) => (
                <div key={`${track.device_id}/${track.camera_id}/${track.stream_key}`} className="arch-cal-cam">
                    <span className="n">{name}</span>
                    <span className="arch-cal-lane">
                        {track.runs.map(run => (
                            <i
                                key={run.start_ms}
                                className={isAvailable(run) ? undefined : 'is-gone'}
                                style={{ left: `${pct(run.start_ms)}%`, width: `${pct(run.end_ms) - pct(run.start_ms)}%` }}
                            />
                        ))}
                    </span>
                    <span className="h">{fmtHoursShort(track.recorded_ms)}</span>
                </div>
            ))}
        </div>,
        document.body,
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
        const ms = start + index * DAY_MS;
        const date = new Date(ms);
        return {
            key: dateKey(ms),
            day: date.getUTCDate(),
            inMonth: date.getUTCMonth() === monthNumber - 1,
        };
    });
}
