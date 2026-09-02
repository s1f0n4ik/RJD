import { useCallback, useRef, useState } from 'react';

import type { Gap, Segment, Track } from './model';
import {
    dayStartMs, fmtBytes, fmtDuration, fmtTime, msAtPercent, percentOf,
    segmentAt, trackKey, trackTitle,
} from './model';

/*
    Дорожки суток. Дорожка — это пишущий поток, а не камера: два потока одной
    камеры пишутся независимо, у них разные разрывы, и сливать их в одну полосу
    значит прятать, что второй канал молчит.
*/

/** Что даст выбранный диапазон: запрошено, реально записано, чем это станет. */
export interface SelectionInfo {
    requested: number;
    recorded: number;
    gaps: Gap[];
    bytes: number;
}

interface Props {
    date: string;
    tracks: Track[];
    cameraNames: Map<string, string>;
    selectedKey: string | null;
    cursorMs: number | null;
    selection: { from: number; to: number } | null;
    selectionInfo: SelectionInfo | null;
    picking: boolean;
    onSelect: (track: Track) => void;
    onSeek: (track: Track, ms: number) => void;
    onSelectionChange: (range: { from: number; to: number } | null) => void;
    onCut: () => void;
}

const HOURS = ['00', '03', '06', '09', '12', '15', '18', '21', '24'];

