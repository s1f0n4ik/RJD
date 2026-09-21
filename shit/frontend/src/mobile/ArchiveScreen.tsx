import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOutletContext } from 'react-router-dom';
import { Icon } from '../app/Icons';
import { Select } from '../app/Select';
import { useSystem } from '../app/SystemContext';
import { useDeviceClock } from '../app/useDeviceClock';
import { ArchivePlayer } from '../screens/archive/ArchivePlayer';
import type { ArchiveShape, Segment, Track } from '../screens/archive/model';
import {
    DAY_MS, DEFAULT_ZOOM, ZOOMS, buildTicks, dateKey, dayStartMs, fetchSegments, fetchShape, fmtDate, fmtDateLong,
    fmtDuration, fmtTime, gapsWithin, percentIn, recordedWithin, segmentAt, trackKey, trackTitle,
} from '../screens/archive/model';
import type { ShellContext } from './MobileShell';
import '../screens/archive/archive.css';

const REFRESH_MS = 10_000;
const SPEEDS = [0.5, 1, 2, 4];
const SEGMENT_SPAN_MS = 2 * 60 * 60 * 1000;
const SEGMENT_MARGIN_MS = 20 * 60 * 1000;
// Сдвиг пальца больше этого — протяжка, а не касание
const DRAG_PX = 6;
// Подписей засечек на полосе не больше этого: иначе налезают
const MAX_LABELS = 6;

interface Day {
    key: string;
    start: number;
    recorded: number;
    gaps: number;
}

// Дни с записью на дорожке, свежие сверху
function daysOf(track: Track): Day[] {
    const keys = new Set<string>();
    track.runs.forEach(run => {
        for (let ms = dayStartMs(dateKey(run.start_ms)); ms < run.end_ms; ms += DAY_MS) keys.add(dateKey(ms));
    });
    return [...keys]
        .map(key => {
            const start = dayStartMs(key);
            return { key, start, recorded: recordedWithin(track, start, start + DAY_MS), gaps: gapsWithin(track, start, start + DAY_MS).length };
        })
        .filter(day => day.recorded > 0)
        .sort((a, b) => b.start - a.start);
}

