import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../../app/Icons';
import { useSystem } from '../../app/SystemContext';
import { useDeviceClock } from '../../app/useDeviceClock';
import { ArchivePlayer } from './ArchivePlayer';
import { DownloadModal } from './DownloadModal';
import { FullscreenBar } from './FullscreenBar';
import { Timeline } from './Timeline';
import type { TimelineView } from './Timeline';
import type { ArchiveShape, ArchiveState, Segment, Track } from './model';
import {
    DAY_MS, DEFAULT_ZOOM, ZOOMS, dateKey, dayStartMs, fetchSegments,
    fetchShape, fetchState, fmtBytes, fmtDate, fmtDuration, fmtTime,
    goneWithin, recordedWithin, segmentAt, segmentUrl, trackKey,
} from './model';
import { formatBytes } from '../devices/model';
import './archive.css';

// Экран архива

const REFRESH_MS = 10_000;
const SPEEDS = [0.5, 1, 2, 4];

// Удержание ±10 с: первый повтор через HOLD_DELAY_MS, дальше шаг каждые HOLD_STEP_MS
const HOLD_DELAY_MS = 300;
const HOLD_STEP_MS = 100;

// Сколько времени сегментов держим у выбранной дорожки и за сколько до края
// подгружаем следующую порцию
const SEGMENT_SPAN_MS = 2 * 60 * 60 * 1000;
const SEGMENT_MARGIN_MS = 20 * 60 * 1000;

