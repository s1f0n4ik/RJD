import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../../app/Icons';
import { useSystem } from '../../app/SystemContext';
import { useDeviceClock } from '../../app/useDeviceClock';
import { ArchivePlayer } from './ArchivePlayer';
import { DayPicker } from './DayPicker';
import { Timeline } from './Timeline';
import type { ArchiveState, DayIndex, JobProgress, Track } from './model';
import {
    DAY_MS, dateKey, dayStartMs, estimateBytes, fetchDay, fetchState,
    fmtBytes, fmtDate, fmtDuration, fmtTime, gapsWithin, jobCancelUrl,
    jobDownloadUrl, jobProgressUrl, recordedWithin,
    segmentAt, segmentUrl, startCut, startZip, trackKey,
} from './model';
import './archive.css';

/*
    Экран архива.

    Дорожки — пишущие потоки всех устройств сразу: оператору важно покрытие
    борта, а не то, какой мини-компьютер чью камеру пишет. Играет выбранная
    дорожка, курсор общий — видно, что в этот момент писала одна камера, а
    другая нет.
*/

const REFRESH_MS = 10_000;
const SPEEDS = [0.5, 1, 2, 4];

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

    const [date, setDate] = useState<string>(() => dateKey(Date.now()));
    const [day, setDay] = useState<DayIndex | null>(null);
    const [state, setState] = useState<ArchiveState | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [cursorMs, setCursorMs] = useState<number | null>(null);
    const [seek, setSeek] = useState({ ms: 0, token: 0 });
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);

    const [picking, setPicking] = useState(false);
    const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);

    // Склейка и выгрузка идут задачей на устройстве: прогресс приходит по WS
    const [job, setJob] = useState<ArchiveJob | null>(null);

    // День открывается на последней записи, а не на сегодня: на изделии с
    // недостоверным временем сегодняшних суток в архиве может не быть вовсе
    const openedInitial = useRef(false);

    const cameraNames = useMemo(() => {
        const names = new Map<string, string>();
        cameras.forEach(camera => names.set(camera.id, camera.display_name || camera.id));
        return names;
    }, [cameras]);

    const tracks = day?.tracks ?? [];
    const selected = tracks.find(track => trackKey(track) === selectedKey) || null;

    const loadState = useCallback(() => {
        fetchState()
            .then(next => {
                setState(next);
                if (!openedInitial.current && next.last_ms) {
                    openedInitial.current = true;
                    setDate(dateKey(next.last_ms));
                }
            })
            .catch(() => setState(null));
    }, []);

    useEffect(loadState, [loadState]);

    const loadDay = useCallback((key: string, quiet = false) => {
        if (!quiet) setLoading(true);
        fetchDay(key)
            .then(next => {
                setDay(next);
                setError(null);
            })
            .catch(e => setError(String(e)))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        loadDay(date);
        setSelection(null);
    }, [date, loadDay]);

    // Текущие сутки дописываются прямо сейчас — обновляем их опросом
    useEffect(() => {
        if (clock.unixMs === null || dateKey(clock.unixMs) !== date) return;

        const timer = window.setInterval(() => loadDay(date, true), REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [clock.unixMs, date, loadDay]);

    // Дорожка выбирается сама: первая, где за эти сутки что-то записано
    useEffect(() => {
        if (!tracks.length) {
            setSelectedKey(null);
            return;
        }
        if (selectedKey && tracks.some(track => trackKey(track) === selectedKey)) return;

        const withData = tracks.find(track => track.segment_count > 0) || tracks[0];
        setSelectedKey(trackKey(withData));

        const start = withData.runs[0]?.start_ms;
        if (start) {
            setCursorMs(start);
            setSeek({ ms: start, token: Date.now() });
        }
    }, [tracks, selectedKey]);

    // Прогресс задачи: канал живёт, пока задача не дошла до конца
    useEffect(() => {
        if (!job || job.status === 'ready' || job.status === 'failed') return;

        const socket = new WebSocket(jobProgressUrl(job.deviceId, job.id));
        socket.onmessage = event => {
            const data = JSON.parse(event.data) as JobProgress;
            setJob(current => (current && current.id === job.id
                ? { ...current, ...data }
                : current));
        };
        socket.onerror = () => setJob(current => (current && current.id === job.id
            ? { ...current, status: 'failed', error: 'связь с устройством потеряна' }
            : current));

        return () => socket.close();
    }, [job?.id, job?.status]);

    const runJob = useCallback(async (
        kind: 'cut' | 'zip',
        from: number,
        to: number,
        title: string,
    ) => {
        if (!selected) return;

        try {
            const start = kind === 'cut' ? startCut : startZip;
            const { job_id } = await start(selected, from, to);
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

    const cancelJob = useCallback(() => {
        if (!job?.id) { setJob(null); return; }
        fetch(jobCancelUrl(job.deviceId, job.id), { method: 'DELETE' }).catch(() => undefined);
        setJob(null);
    }, [job]);

    const handleSeek = useCallback((track: Track, ms: number) => {
        setSelectedKey(trackKey(track));
        setCursorMs(ms);
        setSeek({ ms, token: Date.now() });
    }, []);

    const handleSelect = useCallback((track: Track) => {
        if (trackKey(track) === selectedKey) return;
        setSelectedKey(trackKey(track));
        const ms = cursorMs ?? track.runs[0]?.start_ms;
        if (ms) setSeek({ ms, token: Date.now() });
    }, [cursorMs, selectedKey]);

    const jump = useCallback((deltaSec: number) => {
        if (cursorMs === null) return;
        const ms = cursorMs + deltaSec * 1000;
        setCursorMs(ms);
        setSeek({ ms, token: Date.now() });
    }, [cursorMs]);

    const currentSegment = selected && cursorMs !== null ? segmentAt(selected, cursorMs) : null;

    const selectionInfo = useMemo(() => {
        if (!selection || !selected) return null;
        const requested = selection.to - selection.from;
        const recorded = recordedWithin(selected, selection.from, selection.to);
        return {
            requested,
            recorded,
            gaps: gapsWithin(selected, selection.from, selection.to),
            bytes: estimateBytes(selected, recorded),
        };
    }, [selection, selected]);

    const dayRecorded = tracks.reduce((sum, track) => sum + track.recorded_ms, 0);
    const dayGaps = tracks.reduce((sum, track) => sum + track.gaps.length, 0);
    const dayBytes = tracks.reduce((sum, track) => sum + track.bytes, 0);
    const daySegments = tracks.reduce((sum, track) => sum + track.segment_count, 0);
    const disk = state?.devices.find(device => device.disk)?.disk;

    return (
        <div className="screen arch">
            <div className="arch-bar">
                <DayPicker
                    date={date}
                    todayKey={clock.unixMs === null ? null : dateKey(clock.unixMs)}
                    onChange={setDate}
                />

                <div className="seg">
                    <button
                        type="button"
                        className={picking ? '' : 'is-on'}
                        onClick={() => { setPicking(false); setSelection(null); }}
                    >
                        Воспроизведение
                    </button>
                    <button
                        type="button"
                        className={picking ? 'is-on' : ''}
                        onClick={() => setPicking(true)}
                    >
                        Выбор диапазона
                    </button>
                </div>

                {!!tracks.length && (
                    <span className="pill ok">
                        <span className="dot" />
                        записано {fmtDuration(dayRecorded)}
                    </span>
                )}
                {dayGaps > 0 && (
                    <span className="pill err">
                        <span className="dot" />
                        {dayGaps} {dayGaps === 1 ? 'пропуск' : 'пропусков'}
                    </span>
                )}
                {!!day?.offline_devices.length && (
                    <span className="pill warn">
                        <span className="dot" />
                        не отвечает устройств: {day.offline_devices.length}
                    </span>
                )}
            </div>

            <div className="arch-body">
                <div className="arch-left">
                    <div className="arch-stage">
                    <ArchivePlayer
                        track={selected}
                        seek={seek}
                        playing={playing}
                        speed={speed}
                        onProgress={setCursorMs}
                        onPlayingChange={setPlaying}
                        onTrackEnd={() => setPlaying(false)}
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
                                <small> / {fmtDuration(selected?.recorded_ms ?? 0)}</small>
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
                    <Timeline
                        date={date}
                        tracks={tracks}
                        cameraNames={cameraNames}
                        selectedKey={selectedKey}
                        cursorMs={cursorMs}
                        selection={selection}
                        selectionInfo={selectionInfo}
                        picking={picking}
                        onSelect={handleSelect}
                        onSeek={handleSeek}
                        onSelectionChange={setSelection}
                        onCut={() => selection && runJob('cut', selection.from, selection.to,
                            `${fmtTime(selection.from)} — ${fmtTime(selection.to)}`)}
                    />
                </div>

                <aside className="arch-side">
                    <div className="sect">
                        <span className="eyebrow">Скачать</span>
                        <button
                            type="button"
                            className="arch-act arch-act--acc"
                            onClick={() => setPicking(true)}
                        >
                            Склеить фрагмент
                            <span className="num">выбор диапазона</span>
                        </button>
                        <button
                            type="button"
                            className="arch-act"
                            disabled={!selected}
                            onClick={() => runJob('zip', dayStartMs(date), dayStartMs(date) + DAY_MS,
                                `День ${date}`)}
                        >
                            Скачать день архивом
                            <span className="num">{fmtBytes(selected?.bytes ?? 0)}</span>
                        </button>
                        <button
                            type="button"
                            className="arch-act"
                            disabled={!selected || !state?.first_ms || !state?.last_ms}
                            onClick={() => state?.first_ms && state?.last_ms && runJob(
                                'zip', state.first_ms, state.last_ms + 1, 'Все записи камеры')}
                        >
                            Скачать все записи камеры
                            <span className="num">{fmtBytes(state?.bytes ?? 0)}</span>
                        </button>
                    </div>

                    {job && (
                        <div className="sect">
                            <span className="eyebrow">{job.kind === 'cut' ? 'Склейка' : 'Выгрузка'}</span>
                            <div className="kv"><span className="k">{job.title}</span><span className="v">{Math.round(job.progress * 100)} %</span></div>

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
                                    Скачать {job.result_filename ? '' : 'результат'}
                                    <span className="num">{job.result_filename ?? ''}</span>
                                </a>
                            )}

                            <button type="button" className="arch-act" onClick={cancelJob}>
                                {job.status === 'ready' || job.status === 'failed' ? 'Убрать' : 'Отменить'}
                            </button>
                        </div>
                    )}

                    <div className="sect">
                        <span className="eyebrow">Этот день</span>
                        <div className="kv"><span className="k">Записано</span><span className="v">{fmtDuration(dayRecorded)}</span></div>
                        <div className="kv"><span className="k">Дорожек</span><span className="v">{tracks.length}</span></div>
                        <div className="kv">
                            <span className="k">Пропусков</span>
                            <span className={`v${dayGaps ? ' is-err' : ''}`}>{dayGaps}</span>
                        </div>
                        <div className="kv"><span className="k">Сегментов</span><span className="v">{daySegments}</span></div>
                        <div className="kv"><span className="k">Объём</span><span className="v">{fmtBytes(dayBytes)}</span></div>
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
            </div>

            {(error || (loading && !day)) && (
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
