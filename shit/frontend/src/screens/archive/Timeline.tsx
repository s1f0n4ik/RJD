import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../../app/Icons';
import { DayPicker } from './DayPicker';
import type { Gap, Track, ZoomLevel } from './model';
import {
    ZOOMS, buildTicks, dateKey, fmtBytes, fmtDateLong, fmtDuration,
    fmtTime, msAt, percentIn, segmentAt, trackKey,
} from './model';
import './timeline.css';

/*
    Таймлайн архива — одно полотно на все камеры.

    Сутками он не ограничен: окно задаётся масштабом и центром, тянется мышью в
    обе стороны и приближается колесом вплоть до минуты. Курсор один и сквозной,
    сетка общая, время читается по верхней шкале сразу для всех дорожек.
*/

/** Таймлайн живёт в своей высоте либо занимает раздел целиком. */
export type TimelineView = 'normal' | 'full';

/** Что даст выбранный диапазон: запрошено, реально записано, чем это станет. */
export interface SelectionInfo {
    requested: number;
    recorded: number;
    gaps: Gap[];
    bytes: number;
}

interface Props {
    from: number;
    to: number;
    zoom: number;
    tracks: Track[];
    cameraNames: Map<string, string>;
    selectedKey: string | null;
    cursorMs: number | null;
    todayKey: string | null;
    selection: { from: number; to: number } | null;
    selectionInfo: SelectionInfo | null;
    picking: boolean;
    view: TimelineView;
    onZoom: (zoom: number, anchorMs?: number) => void;
    onPan: (deltaMs: number) => void;
    onJumpDate: (date: string) => void;
    onSelect: (track: Track) => void;
    onSeek: (track: Track | null, ms: number) => void;
    onSelectionChange: (range: { from: number; to: number } | null) => void;
    onCancelPick: () => void;
    onPicking: () => void;
    onCut: () => void;
    onView: (view: TimelineView) => void;
}

// Сдвиг мыши больше этого — это протяжка, а не клик
const DRAG_THRESHOLD_PX = 4;

// Высота дорожки; ею же считается, на какую из них указывает мышь
const ROW_H = 38;

// Пропуск подписывается, только если занимает столько процентов окна
const GAP_LABEL_MIN_PERCENT = 9;

// Высота таймлайна: по умолчанию три дорожки, ниже головы не опускается
const DEFAULT_H = 200;
const MIN_H = 130;

type Hover = { ms: number; x: number; y: number; track: Track | null };