export function Timeline({
    date, tracks, cameraNames, selectedKey, cursorMs, selection, selectionInfo,
    picking, onSelect, onSeek, onSelectionChange, onCut,
}: Props) {
    const dayStart = dayStartMs(date);
    const [hover, setHover] = useState<{ key: string; percent: number; ms: number } | null>(null);
    const dragFrom = useRef<number | null>(null);

    const msFromEvent = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const percent = ((event.clientX - rect.left) / rect.width) * 100;
        return { percent, ms: msAtPercent(percent, dayStart) };
    }, [dayStart]);

    const handleDown = (track: Track) => (event: React.MouseEvent<HTMLDivElement>) => {
        const { ms } = msFromEvent(event);
        onSelect(track);

        if (picking) {
            dragFrom.current = ms;
            onSelectionChange({ from: ms, to: ms });
        } else {
            onSeek(track, ms);
        }
    };

    const handleMove = (track: Track) => (event: React.MouseEvent<HTMLDivElement>) => {
        const { percent, ms } = msFromEvent(event);
        setHover({ key: trackKey(track), percent, ms });

        if (picking && dragFrom.current !== null) {
            const from = Math.min(dragFrom.current, ms);
            const to = Math.max(dragFrom.current, ms);
            onSelectionChange({ from, to });
        }
    };

    const handleUp = () => {
        dragFrom.current = null;
    };

    return (
        <div className="arch-timeline" onMouseUp={handleUp} onMouseLeave={() => setHover(null)}>
            {/* Всё о диапазоне живёт здесь, у дорожек: правая колонка не должна прыгать */}
            {picking && selection && selectionInfo && (
                <div className="arch-pickbar">
                    <span className="arch-pickbar-range">
                        {fmtTime(selection.from)} — {fmtTime(selection.to)}
                    </span>
                    <span className="arch-pickbar-fact">
                        запрошено {fmtDuration(selectionInfo.requested)}
                    </span>
                    <span className="arch-pickbar-fact">
                        в записи {fmtDuration(selectionInfo.recorded)}
                    </span>
                    <span className="arch-pickbar-fact">
                        ≈ {fmtBytes(selectionInfo.bytes)}
                    </span>

                    {selectionInfo.gaps.length > 0 && (
                        <span className="arch-pickbar-warn">
                            {selectionInfo.gaps.length === 1
                                ? 'внутри пропуск'
                                : `внутри пропусков: ${selectionInfo.gaps.length}`}
                            {' '}— итог короче на {fmtDuration(selectionInfo.requested - selectionInfo.recorded)}
                        </span>
                    )}

                    <div className="arch-pickbar-acts">
                        <button type="button" className="btn" onClick={() => onSelectionChange(null)}>
                            Отменить выбор
                        </button>
                        <button type="button" className="btn btn--acc" onClick={onCut}>
                            Склеить в MP4
                        </button>
                    </div>
                </div>
            )}

            <div className="arch-tl-grid">
                <div className="arch-tl-scale">
                    {HOURS.map(hour => <span key={hour}>{hour}</span>)}
                </div>
            </div>

            <div className="arch-tl-body">
                {tracks.map(track => {
                    const key = trackKey(track);
                    const selected = key === selectedKey;
                    const peek = hover && hover.key === key ? hover : null;
                    const peekSegment = peek ? segmentAt(track, peek.ms) : null;

                    return (
                        <div key={key} className={`arch-trk${selected ? ' is-sel' : ''}`}>
                            <button
                                type="button"
                                className="arch-trk-name"
                                onClick={() => onSelect(track)}
                                title={track.device_name}
                            >
                                <span className={`dot${track.segment_count ? '' : ' is-off'}`} />
                                <b>{trackTitle(track, tracks, cameraNames)}</b>
                                {!track.trusted && <span className="arch-tag is-doubt">≈ время</span>}
                            </button>

                            <div className="arch-trk-wrap">
                                <div
                                    className="arch-trk-strip"
                                    onMouseDown={handleDown(track)}
                                    onMouseMove={handleMove(track)}
                                >
                                    {track.runs.map((run, index) => (
                                        <i
                                            key={`run-${index}`}
                                            className={`arch-seg${track.trusted ? '' : ' is-doubt'}`}
                                            style={{
                                                left: `${percentOf(run.start_ms, dayStart)}%`,
                                                width: `${percentOf(run.end_ms, dayStart) - percentOf(run.start_ms, dayStart)}%`,
                                            }}
                                        />
                                    ))}

                                    {track.gaps.map((gap, index) => {
                                        const left = percentOf(gap.start_ms, dayStart);
                                        const width = percentOf(gap.end_ms, dayStart) - left;
                                        return (
                                            <i
                                                key={`gap-${index}`}
                                                className={`arch-gap${gap.kind === 'power' ? ' is-power' : ''}`}
                                                style={{ left: `${left}%`, width: `${width}%` }}
                                                title={`${fmtTime(gap.start_ms)} → ${fmtTime(gap.end_ms)}`}
                                            />
                                        );
                                    })}

                                    {/* Крупный пропуск подписываем прямо в дыре — мелкие остаются штриховкой */}
                                    {track.gaps
                                        .filter(gap => gap.end_ms - gap.start_ms > 20 * 60 * 1000)
                                        .map((gap, index) => (
                                            <span
                                                key={`lab-${index}`}
                                                className="arch-gap-label"
                                                style={{
                                                    left: `${(percentOf(gap.start_ms, dayStart) + percentOf(gap.end_ms, dayStart)) / 2}%`,
                                                }}
                                            >
                                                {fmtDuration(gap.end_ms - gap.start_ms)}
                                            </span>
                                        ))}

                                    {selection && (
                                        <i
                                            className="arch-pick"
                                            style={{
                                                left: `${percentOf(selection.from, dayStart)}%`,
                                                width: `${percentOf(selection.to, dayStart) - percentOf(selection.from, dayStart)}%`,
                                            }}
                                        />
                                    )}

                                    {!track.segment_count && (
                                        <span className="arch-trk-empty">за этот день записей нет</span>
                                    )}

                                    {cursorMs !== null && (
                                        <span
                                            className="arch-cursor"
                                            style={{ left: `${percentOf(cursorMs, dayStart)}%` }}
                                        />
                                    )}

                                    {peek && <span className="arch-hover" style={{ left: `${peek.percent}%` }} />}
                                </div>

                                {peek && <Peek percent={peek.percent} ms={peek.ms} segment={peekSegment} />}
                            </div>

                            <div className="arch-trk-num">
                                {track.recorded_ms ? fmtDuration(track.recorded_ms) : '—'}
                            </div>
                        </div>
                    );
                })}

                {!tracks.length && (
                    <div className="arch-tl-none">За выбранные сутки записей нет ни на одной камере</div>
                )}
            </div>
        </div>
    );
}

/** Всплывающее превью под курсором: что именно лежит в этой секунде. */
function Peek({ percent, ms, segment }: { percent: number; ms: number; segment: Segment | null }) {
    return (
        <div className="arch-peek" style={{ left: `${percent}%` }}>
            <div className="arch-peek-shot" />
            <div className="arch-peek-meta">
                <span className="t">{fmtTime(ms)}</span>
                <span className="f">
                    {segment ? segment.file : 'записи нет'}
                </span>
            </div>
        </div>
    );
}
