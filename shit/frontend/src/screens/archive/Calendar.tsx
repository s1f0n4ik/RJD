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

// Строка сетки: 'in' — только что пришла и проявляется
type RowState = 'load' | 'done' | 'in' | 'error';

// Ответы по неделям живут минуту: повторно открытый календарь рисуется сразу
const CACHE_MS = 60_000;
const weekCache = new Map<string, { at: number; days: DaySummary[]; offline: string[] }>();

export function Calendar({ month, onMonth, todayKey, from, to, onPick, cameraNames }: Props) {
    const [rows, setRows] = useState<Map<number, RowState>>(new Map());
    const [days, setDays] = useState<Map<string, DaySummary>>(new Map());
    const [offline, setOffline] = useState<string[]>([]);
    const [attempt, setAttempt] = useState(0);
    const [slide, setSlide] = useState<'next' | 'prev' | null>(null);
    const [tip, setTip] = useState<{ key: string; anchor: Anchor } | null>(null);

    const cells = useMemo(() => buildMonth(month), [month]);
    const [year, monthNumber] = month.split('-').map(Number);

    // Месяц грузится по неделям, первой — неделя выбранного дня, дальше по удалённости от неё
    useEffect(() => {
        let alive = true;
        const weeks = weekRanges(cells);
        const target = [from, todayKey].find(key => key && key.startsWith(month)) ?? `${month}-01`;
        const targetRow = Math.floor(cells.findIndex(cell => cell.key === target) / 7);
        const order = [...weeks].sort((a, b) => Math.abs(a.row - targetRow) - Math.abs(b.row - targetRow));

        const states = new Map<number, RowState>();
        const known = new Map<string, DaySummary>();
        const unreached = new Set<string>();
        weeks.forEach(week => {
            const hit = weekCache.get(week.key);
            if (hit && Date.now() - hit.at < CACHE_MS) {
                states.set(week.row, 'done');
                hit.days.forEach(day => known.set(day.date, day));
                hit.offline.forEach(id => unreached.add(id));
            } else {
                states.set(week.row, 'load');
            }
        });
        setRows(states);
        setDays(known);
        setOffline([...unreached]);

        (async () => {
            for (const week of order) {
                if (states.get(week.row) === 'done') continue;
                try {
                    const data = await fetchDays(week.from, week.to);
                    if (!alive) return;
                    // Остров, задевший соседнюю неделю, приходит и её днём — берём только свои сутки
                    const own = data.days.filter(day => day.date >= week.from && day.date <= week.to);
                    weekCache.set(week.key, { at: Date.now(), days: own, offline: data.offline_devices ?? [] });
                    setDays(current => {
                        const next = new Map(current);
                        own.forEach(day => next.set(day.date, day));
                        return next;
                    });
                    setOffline(current => [...new Set([...current, ...(data.offline_devices ?? [])])]);
                    setRows(current => new Map(current).set(week.row, 'in'));
                } catch {
                    if (alive) setRows(current => new Map(current).set(week.row, 'error'));
                }
            }
        })();

        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cells, attempt]);

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

    const failed = [...rows.values()].includes('error');
    const tipDay = tip && days.get(tip.key);

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
                className={`arch-cal-grid${slide ? ` is-${slide}` : ''}`}
                onMouseLeave={() => setTip(null)}
            >
                {cells.map((cell, index) => {
                    const summary = cell.inMonth ? days.get(cell.key) : undefined;
                    const row = rows.get(Math.floor(index / 7));
                    const classes = ['arch-cal-d'];

                    if (!cell.inMonth) classes.push('is-out');
                    else if (row === 'load') classes.push('is-wait');
                    else if (row === 'in') classes.push('is-in');
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
                            style={{ ['--k' as string]: index % 7 }}
                            onClick={() => { setTip(null); onPick(cell.key); }}
                            onMouseEnter={event => {
                                if (summary) showTip(cell.key, event.currentTarget);
                                else setTip(null);
                            }}
                        >
                            <span className="arch-cal-dial">
                                <svg viewBox="0 0 36 36" aria-hidden="true">
                                    <circle className="t" cx="18" cy="18" r={RING} />
                                    {summary && <Arcs day={summary} index={index % 7} />}
                                </svg>
                                <b>{cell.day}</b>
                            </span>
                            {summary && !summary.trusted && <i className="arch-cal-dot" />}
                        </button>
                    );
                })}
            </div>

            {(failed || offline.length > 0) && (
                <div className="arch-cal-err">
                    <Icon name="warn" size={14} />
                    <span>{unreachedText(failed, offline)}</span>
                    <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => {
                            weekCache.forEach((week, key) => { if (week.offline.length) weekCache.delete(key); });
                            setAttempt(value => value + 1);
                        }}
                    >
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

function unreachedText(failed: boolean, offline: string[]): string {
    if (failed) return 'Архив ответил не за все недели, их дни здесь не показаны.';
    const names = offline.map(id => `«${id}»`).join(', ');
    return offline.length > 1
        ? `Нет ответа от ${names}. Их записи здесь не показаны.`
        : `Нет ответа от ${names}. Его записи здесь не показаны.`;
}

// Строки сетки как запросы: от первого до последнего дня месяца в строке
function weekRanges(cells: Array<{ key: string; inMonth: boolean }>) {
    const weeks = [];
    for (let row = 0; row < 6; row++) {
        const own = cells.slice(row * 7, row * 7 + 7).filter(cell => cell.inMonth);
        if (!own.length) continue;
        const from = own[0].key;
        const to = own[own.length - 1].key;
        weeks.push({ row, from, to, key: `${from}_${to}` });
    }
    return weeks;
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