export function Timeline({
    from, to, zoom, tracks, cameraNames, selectedKey, cursorMs,
    todayKey, selection, selectionInfo, picking, view,
    onZoom, onPan, onJumpDate, onSelect, onSeek, onSelectionChange, onCancelPick,
    onPicking, onCut, onView,
}: Props) {
    const canvas = useRef<HTMLDivElement | null>(null);
    const root = useRef<HTMLDivElement | null>(null);
    const [height, setHeight] = useState(DEFAULT_H);
    const resize = useRef<{ y: number; h: number } | null>(null);
    const [hover, setHover] = useState<Hover | null>(null);
    const [tip, setTip] = useState<{ track: Track; x: number; y: number } | null>(null);

    const drag = useRef<{ x: number; ms: number; moved: boolean; mode: 'pan' | 'pick' } | null>(null);

    const level: ZoomLevel = ZOOMS[zoom];
    const ticks = buildTicks(from, to, level);

    const msFromX = useCallback((clientX: number) => {
        const box = canvas.current?.getBoundingClientRect();
        if (!box) return from;
        return msAt(((clientX - box.left) / box.width) * 100, from, to);
    }, [from, to]);

    // Колесо приближает к точке под указателем, а не к середине окна
    useEffect(() => {
        const element = canvas.current;
        if (!element) return;

        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            const anchor = msFromX(event.clientX);
            const next = event.deltaY < 0 ? zoom + 1 : zoom - 1;
            if (next >= 0 && next < ZOOMS.length) onZoom(next, anchor);
        };

        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
    }, [msFromX, onZoom, zoom]);

    const trackAt = useCallback((clientY: number): Track | null => {
        const rows = canvas.current?.querySelector('.tl-rows');
        if (!rows) return null;

        const box = rows.getBoundingClientRect();
        const index = Math.floor((clientY - box.top + rows.scrollTop) / ROW_H);
        return tracks[index] ?? null;
    }, [tracks]);

    const handleDown = (event: React.MouseEvent<HTMLDivElement>) => {
        const ms = msFromX(event.clientX);
        drag.current = { x: event.clientX, ms, moved: false, mode: picking ? 'pick' : 'pan' };
        if (picking) onSelectionChange({ from: ms, to: ms });
    };

    const handleMove = (event: React.MouseEvent<HTMLDivElement>) => {
        const ms = msFromX(event.clientX);
        setHover({ ms, x: event.clientX, y: event.clientY, track: trackAt(event.clientY) });

        const state = drag.current;
        if (!state) return;

        if (Math.abs(event.clientX - state.x) > DRAG_THRESHOLD_PX) state.moved = true;
        if (!state.moved) return;

        if (state.mode === 'pick') {
            onSelectionChange({ from: Math.min(state.ms, ms), to: Math.max(state.ms, ms) });
        } else {
            // Полотно едет за мышью, поэтому окно двигаем в обратную сторону
            onPan(state.ms - ms);
            state.x = event.clientX;
        }
    };

    const handleUp = (event: React.MouseEvent<HTMLDivElement>) => {
        const state = drag.current;
        drag.current = null;
        if (!state || state.moved || picking) return;

        // Клик без протяжки — перемотка. Курсор можно ставить и в пустоту:
        // плеер тогда честно скажет, что записи здесь нет
        const track = trackAt(event.clientY);
        if (track) onSelect(track);
        onSeek(track, msFromX(event.clientX));
    };

    /* Тянем якорь вверх — таймлайн отбирает высоту у кадра. Высота живая, а не
       два состояния: при двух дорожках переключение ступенями ничего не меняло */
    const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        resize.current = { y: event.clientY, h: root.current?.offsetHeight ?? height };
    };

    const doResize = (event: React.PointerEvent<HTMLDivElement>) => {
        const state = resize.current;
        if (!state) return;

        const limit = window.innerHeight - 180;
        setHeight(Math.max(MIN_H, Math.min(limit, state.h + (state.y - event.clientY))));
    };

    const stopResize = (event: React.PointerEvent<HTMLDivElement>) => {
        if (resize.current) event.currentTarget.releasePointerCapture(event.pointerId);
        resize.current = null;
    };

    return (
        <div
            className={`tl tl--${view}`}
            ref={root}
            style={view === 'full' ? undefined : { height }}
        >
            {view !== 'full' && (
                <div
                    className="tl-grip"
                    title="Потяните, чтобы изменить высоту"
                    onPointerDown={startResize}
                    onPointerMove={doResize}
                    onPointerUp={stopResize}
                    onPointerCancel={stopResize}
                    onDoubleClick={() => setHeight(DEFAULT_H)}
                >
                    <i />
                </div>
            )}

            <div className="tl-head">
                <div className="tl-now">
                    <b>{cursorMs === null ? '—' : fmtTime(cursorMs)}</b>
                    <span>{cursorMs === null ? 'курсор не поставлен' : fmtDateLong(cursorMs)}</span>
                </div>

                <DayPicker
                    date={dateKey(cursorMs ?? (from + (to - from) / 2))}
                    todayKey={todayKey}
                    onChange={onJumpDate}
                />

                <div className="tl-zoom">
                    <button type="button" onClick={() => onZoom(zoom - 1)} disabled={zoom === 0} title="Отдалить">−</button>
                    <span className="lvl">{level.label}</span>
                    <button
                        type="button"
                        onClick={() => onZoom(zoom + 1)}
                        disabled={zoom === ZOOMS.length - 1}
                        title="Приблизить"
                    >
                        +
                    </button>
                </div>

                {selection && selectionInfo && (
                    <div className="tl-pick">
                        <span className="range">{fmtTime(selection.from)} — {fmtTime(selection.to)}</span>
                        <span className="fact">запрошено {fmtDuration(selectionInfo.requested)}</span>
                        <span className="fact">в записи {fmtDuration(selectionInfo.recorded)}</span>
                        <span className="fact">≈ {fmtBytes(selectionInfo.bytes)}</span>
                        {selectionInfo.gaps.length > 0 && (
                            <span className="warn">
                                короче на {fmtDuration(selectionInfo.requested - selectionInfo.recorded)}
                            </span>
                        )}
                        <button type="button" className="btn btn--sm" onClick={onCancelPick}>
                            Отменить
                        </button>
                        <button type="button" className="btn btn--sm btn--acc" onClick={onCut}>
                            Склеить в MP4
                        </button>
                    </div>
                )}

                <div className="tl-tools">
                    <button
                        type="button"
                        className={`tl-tool${picking ? ' is-on' : ''}`}
                        onClick={onPicking}
                    >
                        <Icon name="cursor" size={13} />
                        Выбор диапазона
                    </button>
                    <button
                        type="button"
                        className={`tl-tool${view === 'full' ? ' is-on' : ''}`}
                        onClick={() => onView(view === 'full' ? 'normal' : 'full')}
                    >
                        <Icon name="full" size={13} />
                        {view === 'full' ? 'Свернуть' : 'На весь раздел'}
                    </button>
                </div>
            </div>

            <div className="tl-field">
                <div className="tl-names">
                    <div className="tl-corner">Камера</div>
                    <div className="tl-names-body">
                        {tracks.map(track => {
                            const key = trackKey(track);
                            const deleted = !cameraNames.has(track.camera_id);
                            const name = cameraNames.get(track.camera_id) || track.camera_id;

                            return (
                                <button
                                    type="button"
                                    key={key}
                                    className={`tl-name${key === selectedKey ? ' is-sel' : ''}`}
                                    onClick={() => onSelect(track)}
                                    onMouseEnter={event => {
                                        const box = event.currentTarget.getBoundingClientRect();
                                        setTip({ track, x: box.right + 8, y: box.top });
                                    }}
                                    onMouseLeave={() => setTip(null)}
                                >
                                    {deleted ? (
                                        <span
                                            className="tl-st is-gone"
                                            title="Камера удалена из конфигурации, записи остались"
                                        />
                                    ) : (
                                        <span className={`tl-st${track.segment_count ? '' : ' is-off'}`} />
                                    )}
                                    <span className="tl-nm">
                                        <b>{name}</b>
                                        <span>
                                            {track.camera_id} · {track.stream_key.replace('stream_', 'канал ')}
                                            {deleted ? ' · удалена' : ''}
                                        </span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div
                    className={`tl-canvas${picking ? ' is-picking' : ''}`}
                    ref={canvas}
                    onMouseDown={handleDown}
                    onMouseMove={handleMove}
                    onMouseUp={handleUp}
                    onMouseLeave={() => { setHover(null); drag.current = null; }}
                >
                    <div className="tl-scale">
                        {ticks.map(tick => (
                            <i
                                key={tick.ms}
                                className={`tl-tick${tick.major ? '' : ' is-minor'}`}
                                style={{ left: `${percentIn(tick.ms, from, to)}%` }}
                            >
                                {tick.label && <span>{tick.label}</span>}
                            </i>
                        ))}
                    </div>

                    <div className="tl-rows">
                        <div className="tl-grid">
                            {ticks.map(tick => (
                                <i
                                    key={tick.ms}
                                    className={tick.major ? '' : 'is-minor'}
                                    style={{ left: `${percentIn(tick.ms, from, to)}%` }}
                                />
                            ))}
                        </div>

                        {tracks.map(track => {
                            const key = trackKey(track);
                            return (
                                <div key={key} className={`tl-row${key === selectedKey ? ' is-sel' : ''}`}>
                                    {track.runs.map((run, index) => (
                                        <i
                                            key={`r${index}`}
                                            className={`tl-run${track.trusted ? '' : ' is-doubt'}`}
                                            style={{
                                                left: `${percentIn(run.start_ms, from, to)}%`,
                                                width: `${percentIn(run.end_ms, from, to) - percentIn(run.start_ms, from, to)}%`,
                                            }}
                                        />
                                    ))}

                                    {track.gaps.map((gap, index) => {
                                        const left = percentIn(gap.start_ms, from, to);
                                        const width = percentIn(gap.end_ms, from, to) - left;
                                        return (
                                            <i
                                                key={`g${index}`}
                                                className={`tl-gap${gap.kind === 'power' ? ' is-power' : ''}`}
                                                style={{ left: `${left}%`, width: `${width}%` }}
                                                title={`${fmtTime(gap.start_ms)} → ${fmtTime(gap.end_ms)}`}
                                            />
                                        );
                                    })}

                                    {track.gaps
                                        .filter(gap => percentIn(gap.end_ms, from, to) - percentIn(gap.start_ms, from, to) > GAP_LABEL_MIN_PERCENT)
                                        .map((gap, index) => (
                                            <span
                                                key={`gl${index}`}
                                                className={`tl-gap-lab${gap.kind === 'power' ? ' is-power' : ''}`}
                                                style={{
                                                    left: `${(percentIn(gap.start_ms, from, to) + percentIn(gap.end_ms, from, to)) / 2}%`,
                                                }}
                                            >
                                                {gap.kind === 'power' ? 'изделие было обесточено · ' : 'запись прервалась · '}
                                                {fmtDuration(gap.end_ms - gap.start_ms)}
                                            </span>
                                        ))}

                                    {!track.segment_count && (
                                        <span className="tl-row-none">за это время записей нет</span>
                                    )}
                                </div>
                            );
                        })}

                        {!tracks.length && (
                            <div className="tl-empty">За это время не писала ни одна камера</div>
                        )}

                        {selection && (
                            <i
                                className="tl-pickband"
                                style={{
                                    left: `${percentIn(selection.from, from, to)}%`,
                                    width: `${percentIn(selection.to, from, to) - percentIn(selection.from, from, to)}%`,
                                }}
                            />
                        )}

                        {cursorMs !== null && cursorMs >= from && cursorMs <= to && (
                            <div className="tl-cursor" style={{ left: `${percentIn(cursorMs, from, to)}%` }} />
                        )}

                        {hover && (
                            <div className="tl-hover" style={{ left: `${percentIn(hover.ms, from, to)}%` }} />
                        )}
                    </div>
                </div>
            </div>

            {hover && <Peek hover={hover} />}
            {tip && <NameTip tip={tip} name={cameraNames.get(tip.track.camera_id)} />}
        </div>
    );
}

/**
 * Превью под указателем. Живёт порталом в body: внутри таймлайна его резали бы
 * границы полотна, а всплывать оно должно поверх кадра.
 */
function Peek({ hover }: { hover: Hover }) {
    const segment = hover.track ? segmentAt(hover.track, hover.ms) : null;

    return createPortal(
        <div className="tl-peek" style={{ left: hover.x, top: hover.y }}>
            <div className={`tl-peek-shot${segment ? '' : ' is-none'}`}>
                {segment ? '' : 'записи в этот момент нет'}
            </div>
            <div className="tl-peek-meta">
                <span className="t">{fmtTime(hover.ms)}</span>
                <span className="f">{segment ? segment.file : hover.track?.camera_id ?? '—'}</span>
            </div>
        </div>,
        document.body,
    );
}

/** Подробности камеры при наведении на имя. */
function NameTip({ tip, name }: { tip: { track: Track; x: number; y: number }; name?: string }) {
    const { track } = tip;

    return createPortal(
        <div className="tl-tip" style={{ left: tip.x, top: tip.y }}>
            <b>{name || track.camera_id}</b>
            <div className="r"><span>Идентификатор</span><span>{track.camera_id}</span></div>
            <div className="r"><span>Поток</span><span>{track.stream_key}</span></div>
            <div className="r"><span>Устройство</span><span>{track.device_name}</span></div>
            <div className="r"><span>Сегментов в окне</span><span>{track.segment_count}</span></div>
            <div className="r"><span>Записано</span><span>{fmtDuration(track.recorded_ms)}</span></div>
            {!track.trusted && <div className="r"><span>Время</span><span>недостоверно</span></div>}
        </div>,
        document.body,
    );
}
