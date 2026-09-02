import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Modal } from '../../app/Modal';
import { useDownloads } from '../../app/DownloadsContext';
import type { Anchor } from '../../app/popover';
import { elementAnchor, usePopover } from '../../app/popover';
import { Calendar } from './Calendar';
import type { Track, ZoomLevel } from './model';
import {
    DAY_MS, ZOOMS, buildTicks, dateKey, dayStartMs, estimateBytes, fmtBytes, fmtDate,
    fmtDuration, fmtTick, fmtTime, gapsWithin, percentIn, recordedWithin, trackKey,
} from './model';

type RangeMode = 'today' | 'period' | 'all';
type Kind = 'cut' | 'zip';

// Подписи засечек ближе этой доли к краю уступают место подписям границ
const EDGE_PERCENT = 7;
// Больше засечек между границами в окно не помещается
const MAX_TICKS = 6;

interface Props {
    tracks: Track[];
    cameraNames: Map<string, string>;
    selection: { from: number; to: number } | null;
    // Окно открыто из карточки диапазона: выбирать нечего, показываем границы
    fixedRange: boolean;
    preselected: string[];
    todayKey: string | null;
    archiveFrom: number | null;
    archiveTo: number | null;
    onClose: () => void;
}

export function DownloadModal({
    tracks, cameraNames, selection, fixedRange, preselected, todayKey,
    archiveFrom, archiveTo, onClose,
}: Props) {
    const { start } = useDownloads();

    const [mode, setMode] = useState<RangeMode>('today');
    const [kind, setKind] = useState<Kind>('cut');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const today = todayKey ?? dateKey(Date.now());
    const [month, setMonth] = useState(() => today.slice(0, 7));
    const [fromDate, setFromDate] = useState<string | null>(null);
    const [toDate, setToDate] = useState<string | null>(null);

    const [chosen, setChosen] = useState<Set<string>>(() => new Set(preselected));

    const period = useRef<HTMLButtonElement | null>(null);
    const [calAnchor, setCalAnchor] = useState<Anchor | null>(null);
    const cal = usePopover<HTMLDivElement>(calAnchor, { side: 'bottom', align: 'start' });

    const range = useMemo(() => {
        if (fixedRange && selection) return selection;
        if (mode === 'today') return { from: dayStartMs(today), to: dayStartMs(today) + DAY_MS };
        if (mode === 'all') {
            return { from: archiveFrom ?? dayStartMs(today), to: (archiveTo ?? dayStartMs(today)) + 1 };
        }
        if (!fromDate) return { from: dayStartMs(today), to: dayStartMs(today) + DAY_MS };
        return { from: dayStartMs(fromDate), to: dayStartMs(toDate ?? fromDate) + DAY_MS };
    }, [fixedRange, selection, mode, today, archiveFrom, archiveTo, fromDate, toDate]);

    // Первый клик задаёт начало, второй конец, третий начинает заново
    const pickDay = (key: string) => {
        if (!fromDate || toDate) {
            setFromDate(key);
            setToDate(null);
            return;
        }
        if (key < fromDate) {
            setToDate(fromDate);
            setFromDate(key);
        } else {
            setToDate(key);
            setCalAnchor(null);
        }
    };

    useEffect(() => {
        if (!calAnchor) return;

        const onDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (period.current?.contains(target) || cal.current?.contains(target)) return;
            setCalAnchor(null);
        };

        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [calAnchor, cal]);

    const openPeriod = () => {
        setMode('period');
        setMonth((fromDate ?? today).slice(0, 7));
        if (period.current) setCalAnchor(elementAnchor(period.current));
    };

    const rows = useMemo(() => tracks.map(track => {
        const recorded = recordedWithin(track, range.from, range.to);
        // Пустой список камер значит обрыв связи, а не то, что удалены все
        const deleted = cameraNames.size > 0 && !cameraNames.has(track.camera_id);
        return {
            track,
            key: trackKey(track),
            name: cameraNames.get(track.camera_id) || track.camera_id,
            deleted,
            recorded,
            bytes: estimateBytes(track, recorded),
            // Сегменты дорожки известны за весь архив, в диапазон попадает их доля по времени
            files: track.recorded_ms > 0
                ? Math.round(track.segment_count * recorded / track.recorded_ms)
                : 0,
            runs: track.runs.filter(run => run.end_ms > range.from && run.start_ms < range.to),
            gaps: gapsWithin(track, range.from, range.to),
        };
    }), [tracks, cameraNames, range.from, range.to]);

    // Засечки берём тем же способом, что таймлайн: ближайший масштаб к окну
    const scale = useMemo(() => {
        const span = Math.max(1, range.to - range.from);
        const level = ZOOMS.reduce<ZoomLevel>(
            (best, value) => (Math.abs(value.span - span) < Math.abs(best.span - span) ? value : best),
            ZOOMS[0],
        );
        const all = buildTicks(range.from, range.to, level)
            .filter(tick => tick.label)
            .map(tick => ({ ...tick, percent: percentIn(tick.ms, range.from, range.to) }))
            .filter(tick => tick.percent > 0 && tick.percent < 100);
        // Крупные окна прореживаются равным шагом: каждая k-я засечка
        const stride = Math.ceil(all.length / MAX_TICKS);
        const ticks = all.filter((_, index) => index % stride === 0);
        return {
            ticks,
            start: fmtTick(range.from, level.fmt),
            end: fmtTick(range.to, level.fmt),
        };
    }, [range.from, range.to]);

    const picked = rows.filter(row => chosen.has(row.key) && row.recorded > 0);
    const totalBytes = picked.reduce((sum, row) => sum + row.bytes, 0);
    const files = picked.reduce((sum, row) => sum + row.files, 0);

    const toggle = (key: string) => setChosen(current => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
    });

    const submit = async () => {
        if (!picked.length || busy) return;
        setBusy(true);
        setError(null);

        const byDevice = new Map<string, typeof picked>();
        picked.forEach(row => {
            const list = byDevice.get(row.track.device_id) ?? [];
            list.push(row);
            byDevice.set(row.track.device_id, list);
        });

        const title = kind === 'cut' ? 'Склейка' : 'Сегменты';
        const subtitle = `${fmtDate(range.from)} ${fmtTime(range.from)} — ${fmtTime(range.to)}`;

        try {
            for (const [deviceId, list] of byDevice) {
                await start(deviceId, kind, {
                    tracks: list.map(row => ({
                        camera: row.track.camera_id,
                        stream: row.track.stream_key,
                    })),
                    from_ms: Math.round(range.from),
                    to_ms: Math.round(range.to),
                    title: `${title} · ${list.length === 1 ? list[0].name : `${list.length} камеры`}`,
                    subtitle,
                });
            }
            onClose();
        } catch (e) {
            setError(String(e));
            setBusy(false);
        }
    };

    const outputs = kind === 'cut'
        ? `${picked.length} ${filesWord(picked.length)} mp4`
        : `${files} ${filesWord(files)}`;

    return (
        <Modal
            title="Скачать записи"
            size="mid"
            onClose={onClose}
            footer={(
                <>
                    <div className="seg">
                        <button type="button" className={kind === 'cut' ? 'is-on' : ''} onClick={() => setKind('cut')}>
                            Склеить в один файл
                        </button>
                        <button type="button" className={kind === 'zip' ? 'is-on' : ''} onClick={() => setKind('zip')}>
                            Сегменты как есть
                        </button>
                    </div>
                    <div className="dm-total">
                        <b>≈ {fmtBytes(totalBytes)}</b>
                        <span>{outputs}</span>
                    </div>
                    <button type="button" className="btn btn--ghost" onClick={onClose}>Отмена</button>
                    <button type="button" className="btn btn--acc" onClick={submit} disabled={!picked.length || busy}>
                        Скачать
                    </button>
                </>
            )}
        >
            <div className="modal-b dm-body">
                <div className="sect dm-line">
                    <span className="eyebrow">Диапазон</span>

                    {!(fixedRange && selection) && (
                        <div className="seg">
                            <button type="button" className={mode === 'today' ? 'is-on' : ''} onClick={() => setMode('today')}>
                                Сегодня
                            </button>
                            <button
                                type="button"
                                ref={period}
                                className={mode === 'period' ? 'is-on' : ''}
                                onClick={openPeriod}
                            >
                                {mode === 'period' && fromDate ? periodLabel(fromDate, toDate) : 'Промежуток'}
                            </button>
                            <button type="button" className={mode === 'all' ? 'is-on' : ''} onClick={() => setMode('all')}>
                                Всё сразу
                            </button>
                        </div>
                    )}

                    <div className={`dm-when${fixedRange && selection ? ' is-fixed' : ''}`}>
                        <b>{rangeLabel(range.from, range.to)}</b>
                        <span>{spanLabel(range.to - range.from)}</span>
                    </div>
                </div>

                {calAnchor && createPortal(
                    <div className="arch-pop arch-pop--over" ref={cal}>
                        <Calendar
                            month={month}
                            onMonth={setMonth}
                            todayKey={todayKey}
                            from={fromDate}
                            to={toDate}
                            onPick={pickDay}
                        />
                    </div>,
                    document.body,
                )}

                <div className="sect">
                    <span className="eyebrow">
                        Камеры
                        <span className="dm-count">{picked.length} из {rows.length}</span>
                    </span>

                    <div className="dm-scale">
                        <i className="is-start">{scale.start}</i>
                        {scale.ticks.map(tick => (
                            <i
                                key={tick.ms}
                                style={{ left: `${tick.percent}%` }}
                                hidden={tick.percent < EDGE_PERCENT || tick.percent > 100 - EDGE_PERCENT}
                            >
                                {tick.label}
                            </i>
                        ))}
                        <i className="is-end">{scale.end}</i>
                    </div>

                    {rows.map(row => (
                        <button
                            type="button"
                            key={row.key}
                            className={`dm-trk${chosen.has(row.key) && row.recorded > 0 ? ' is-on' : ''}`}
                            disabled={!row.recorded}
                            onClick={() => toggle(row.key)}
                        >
                            <span className="dm-trk-h">
                                <i className="dm-chk" />
                                <span className="dm-nm">
                                    <b>{row.name}</b>
                                    <span>
                                        {row.track.camera_id} · {row.track.stream_key.replace('stream_', 'канал ')}
                                        {row.deleted ? ' · удалена' : ''}
                                    </span>
                                </span>
                                <span className="dm-num">
                                    {row.recorded > 0 && `${fmtDuration(row.recorded)} · ≈ ${fmtBytes(row.bytes)}`}
                                </span>
                            </span>

                            <span className={`dm-lane${row.recorded ? '' : ' is-empty'}`}>
                                {scale.ticks.map(tick => (
                                    <s key={tick.ms} style={{ left: `${tick.percent}%` }} />
                                ))}
                                {row.runs.map((run, index) => {
                                    const left = Math.max(0, percentIn(run.start_ms, range.from, range.to));
                                    const right = Math.min(100, percentIn(run.end_ms, range.from, range.to));
                                    return <i key={index} style={{ left: `${left}%`, width: `${right - left}%` }} />;
                                })}
                                {row.gaps.map((gap, index) => {
                                    const left = Math.max(0, percentIn(gap.start_ms, range.from, range.to));
                                    const right = Math.min(100, percentIn(gap.end_ms, range.from, range.to));
                                    return <u key={index} style={{ left: `${left}%`, width: `${right - left}%` }} />;
                                })}
                            </span>
                        </button>
                    ))}
                </div>

                {error && <div className="sect dm-err">{error}</div>}
            </div>
        </Modal>
    );
}