// Задача склейки или выгрузки, идущая на устройстве
export function ArchiveScreen() {
    const { cameras } = useSystem();
    const clock = useDeviceClock();

    // Окно таймлайна: центр и масштаб. Суток здесь нет — только время
    const [center, setCenter] = useState<number>(() => Date.now());
    const [zoom, setZoom] = useState(DEFAULT_ZOOM);
    const [view, setView] = useState<TimelineView>('normal');

    // Форма архива: куски и разрывы всех дорожек за всю глубину. Весит
    // килобайты, поэтому берётся целиком — сдвиг и зум в сеть не ходят
    const [shape, setShape] = useState<ArchiveShape | null>(null);
    // Сегменты только выбранной дорожки, вокруг курсора
    const [segments, setSegments] = useState<Segment[]>([]);
    const loadedSpan = useRef<{ key: string; from: number; to: number } | null>(null);
    const [state, setState] = useState<ArchiveState | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [cursorMs, setCursorMs] = useState<number | null>(null);
    const [seek, setSeek] = useState({ ms: 0, token: 0 });
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);

    const [sideOpen, setSideOpen] = useState(true);
    const stage = useRef<HTMLDivElement | null>(null);
    const [fullscreen, setFullscreen] = useState(false);
    const [picking, setPicking] = useState(false);
    const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);

    // Окно выгрузки открывается и из шапки таймлайна, и из карточки диапазона
    const [downloadOpen, setDownloadOpen] = useState(false);

    // Окно встаёт на последнюю запись, а не на сейчас: на изделии с
    // недостоверным временем сегодняшних суток в архиве может не быть вовсе
    const opened = useRef(false);

    const span = ZOOMS[zoom].span;
    const from = center - span / 2;
    const to = center + span / 2;

    const cameraNames = useMemo(() => {
        const names = new Map<string, string>();
        cameras.forEach(camera => names.set(camera.id, camera.display_name || camera.id));
        return names;
    }, [cameras]);

    // Живые камеры сверху, удалённые в конце: порядок меняется от правки
    // конфигурации, а не от того, где сейчас стоит окно таймлайна
    const tracks = useMemo(() => {
        const list = [...(shape?.tracks ?? [])];
        if (!cameraNames.size) return list;

        return list.sort((first, second) => {
            const gone = Number(!cameraNames.has(first.camera_id))
                - Number(!cameraNames.has(second.camera_id));
            return gone || trackKey(first).localeCompare(trackKey(second));
        });
    }, [shape, cameraNames]);

    const selected = tracks.find(track => trackKey(track) === selectedKey) || null;

    // ── данные ──

    const loadState = useCallback(() => {
        fetchState()
            .then(next => {
                setState(next);
                if (!opened.current && next.last_ms) {
                    opened.current = true;
                    setCenter(next.last_ms - ZOOMS[DEFAULT_ZOOM].span / 4);
                }
            })
            .catch(() => setState(null));
    }, []);

    useEffect(loadState, [loadState]);

    // Форма архива тянется целиком и один раз
    const loadShape = useCallback((first: boolean) => {
        fetchShape()
            .then(next => {
                setShape(next);
                setError(null);
                if (first && !opened.current && next.last_ms) {
                    opened.current = true;
                    setCenter(next.last_ms - ZOOMS[DEFAULT_ZOOM].span / 4);
                }
            })
            .catch(e => { if (first) setError(String(e)); })
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        loadShape(true);
        const timer = window.setInterval(() => loadShape(false), REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [loadShape]);

    // Сегменты нужны одному плееру, поэтому грузятся только выбранной дорожке и только вокруг курсора
    useEffect(() => {
        if (!selected || cursorMs === null) return;

        const key = trackKey(selected);
        const span_ = loadedSpan.current;
        const covered = span_ !== null
            && span_.key === key
            && cursorMs > span_.from + SEGMENT_MARGIN_MS
            && cursorMs < span_.to - SEGMENT_MARGIN_MS;
        if (covered) return;

        const wanted = {
            key,
            from: cursorMs - SEGMENT_SPAN_MS / 2,
            to: cursorMs + SEGMENT_SPAN_MS / 2,
        };
        loadedSpan.current = wanted;

        fetchSegments(selected, wanted.from, wanted.to)
            .then(data => {
                if (loadedSpan.current === wanted) setSegments(data.segments);
            })
            .catch(() => {
                if (loadedSpan.current === wanted) loadedSpan.current = null;
            });
    }, [selected, cursorMs]);

    // Дорожка выбирается сама: первая, где в окне что-то записано
    useEffect(() => {
        if (!tracks.length) return;
        if (selectedKey && tracks.some(track => trackKey(track) === selectedKey)) return;

        const withData = tracks.find(track => track.segment_count > 0) || tracks[0];
        setSelectedKey(trackKey(withData));

        if (cursorMs === null) {
            const start = withData.runs[0]?.start_ms;
            if (start) {
                setCursorMs(start);
                setSeek({ ms: start, token: Date.now() });
            }
        }
    }, [tracks, selectedKey, cursorMs]);

    // ── окно ──

    // Приближение с удержанием точки под указателем на месте
    const handleZoom = useCallback((next: number, anchorMs?: number) => {
        if (next < 0 || next >= ZOOMS.length) return;

        const anchor = anchorMs ?? center;
        const ratio = (anchor - (center - span / 2)) / span;
        const nextSpan = ZOOMS[next].span;

        setZoom(next);
        setCenter(anchor - (ratio - 0.5) * nextSpan);
    }, [center, span]);

    const handlePan = useCallback((deltaMs: number) => {
        setCenter(value => value + deltaMs);
    }, []);

    const handleJumpDate = useCallback((key: string) => {
        // Прыжок на дату ставит середину окна в полдень этих суток
        setCenter(dayStartMs(key) + DAY_MS / 2);
    }, []);

    // ── проигрывание ──

    const handleSeek = useCallback((track: Track | null, ms: number) => {
        if (track) setSelectedKey(trackKey(track));
        setCursorMs(ms);
        setSeek({ ms, token: Date.now() });
    }, []);

    const handleSelect = useCallback((track: Track) => {
        if (trackKey(track) === selectedKey) return;
        setSelectedKey(trackKey(track));
        if (cursorMs !== null) setSeek({ ms: cursorMs, token: Date.now() });
    }, [cursorMs, selectedKey]);

    // Удержание шагает по таймеру, поэтому курсор читается из ref, а не из замыкания
    const cursorRef = useRef(cursorMs);
    cursorRef.current = cursorMs;

    const jump = useCallback((deltaSec: number) => {
        const at = cursorRef.current;
        if (at === null) return;
        const ms = at + deltaSec * 1000;
        cursorRef.current = ms;
        setCursorMs(ms);
        setSeek({ ms, token: Date.now() });
    }, []);

    const holdTimer = useRef(0);
    const stopHold = useCallback(() => {
        window.clearTimeout(holdTimer.current);
        window.clearInterval(holdTimer.current);
    }, []);
    useEffect(() => stopHold, [stopHold]);

    // Нажатие — шаг сразу, удержание — повтор, пока кнопку держат и указатель на ней
    const holdProps = (deltaSec: number) => ({
        onPointerDown: (event: React.PointerEvent) => {
            if (event.button !== 0) return;
            stopHold();
            jump(deltaSec);
            holdTimer.current = window.setTimeout(() => {
                holdTimer.current = window.setInterval(() => jump(deltaSec), HOLD_STEP_MS);
            }, HOLD_DELAY_MS);
        },
        onPointerUp: stopHold,
        onPointerLeave: stopHold,
        onPointerCancel: stopHold,
        // Щелчок с клавиатуры — один шаг
        onClick: (event: React.MouseEvent) => {
            if (event.detail === 0) jump(deltaSec);
        },
    });

    // В полном экране ползунок, ушедший за край окна, перелистывает окно за собой
    const lastCursor = useRef(cursorMs);
    useEffect(() => {
        const prev = lastCursor.current;
        lastCursor.current = cursorMs;
        if (!fullscreen || prev === null || cursorMs === null || prev < from || prev >= to) return;
        const windows = Math.floor((cursorMs - from) / span);
        if (windows) setCenter(value => value + windows * span);
    }, [cursorMs, fullscreen, from, to, span]);

    // Полный экран закрывают и мимо кнопки — клавишей Esc
    useEffect(() => {
        const onChange = () => setFullscreen(document.fullscreenElement === stage.current);
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
    }, []);

    const toggleFullscreen = () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else stage.current?.requestFullscreen?.().catch(() => {});
    };

    const atCursor = cursorMs === null ? null : segmentAt(segments, cursorMs);
    // Файл извлечённого диска не скачать
    const currentSegment = atCursor?.available === false ? null : atCursor;

    // Отмена в карточке диапазона: гасим и выделение, и сам режим выбора
    const cancelPicking = useCallback(() => {
        setSelection(null);
        setPicking(false);
    }, []);

    // Вход из карточки диапазона не даёт выбирать диапазон заново
    const [fixedRange, setFixedRange] = useState(false);

    const openDownload = useCallback((fixed: boolean) => {
        setFixedRange(fixed);
        setDownloadOpen(true);
    }, []);

    const preselected = useMemo(() => {
        if (selection) {
            const inside = tracks
                .filter(track => recordedWithin(track, selection.from, selection.to) > 0)
                .map(trackKey);
            if (inside.length) return inside;
        }
        return selected ? [trackKey(selected)] : [];
    }, [selection, tracks, selected]);

    const windowRecorded = tracks.reduce((sum, track) => sum + track.recorded_ms, 0);
    const windowGaps = tracks.reduce((sum, track) => sum + track.gaps.length, 0);
    const windowGone = tracks.reduce((sum, track) => sum + goneWithin(track, from, to), 0);

    // Пулы всех устройств одной полосой
    const disks = (state?.devices ?? []).flatMap(device => (device.disk ? [device.disk] : []));
    const disk = disks.length ? {
        total_bytes: disks.reduce((sum, d) => sum + d.total_bytes, 0),
        used_bytes: disks.reduce((sum, d) => sum + d.used_bytes, 0),
    } : null;
    const diskPercent = disk?.total_bytes ? Math.round(disk.used_bytes / disk.total_bytes * 1000) / 10 : 0;

    // Кнопки кадра одни: внизу кадра в обычном режиме и в карточке в полном экране
    const transport = (
        <>
            <button type="button" className="arch-vbtn" title="Назад 10 секунд" {...holdProps(-10)}>
                <Icon name="prev" />
            </button>
            <button
                type="button"
                className="arch-vbtn is-main"
                onClick={() => setPlaying(value => !value)}
                title={playing ? 'Пауза' : 'Воспроизвести'}
            >
                <Icon name={playing ? 'pause' : 'play'} />
            </button>
            <button type="button" className="arch-vbtn" title="Вперёд 10 секунд" {...holdProps(10)}>
                <Icon name="next" />
            </button>
        </>
    );

    const cursorTime = (
        <span className="arch-vtime">
            {cursorMs === null ? '—' : fmtTime(cursorMs)}
            <small> / {cursorMs === null ? '' : fmtDate(cursorMs)}</small>
        </span>
    );

    const tools = (
        <>
            <button
                type="button"
                className="arch-vspeed"
                onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
            >
                ×{String(speed).replace('.', ',')}
            </button>
            <a
                className={`arch-vbtn${currentSegment ? '' : ' is-off'}`}
                href={currentSegment && selected ? segmentUrl(selected, currentSegment, true) : undefined}
                download
                title="Скачать текущий сегмент"
            >
                <Icon name="save" />
            </a>
            <button
                type="button"
                className="arch-vbtn"
                onClick={toggleFullscreen}
                title={fullscreen ? 'Свернуть' : 'Во весь экран'}
            >
                <Icon name={fullscreen ? 'unfull' : 'full'} />
            </button>
        </>
    );

    return (
        <div className="screen arch">
            {view !== 'full' && (
                <div className="arch-body">
                    <div className="arch-left">
                        <div className="arch-stage" ref={stage}>
                            <ArchivePlayer
                                track={selected}
                                segments={segments}
                                seek={seek}
                                playing={playing}
                                speed={speed}
                                onProgress={setCursorMs}
                                onPlayingChange={setPlaying}
                                onTrackEnd={() => setPlaying(false)}
                                onSeekTo={ms => handleSeek(selected, ms)}
                            />

                            {fullscreen ? (
                                <FullscreenBar
                                    track={selected}
                                    from={from}
                                    to={to}
                                    level={ZOOMS[zoom]}
                                    cursorMs={cursorMs}
                                    playing={playing}
                                    transport={transport}
                                    tools={<>{cursorTime}{tools}</>}
                                    onSeek={ms => handleSeek(selected, ms)}
                                    onPage={windows => setCenter(value => value + windows * span)}
                                />
                            ) : (
                                <div className="arch-ctl">
                                    <div className="arch-ctl-group">{transport}{cursorTime}</div>
                                    <div className="arch-ctl-group">{tools}</div>
                                </div>
                            )}
                        </div>
                    </div>

                    <button
                        type="button"
                        className={`arch-side-grip${sideOpen ? '' : ' is-closed'}`}
                        style={{ right: sideOpen ? 300 : 0 }}
                        onClick={() => setSideOpen(value => !value)}
                        title={sideOpen ? 'Скрыть панель' : 'Показать панель'}
                        aria-label={sideOpen ? 'Скрыть панель' : 'Показать панель'}
                    >
                        <Icon name="chev" size={12} />
                    </button>

                    {sideOpen && (
                    <aside className="arch-side">
                        <div className="sect">
                            <span className="eyebrow">В окне таймлайна</span>
                            <div className="kv"><span className="k">Записано</span><span className="v">{fmtDuration(windowRecorded)}</span></div>
                            {windowGone > 0 && (
                                <div className="kv">
                                    <span className="k">Не подключено</span>
                                    <span className="v is-gone">{fmtDuration(windowGone)}</span>
                                </div>
                            )}
                            <div className="kv"><span className="k">Дорожек</span><span className="v">{tracks.length}</span></div>
                            <div className="kv">
                                <span className="k">Пропусков</span>
                                <span className={`v${windowGaps ? ' is-err' : ''}`}>{windowGaps}</span>
                            </div>
                            {!!shape?.offline_devices?.length && (
                                <div className="kv">
                                    <span className="k">Не отвечает устройств</span>
                                    <span className="v is-warn">{shape.offline_devices.length}</span>
                                </div>
                            )}
                        </div>

                        <div className="sect">
                            <span className="eyebrow">Состояние архива</span>
                            <div className="kv">
                                <span className="k">Глубина</span>
                                <span className="v">
                                    {state?.first_ms && state?.last_ms
                                        ? `${fmtDate(state.first_ms)} — ${fmtDate(state.last_ms)}`
                                        : '—'}
                                </span>
                            </div>
                            <div className="kv"><span className="k">Сегментов</span><span className="v">{state?.segment_count ?? 0}</span></div>
                            <div className="kv"><span className="k">Занято записями</span><span className="v">{fmtBytes(state?.bytes ?? 0)}</span></div>
                            {!!state?.untrusted_sessions && (
                                <div className="kv">
                                    <span className="k">Сессий без времени</span>
                                    <span className="v is-warn">{state.untrusted_sessions}</span>
                                </div>
                            )}

                            {disk && (
                                <div className="arch-meter">
                                    <div className="arch-meter-bar">
                                        <i style={{ width: `${diskPercent}%` }} />
                                    </div>
                                    <div className="arch-meter-cap">
                                        <span>{formatBytes(disk.used_bytes)} из {formatBytes(disk.total_bytes)}</span>
                                        <span>{String(diskPercent).replace('.', ',')} %</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </aside>
                    )}
                </div>
            )}

            <Timeline
                from={from}
                to={to}
                zoom={zoom}
                tracks={tracks}
                cameraNames={cameraNames}
                selectedKey={selectedKey}
                cursorMs={cursorMs}
                todayKey={clock.unixMs === null ? null : dateKey(clock.unixMs)}
                selection={selection}
                picking={picking}
                view={view}
                onZoom={handleZoom}
                onPan={handlePan}
                onJumpDate={handleJumpDate}
                onSelect={handleSelect}
                onSeek={handleSeek}
                onSelectionChange={setSelection}
                onCancelPick={cancelPicking}
                onPicking={() => setPicking(value => !value)}
                onDownload={openDownload}
                onView={setView}
            />

            {downloadOpen && (
                <DownloadModal
                    tracks={tracks}
                    cameraNames={cameraNames}
                    selection={selection}
                    fixedRange={fixedRange}
                    preselected={preselected}
                    todayKey={clock.unixMs === null ? null : dateKey(clock.unixMs)}
                    archiveFrom={shape?.first_ms ?? null}
                    archiveTo={shape?.last_ms ?? null}
                    onClose={() => setDownloadOpen(false)}
                />
            )}

            {(error || (loading && !shape)) && (
                <div className={`arch-toast${error ? ' is-err' : ''}`}>
                    <span>{error ? `Архив не отвечает: ${error}` : 'Читаем архив…'}</span>
                    {error && (
                        <button type="button" onClick={() => setError(null)} aria-label="Закрыть">
                            <Icon name="x" size={12} />
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

export default ArchiveScreen;