export default function ArchiveScreen() {
    const { cameras } = useSystem();
    const { unixMs } = useDeviceClock();
    const { slot } = useOutletContext<ShellContext>();

    const [shape, setShape] = useState<ArchiveShape | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [segments, setSegments] = useState<Segment[]>([]);
    const loadedSpan = useRef<{ key: string; from: number; to: number } | null>(null);

    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [cursorMs, setCursorMs] = useState<number | null>(null);
    const [seek, setSeek] = useState({ ms: 0, token: 0 });
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);

    // Окно таймлайна: центр и масштаб
    const [center, setCenter] = useState<number>(() => Date.now());
    const [zoom, setZoom] = useState(DEFAULT_ZOOM);
    const span = ZOOMS[zoom].span;
    const from = center - span / 2;
    const to = center + span / 2;

    const barRef = useRef<HTMLDivElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    // Пальцы на полосе: один тянет окно, два меняют масштаб
    const pointers = useRef(new Map<number, number>());
    const drag = useRef<{ x: number; center: number; moved: boolean } | null>(null);
    const pinch = useRef<{ dist: number } | null>(null);

    const cameraNames = useMemo(() => {
        const names = new Map<string, string>();
        cameras.forEach(camera => names.set(camera.id, camera.display_name || camera.id));
        return names;
    }, [cameras]);

    const tracks = useMemo(() => {
        const list = [...(shape?.tracks ?? [])];
        if (!cameraNames.size) return list;
        return list.sort((first, second) => {
            const gone = Number(!cameraNames.has(first.camera_id)) - Number(!cameraNames.has(second.camera_id));
            return gone || trackKey(first).localeCompare(trackKey(second));
        });
    }, [shape, cameraNames]);

    const selected = tracks.find(track => trackKey(track) === selectedKey) || null;
    const days = useMemo(() => (selected ? daysOf(selected) : []), [selected]);
    const dayKey = cursorMs === null ? null : dateKey(cursorMs);
    const todayKey = unixMs === null ? null : dateKey(unixMs);

    useEffect(() => {
        const load = () => fetchShape()
            .then(next => { setShape(next); setError(null); })
            .catch(e => setError(String(e)));
        load();
        const timer = window.setInterval(load, REFRESH_MS);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!selected || cursorMs === null) return;
        const key = trackKey(selected);
        const loaded = loadedSpan.current;
        if (loaded && loaded.key === key && cursorMs > loaded.from + SEGMENT_MARGIN_MS && cursorMs < loaded.to - SEGMENT_MARGIN_MS) return;
        const wanted = { key, from: cursorMs - SEGMENT_SPAN_MS / 2, to: cursorMs + SEGMENT_SPAN_MS / 2 };
        loadedSpan.current = wanted;
        fetchSegments(selected, wanted.from, wanted.to)
            .then(data => { if (loadedSpan.current === wanted) setSegments(data.segments); })
            .catch(() => { if (loadedSpan.current === wanted) loadedSpan.current = null; });
    }, [selected, cursorMs]);

    // Дорожка с записью выбирается сама, курсор и окно встают на хвост последней записи
    useEffect(() => {
        if (!tracks.length) return;
        if (selectedKey && tracks.some(track => trackKey(track) === selectedKey)) return;
        const withData = tracks.find(track => track.segment_count > 0) || tracks[0];
        setSelectedKey(trackKey(withData));
        const last = withData.runs[withData.runs.length - 1];
        if (cursorMs === null && last) {
            const ms = Math.max(last.start_ms, last.end_ms - 30_000);
            setCursorMs(ms);
            setSeek({ ms, token: Date.now() });
            setCenter(ms + ZOOMS[DEFAULT_ZOOM].span / 4);
        }
    }, [tracks, selectedKey, cursorMs]);

    // При воспроизведении курсор не уходит за правый край окна
    useEffect(() => {
        if (!playing || cursorMs === null || drag.current) return;
        if (cursorMs > to - span * 0.08 || cursorMs < from) setCenter(cursorMs + span * 0.4);
    }, [playing, cursorMs, from, to, span]);

    const handleSeek = useCallback((ms: number) => {
        setCursorMs(ms);
        setSeek({ ms, token: Date.now() });
    }, []);

    const selectTrack = (key: string) => {
        setSelectedKey(key);
        if (cursorMs !== null) setSeek({ ms: cursorMs, token: Date.now() });
    };

    const jump = (deltaSec: number) => {
        if (cursorMs !== null) handleSeek(cursorMs + deltaSec * 1000);
    };

    // Приближение с удержанием точки на месте
    const zoomTo = useCallback((next: number, anchorMs?: number) => {
        if (next < 0 || next >= ZOOMS.length) return;
        const anchor = anchorMs ?? center;
        const ratio = (anchor - from) / span;
        setZoom(next);
        setCenter(anchor - (ratio - 0.5) * ZOOMS[next].span);
    }, [center, from, span]);

    const msAtX = (x: number) => {
        const rect = barRef.current!.getBoundingClientRect();
        return from + Math.min(1, Math.max(0, (x - rect.left) / rect.width)) * span;
    };

    const onPointerDown = (e: React.PointerEvent) => {
        barRef.current!.setPointerCapture(e.pointerId);
        pointers.current.set(e.pointerId, e.clientX);
        if (pointers.current.size === 1) {
            drag.current = { x: e.clientX, center, moved: false };
        } else {
            const [a, b] = [...pointers.current.values()];
            pinch.current = { dist: Math.abs(a - b) };
            if (drag.current) drag.current.moved = true;
        }
    };

    const onPointerMove = (e: React.PointerEvent) => {
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, e.clientX);
        if (pointers.current.size >= 2 && pinch.current) {
            const [a, b] = [...pointers.current.values()];
            const dist = Math.abs(a - b);
            const ratio = dist / Math.max(1, pinch.current.dist);
            if (ratio > 1.3 || ratio < 0.77) {
                zoomTo(zoom + (ratio > 1 ? 1 : -1), msAtX((a + b) / 2));
                pinch.current = { dist };
            }
            return;
        }
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        if (!d.moved && Math.abs(dx) < DRAG_PX) return;
        d.moved = true;
        const width = barRef.current!.getBoundingClientRect().width;
        setCenter(d.center - (dx / width) * span);
    };

    const onPointerUp = (e: React.PointerEvent) => {
        pointers.current.delete(e.pointerId);
        if (pointers.current.size === 0) {
            const d = drag.current;
            drag.current = null;
            pinch.current = null;
            if (d && !d.moved && selected) handleSeek(msAtX(e.clientX));
        }
    };

    const currentSegment = cursorMs === null ? null : segmentAt(segments, cursorMs);
    const ticks = useMemo(() => buildTicks(from, to, ZOOMS[zoom]), [from, to, zoom]);
    const majors = ticks.filter(t => t.major).length;
    const labelEvery = Math.max(1, Math.ceil(majors / MAX_LABELS));
    const runs = selected ? selected.runs.filter(run => run.end_ms > from && run.start_ms < to) : [];
    const gaps = selected ? gapsWithin(selected, from, to) : [];
    const pct = (ms: number) => Math.min(100, Math.max(0, percentIn(ms, from, to)));
    const loading = shape === null && !error;

    return (
        <section className="m-screen">
            {slot && createPortal(
                <div className="m-hd-sel">
                    <Select
                        value={selectedKey ?? ''}
                        placeholder={loading ? '…' : 'нет записей'}
                        disabled={!tracks.length}
                        options={tracks.map(track => ({ value: trackKey(track), label: trackTitle(track, tracks, cameraNames) }))}
                        onChange={selectTrack}
                    />
                </div>,
                slot,
            )}
            <div className="m-scroll">
                <div className={`m-vf${loading ? ' is-wait' : ''}`} ref={boxRef}>
                    {loading && <span className="spin" />}
                    <ArchivePlayer
                        track={selected}
                        segments={segments}
                        seek={seek}
                        playing={playing}
                        speed={speed}
                        onProgress={ms => { if (!drag.current) setCursorMs(ms); }}
                        onPlayingChange={setPlaying}
                        onTrackEnd={() => setPlaying(false)}
                        onSeekTo={handleSeek}
                    />
                    {selected && (
                        <div className="m-ov m-ov-br">
                            <button className="m-vbtn" aria-label="Во весь экран" onClick={() => boxRef.current?.requestFullscreen?.()}>
                                <Icon name="full" />
                            </button>
                        </div>
                    )}
                </div>

                <div className="m-tl">
                    <div
                        className="m-tl-bar"
                        ref={barRef}
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={onPointerUp}
                    >
                        {ticks.map(t => <span key={t.ms} className={`tick${t.major ? ' major' : ''}`} style={{ left: `${pct(t.ms)}%` }} />)}
                        {runs.map((run, i) => (
                            <i key={i} style={{ left: `${pct(run.start_ms)}%`, width: `${pct(run.end_ms) - pct(run.start_ms)}%` }} />
                        ))}
                        {gaps.map((gap, i) => (
                            <i key={`g${i}`} className="gap" style={{ left: `${pct(gap.start_ms)}%`, width: `${pct(gap.end_ms) - pct(gap.start_ms)}%` }} />
                        ))}
                        {unixMs !== null && unixMs > from && unixMs < to && <span className="now" style={{ left: `${pct(unixMs)}%` }} />}
                        {cursorMs !== null && cursorMs > from && cursorMs < to && <span className="ph" style={{ left: `${pct(cursorMs)}%` }} />}
                    </div>
                    <div className="m-tl-ticks">
                        {ticks.filter(t => t.major).map((t, i) => i % labelEvery === 0 && (
                            <span key={t.ms} style={{ left: `${pct(t.ms)}%` }}>{t.label}</span>
                        ))}
                    </div>
                    <div className="m-tl-zoom">
                        <button aria-label="Дальше" disabled={zoom === 0} onClick={() => zoomTo(zoom - 1)}>−</button>
                        <span>{ZOOMS[zoom].label}</span>
                        <button aria-label="Ближе" disabled={zoom === ZOOMS.length - 1} onClick={() => zoomTo(zoom + 1)}>+</button>
                        {cursorMs !== null && (cursorMs < from || cursorMs > to) && (
                            <button className="to-cur" onClick={() => setCenter(cursorMs)}>к курсору</button>
                        )}
                    </div>
                </div>

                <div className={`m-tr${selected ? '' : ' is-dim'}`}>
                    <button className="m-vbtn" aria-label="Назад 10 секунд" onClick={() => jump(-10)}><Icon name="prev" /></button>
                    <button className="m-vbtn big" aria-label={playing ? 'Пауза' : 'Воспроизвести'} onClick={() => setPlaying(v => !v)}>
                        <Icon name={playing ? 'pause' : 'play'} />
                    </button>
                    <button className="m-vbtn" aria-label="Вперёд 10 секунд" onClick={() => jump(10)}><Icon name="next" /></button>
                    {loading ? (
                        <div className="tm">
                            <span className="skel h16" style={{ width: 80 }} />
                            <small><span className="skel h10" style={{ width: 140, marginTop: 6 }} /></small>
                        </div>
                    ) : (
                        <div className="tm">
                            {cursorMs === null ? '—' : fmtTime(cursorMs)}
                            <small className="seps">
                                {cursorMs !== null && <span>{fmtDate(cursorMs)}</span>}
                                {currentSegment && <span>сегмент {fmtTime(currentSegment.start_ms)}–{fmtTime(currentSegment.end_ms)}</span>}
                            </small>
                        </div>
                    )}
                    {!loading && (
                        <button className="rate" onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}>
                            {String(speed).replace('.', ',')}×
                        </button>
                    )}
                </div>

                {error && <div className="banner is-err"><Icon name="warn" /><span>Архив не отвечает: {error}</span></div>}

                {loading && (
                    <>
                        <div className="m-grp">Дни с записью</div>
                        {[0, 1, 2].map(i => (
                            <div key={i} className="m-li">
                                <Icon name="cal" className="ico lead" />
                                <div className="t"><span className="skel h16" style={{ width: '60%' }} /><span className="skel h10" style={{ width: '40%', marginTop: 8 }} /></div>
                                <span className="skel h16" style={{ width: 52 }} />
                            </div>
                        ))}
                    </>
                )}

                {shape && !tracks.length && (
                    <div className="empty">
                        <Icon name="arch" />
                        <b>Записей нет</b>
                        <p>Архив появится, когда у камеры будет поток с назначением «Запись».</p>
                    </div>
                )}

                {days.length > 0 && <div className="m-grp">Дни с записью<span className="m-sp">{days.length}</span></div>}
                {days.map(day => (
                    <button
                        key={day.key}
                        className={`m-li${day.key === dayKey ? ' is-on' : ''}`}
                        onClick={() => {
                            const run = selected!.runs.find(r => r.end_ms > day.start);
                            const ms = Math.max(run?.start_ms ?? day.start, day.start);
                            handleSeek(ms);
                            setCenter(ms + span / 4);
                        }}
                    >
                        <Icon name="cal" className="ico lead" />
                        <div className="t">
                            <b>{fmtDateLong(day.start)}</b>
                            <span>{day.key === todayKey ? 'сегодня' : day.gaps ? `${day.gaps} пропуск(а)` : 'без пропусков'}</span>
                        </div>
                        <div className="v">{fmtDuration(day.recorded)}</div>
                    </button>
                ))}
            </div>
        </section>
    );
}
