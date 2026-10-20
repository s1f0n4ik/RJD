import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Icon } from '../../app/Icons';
import { TrackLane } from './TrackLane';
import type { Track, ZoomLevel } from './model';
import { buildTicks, fmtDate, fmtTick, fmtTime, msAt, percentIn, trackStripes } from './model';

// Карточка кадра в полном экране: кнопки плеера и шкала окна общего таймлайна

interface Props {
    track: Track | null;
    from: number;
    to: number;
    level: ZoomLevel;
    cursorMs: number | null;
    playing: boolean;
    transport: ReactNode;
    tools: ReactNode;
    onSeek: (ms: number) => void;
    onPage: (windows: number) => void;
}

// Столько миллисекунд без движения мыши — и карточка прячется
const IDLE_MS = 3000;

// Сутки окна: одна дата или две, если окно их захватывает
function windowDate(from: number, to: number): string {
    const first = fmtDate(from);
    const last = fmtDate(to - 1);
    return first === last ? first : `${first} — ${last}`;
}

export function FullscreenBar({
    track, from, to, level, cursorMs, playing, transport, tools, onSeek, onPage,
}: Props) {
    const card = useRef<HTMLDivElement | null>(null);
    const scale = useRef<HTMLDivElement | null>(null);
    const hovering = useRef(false);
    const [idle, setIdle] = useState(false);
    const [hover, setHover] = useState<number | null>(null);

    // Любое движение мыши возвращает карточку и заново заводит отсчёт
    useEffect(() => {
        let timer = 0;
        const wake = () => {
            setIdle(false);
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                if (!hovering.current) setIdle(true);
            }, IDLE_MS);
        };
        wake();
        document.addEventListener('mousemove', wake);
        return () => {
            window.clearTimeout(timer);
            document.removeEventListener('mousemove', wake);
        };
    }, []);

    const hidden = idle && playing;

    // Указатель мыши над кадром прячется вместе с карточкой
    useEffect(() => {
        const stage = card.current?.parentElement;
        stage?.classList.toggle('is-idle', hidden);
        return () => stage?.classList.remove('is-idle');
    }, [hidden]);

    const stripes = useMemo(() => (track ? trackStripes(track, from, to) : null), [track, from, to]);
    const ticks = buildTicks(from, to, level);
    const span = to - from;

    const msFromX = (clientX: number) => {
        const box = scale.current?.getBoundingClientRect();
        return box ? msAt(((clientX - box.left) / box.width) * 100, from, to) : from;
    };

    const neighbour = (windows: number) =>
        `${fmtTick(from + windows * span, level.fmt)} — ${fmtTick(to + windows * span, level.fmt)}`;

    const cursorIn = cursorMs !== null && cursorMs >= from && cursorMs <= to;
    const lane = stripes && track && (
        <TrackLane stripes={stripes} from={from} to={to} selected trusted={track.trusted} inset={0} />
    );

    return (
        <>
            <div
                ref={card}
                className={`fsb${hidden ? ' is-hidden' : ''}`}
                onMouseEnter={() => { hovering.current = true; }}
                onMouseLeave={() => { hovering.current = false; }}
            >
                <div className="fsb-head">
                    <span className="fsb-date">{windowDate(from, to)}</span>
                    <div className="fsb-group">{transport}</div>
                    <div className="fsb-group is-end">{tools}</div>
                </div>

                <div className="fsb-strip">
                    <button type="button" className="fsb-page is-prev" onClick={() => onPage(-1)} aria-label="Предыдущее окно">
                        <Icon name="chev" size={16} />
                        <b>{neighbour(-1)}</b>
                    </button>

                    <div
                        ref={scale}
                        className="fsb-scale"
                        onMouseMove={event => setHover(msFromX(event.clientX))}
                        onMouseLeave={() => setHover(null)}
                        onClick={event => onSeek(msFromX(event.clientX))}
                    >
                        <div className="fsb-ticks">
                            {ticks.map(tick => (
                                <i
                                    key={tick.ms}
                                    className={tick.major ? 'is-major' : undefined}
                                    style={{ left: `${percentIn(tick.ms, from, to)}%` }}
                                >
                                    {tick.label && <span>{tick.label}</span>}
                                </i>
                            ))}
                        </div>

                        <div className="fsb-lane">{lane}</div>

                        {cursorMs !== null && cursorIn && (
                            <i className="fsb-cursor" style={{ left: `${percentIn(cursorMs, from, to)}%` }} />
                        )}

                        {hover !== null && (
                            <i className="fsb-hover" style={{ left: `${percentIn(hover, from, to)}%` }}>
                                <b>{fmtTime(hover)}</b>
                            </i>
                        )}

                        {/* Окно увели от ползунка: плашка возвращает к окну с ним */}
                        {cursorMs !== null && !cursorIn && (
                            <button
                                type="button"
                                className={`fsb-away ${cursorMs < from ? 'is-l' : 'is-r'}`}
                                onClick={event => {
                                    event.stopPropagation();
                                    onPage(Math.floor((cursorMs - from) / span));
                                }}
                            >
                                {cursorMs < from ? `◂ ${fmtTime(cursorMs)}` : `${fmtTime(cursorMs)} ▸`}
                            </button>
                        )}
                    </div>

                    <button type="button" className="fsb-page is-next" onClick={() => onPage(1)} aria-label="Следующее окно">
                        <Icon name="chev" size={16} />
                        <b>{neighbour(1)}</b>
                    </button>
                </div>
            </div>

            {hidden && lane && (
                <div className="fsb-edge">
                    {lane}
                    {cursorMs !== null && cursorIn && <i style={{ left: `${percentIn(cursorMs, from, to)}%` }} />}
                </div>
            )}
        </>
    );
}
