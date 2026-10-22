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

// Сутки: 'in' — только что пришли и проявляются
type DayState = 'load' | 'done' | 'in' | 'error';

// Ответы по суткам живут минуту: повторно открытый календарь рисуется сразу
const CACHE_MS = 60_000;
const dayCache = new Map<string, { at: number; day: DaySummary | null; offline: string[] }>();

// Сутки запрашиваются по одним, столько сразу: тяжёлый день не держит очередь
const PARALLEL = 3;

export function Calendar({ month, onMonth, todayKey, from, to, onPick, cameraNames }: Props) {
    const [states, setStates] = useState<Map<string, DayState>>(new Map());
    const [days, setDays] = useState<Map<string, DaySummary>>(new Map());
    const [offline, setOffline] = useState<string[]>([]);
    const [attempt, setAttempt] = useState(0);
    const [slide, setSlide] = useState<'next' | 'prev' | null>(null);
    const [tip, setTip] = useState<{ key: string; anchor: Anchor } | null>(null);

    const cells = useMemo(() => buildMonth(month), [month]);
    const [year, monthNumber] = month.split('-').map(Number);

    // Месяц грузится по суткам: первыми — выбранный день и его соседи, будущие дни не запрашиваются
    useEffect(() => {
        const abort = new AbortController();
        const keys = cells.filter(cell => cell.inMonth).map(cell => cell.key);
        const target = [from, todayKey].find(key => key && key.startsWith(month)) ?? keys[0];
        const distance = (key: string) => Math.abs(dayStartMs(key) - dayStartMs(target));

        const initial = new Map<string, DayState>();
        const known = new Map<string, DaySummary>();
        const unreached = new Set<string>();
        keys.forEach(key => {
            const hit = dayCache.get(key);
            if (todayKey && key > todayKey) {
                initial.set(key, 'done');
            } else if (hit && Date.now() - hit.at < CACHE_MS) {
                initial.set(key, 'done');
                if (hit.day) known.set(key, hit.day);
                hit.offline.forEach(id => unreached.add(id));
            } else {
                initial.set(key, 'load');
            }
        });
        setStates(initial);
        setDays(known);
        setOffline([...unreached]);

        const queue = keys.filter(key => initial.get(key) === 'load').sort((a, b) => distance(a) - distance(b));
        const worker = async () => {
            for (let key = queue.shift(); key && !abort.signal.aborted; key = queue.shift()) {
                try {
                    const data = await fetchDays(key, key, abort.signal);
                    // Остров через полночь приходит и соседним днём — берём только свои сутки
                    const day = data.days.find(item => item.date === key) ?? null;
                    const off = data.offline_devices ?? [];
                    dayCache.set(key, { at: Date.now(), day, offline: off });
                    if (day) setDays(current => new Map(current).set(key, day));
                    if (off.length) setOffline(current => [...new Set([...current, ...off])]);
                    setStates(current => new Map(current).set(key, 'in'));
                } catch {
                    if (!abort.signal.aborted) setStates(current => new Map(current).set(key, 'error'));
                }
            }
        };
        for (let i = 0; i < PARALLEL; i++) worker();

        return () => abort.abort();
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

    const failed = [...states.values()].includes('error');
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
                    const state = states.get(cell.key);
                    const classes = ['arch-cal-d'];

                    if (!cell.inMonth) classes.push('is-out');
                    else if (state === 'load') classes.push('is-wait');
                    else if (state === 'in') classes.push('is-in');
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
                            dayCache.forEach((day, key) => { if (day.offline.length) dayCache.delete(key); });
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
    if (failed) return 'Архив ответил не за все сутки, они здесь не показаны.';
    const names = offline.map(id => `«${id}»`).join(', ');
    return offline.length > 1
        ? `Нет ответа от ${names}. Их записи здесь не показаны.`
        : `Нет ответа от ${names}. Его записи здесь не показаны.`;
}

// Дуги кольца: синие — запись, серые — запись только на неподключённом диске
function Arcs({ day, index }: { day: DaySummary; index: number }) {
    // Старое устройство не передаёт часы записи: кольцо целиком и тусклое
    if (!day.tracks?.length) return <Arc from={0} to={24} kind="s" index={index} />;
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

function Arc({ from, to, kind, index }: { from: number; to: number; kind: 'r' | 'g' | 's'; index: number }) {
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
    const tracks = day.tracks ?? [];
    const total = unionRuns(tracks.flatMap(track => track.runs))
        .reduce((sum, run) => sum + run.end_ms - run.start_ms, 0);

    const rows = tracks.map(track => {
        const twins = tracks.filter(t => t.camera_id === track.camera_id && t.device_id === track.device_id).length > 1;
        const name = cameraNames.get(track.camera_id) || track.camera_id;
        return { track, name: twins ? `${name} · ${track.stream_key.replace('stream_', 'канал ')}` : name };
    }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    return createPortal(
        <div className="arch-cal-tip" ref={ref}>
            <div className="arch-cal-tip-h">
                <b>{date} {MONTHS_OF[month - 1]}, {weekday}</b>
                <span>{tracks.length ? `${fmtHoursShort(total)} записи` : 'запись есть'}</span>
                {!day.trusted && <em>время недостоверно</em>}
            </div>
            {!tracks.length && <div className="arch-cal-cam"><span className="n">Камер с записью: {day.track_count}</span></div>}
            {tracks.length > 0 && (
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
            )}
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