function periodLabel(from: string, to: string | null): string {
    const short = (key: string) => key.slice(8) + '.' + key.slice(5, 7);
    return to && to !== from ? `${short(from)} — ${short(to)}` : short(from);
}

// Целые сутки и всё длиннее двух суток подписываются датами, короткое — временем границ
function rangeLabel(from: number, to: number): string {
    if (from % DAY_MS === 0 && to % DAY_MS === 0) {
        const last = to - DAY_MS;
        return last > from ? `${fmtDate(from)} — ${fmtDate(last)}` : fmtDate(from);
    }
    if (to - from >= 2 * DAY_MS) return `${fmtDate(from)} — ${fmtDate(to)}`;
    const sameDay = dateKey(from) === dateKey(to);
    return `${fmtDate(from)} ${fmtTime(from)} — ${sameDay ? '' : `${fmtDate(to)} `}${fmtTime(to)}`;
}

function spanLabel(ms: number): string {
    return ms >= 2 * DAY_MS ? `${Math.round(ms / DAY_MS)} сут` : fmtDuration(ms);
}

function filesWord(count: number): string {
    const tail = count % 10;
    if (count % 100 >= 11 && count % 100 <= 14) return 'файлов';
    if (tail === 1) return 'файл';
    if (tail >= 2 && tail <= 4) return 'файла';
    return 'файлов';
}
