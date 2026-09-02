import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../../app/Icons';
import { useSystem } from '../../app/SystemContext';
import { useDeviceClock } from '../../app/useDeviceClock';
import { ArchivePlayer } from './ArchivePlayer';
import { Timeline } from './Timeline';
import type { TimelineView } from './Timeline';
import type { ArchiveShape, ArchiveState, JobProgress, Segment, Track } from './model';
import {
    DAY_MS, DEFAULT_ZOOM, ZOOMS, dateKey, dayStartMs, fetchSegments,
    fetchShape, fetchState, fmtBytes, fmtDate, fmtDuration, fmtTime, jobCancelUrl,
    jobDownloadUrl, jobProgressUrl, segmentAt, segmentUrl,
    startCut, startZip, trackKey,
} from './model';
import './archive.css';

/*
    Экран архива.

    Дорожки — пишущие потоки всех устройств сразу: оператору важно покрытие
    борта, а не то, какой мини-компьютер чью камеру пишет. Играет выбранная
    дорожка, курсор общий и сквозной — видно, что в этот момент писала одна
    камера, а другая нет.
*/

const REFRESH_MS = 10_000;
const SPEEDS = [0.5, 1, 2, 4];

// Сколько времени сегментов держим у выбранной дорожки и за сколько до края
// подгружаем следующую порцию
const SEGMENT_SPAN_MS = 2 * 60 * 60 * 1000;
const SEGMENT_MARGIN_MS = 20 * 60 * 1000;

/** Задача склейки или выгрузки, идущая на устройстве. */
interface ArchiveJob extends Partial<JobProgress> {
    id: string;
    deviceId: string;
    kind: 'cut' | 'zip';
    title: string;
    status: string;
    progress: number;
    message: string;
}

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
    const [picking, setPicking] = useState(false);
    const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);

    // Склейка и выгрузка идут задачей на устройстве: прогресс приходит по WS
    const [job, setJob] = useState<ArchiveJob | null>(null);

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

    /* Форма архива тянется целиком и один раз: она весит килобайты, а сдвиг и
       зум после этого — чистая арифметика без единого запроса. Обновляем её по
       таймеру только ради хвоста, который пишется прямо сейчас */
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

    /* Сегменты нужны одному плееру, поэтому грузятся только выбранной дорожке и
       только вокруг курсора: их мегабайты на весь архив таймлайну ни к чему */
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

    /** Приближение с удержанием точки под указателем на месте. */
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

    const jump = useCallback((deltaSec: number) => {
        if (cursorMs === null) return;
        const ms = cursorMs + deltaSec * 1000;
        setCursorMs(ms);
        setSeek({ ms, token: Date.now() });
    }, [cursorMs]);

    const currentSegment = cursorMs === null ? null : segmentAt(segments, cursorMs);

    // ── задачи ──

    useEffect(() => {
        if (!job || job.status === 'ready' || job.status === 'failed') return;

        const socket = new WebSocket(jobProgressUrl(job.deviceId, job.id));
        socket.onmessage = event => {
            const data = JSON.parse(event.data) as JobProgress;
            setJob(current => (current && current.id === job.id ? { ...current, ...data } : current));
        };
        socket.onerror = () => setJob(current => (current && current.id === job.id
            ? { ...current, status: 'failed', error: 'связь с устройством потеряна' }
            : current));

        return () => socket.close();
    }, [job?.id, job?.status]);

    const runJob = useCallback(async (
        kind: 'cut' | 'zip',
        rangeFrom: number,
        rangeTo: number,
        title: string,
    ) => {
        if (!selected) return;

        try {
            const start = kind === 'cut' ? startCut : startZip;
            const { job_id } = await start(selected, rangeFrom, rangeTo);
            setJob({
                id: job_id,
                deviceId: selected.device_id,
                kind,
                title,
                status: 'queued',
                progress: 0,
                message: 'Задача поставлена',
            });
        } catch (e) {
            setJob({
                id: '', deviceId: selected.device_id, kind, title,
                status: 'failed', progress: 0, message: '', error: String(e),
            });
        }
    }, [selected]);

    /** Отмена в карточке диапазона: гасим и выделение, и сам режим выбора. */
    const cancelPicking = useCallback(() => {
        setSelection(null);
        setPicking(false);
    }, []);

    const cancelJob = useCallback(() => {
        if (!job?.id) { setJob(null); return; }
        fetch(jobCancelUrl(job.deviceId, job.id), { method: 'DELETE' }).catch(() => undefined);
        setJob(null);
    }, [job]);

    const windowRecorded = tracks.reduce((sum, track) => sum + track.recorded_ms, 0);
    const windowGaps = tracks.reduce((sum, track) => sum + track.gaps.length, 0);
    const disk = state?.devices.find(device => device.disk)?.disk;

    return (
        <div className="screen arch">
            {view !== 'full' && (
                <div className="arch-body">
                    <div className="arch-left">
                        <div className="arch-stage">
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

                            <div className="arch-ctl">
                                <div className="arch-ctl-group">
                                    <button type="button" className="arch-vbtn" onClick={() => jump(-10)} title="Назад 10 секунд">
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
                                    <button type="button" className="arch-vbtn" onClick={() => jump(10)} title="Вперёд 10 секунд">
                                        <Icon name="next" />
                                    </button>
                                    <span className="arch-vtime">
                                        {cursorMs === null ? '—' : fmtTime(cursorMs)}
                                        <small> / {cursorMs === null ? '' : fmtDate(cursorMs)}</small>
                                    </span>
                                </div>

                                <div className="arch-ctl-group">
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
                                        onClick={() => document.querySelector('.arch-stage')?.requestFullscreen?.()}
                                        title="Во весь экран"
                                    >
                                        <Icon name="full" />
                                    </button>
                                </div>
                            </div>
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
                        {job && (
                            <div className="sect">
                                <span className="eyebrow">{job.kind === 'cut' ? 'Склейка' : 'Выгрузка'}</span>
                                <div className="kv">
                                    <span className="k">{job.title}</span>
                                    <span className="v">{Math.round(job.progress * 100)} %</span>
                                </div>

                                <div className="arch-meter">
                                    <div className="arch-meter-bar">
                                        <i style={{ width: `${Math.round(job.progress * 100)}%` }} />
                                    </div>
                                    <div className="arch-meter-cap">
                                        <span>{job.error ? job.error : job.message}</span>
                                    </div>
                                </div>

                                {job.status === 'ready' && (
                                    <a
                                        className="arch-act arch-act--acc arch-act-main"
                                        href={jobDownloadUrl(job.deviceId, job.id)}
                                        download
                                        onClick={() => window.setTimeout(() => setJob(null), 1000)}
                                    >
                                        Скачать
                                        <span className="num">{job.result_filename ?? ''}</span>
                                    </a>
                                )}

                                <button type="button" className="arch-act" onClick={cancelJob}>
                                    {job.status === 'ready' || job.status === 'failed' ? 'Убрать' : 'Отменить'}
                                </button>
                            </div>
                        )}

                        <div className="sect">
                            <span className="eyebrow">В окне таймлайна</span>
                            <div className="kv"><span className="k">Записано</span><span className="v">{fmtDuration(windowRecorded)}</span></div>
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
                                        <i style={{ width: `${disk.used_percent}%` }} />
                                    </div>
                                    <div className="arch-meter-cap">
                                        <span>{fmtBytes(disk.used_bytes)} из {fmtBytes(disk.total_bytes)}</span>
                                        <span>{String(disk.used_percent).replace('.', ',')} %</span>
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
                onCut={() => selection && runJob('cut', selection.from, selection.to,
                    `${fmtTime(selection.from)} — ${fmtTime(selection.to)}`)}
                onView={setView}
            />

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
