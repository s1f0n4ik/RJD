import { useCallback, useEffect, useRef, useState } from 'react';
import WebRTCPlayer from '../../../../components/WebRTCPlayer';
import type { PlayerStatusInfo } from '../../../../components/WebRTCPlayer';
import { Icon } from '../../../../app/Icons';
import type { BirdviewWs } from '../../hooks/useBirdviewWs';
import type { EventLog } from '../../hooks/useEventLog';
import type { CalibrationCamera, WsMessage } from '../../api/ws-types';
import { wsUrl } from '../../constants';
import { linkerApi } from '../../api/linker';
import { fetchCalibrationCameras } from '../../api/cameras';
import { useToast } from '../common/Toast';
import { PROJ_METHOD, PROJ_TYPE, toWarpPoints } from '../../api/projection';
import {
    allCamerasDone,
    camerasWithSavedPoints,
    currentMaxPoints,
    DRAG_THRESHOLD,
    emitProjChange,
    hasAnyPoints,
    MAX_SCALE,
    MIN_SCALE,
    projState,
    resetPreset,
    restoreSavedPoints,
    useProjStore,
} from '../../state/proj-store';
import type { Correction } from '../../hooks/useCorrection';
import type { StreamControl } from '../../hooks/useStreamControl';
import { ConfirmModal } from '../common/ConfirmModal';
import {
    attachProjCanvas,
    clampPan,
    eventToNorm,
    hitPoint,
    mediaTransform,
    projDraw,
    projHasFrame,
    projSyncZoom,
    setProjHasFrame,
    setProjVideoSize,
} from './proj-canvas';
import { ProjSettings } from './ProjSettings';
import { ProjResult } from './ProjResult';
import { LutModal } from './LutModal';
import '../../../../screens/surround/projection.css';

// Экран «Сборка»: живой кадр вторым экземпляром WebRTCPlayer с тем же streamId,
// слой точек внутри трансформируемого слоя видео

interface ProjectionScreenProps {
    active: boolean;
    ws: BirdviewWs;
    log: EventLog;
    camera: CalibrationCamera | null;
    onSelectCamera: (cam: CalibrationCamera) => void;
    correction: Correction;
    stream: StreamControl;
    wsReady: boolean;
}

export function ProjectionScreen({
    active,
    ws,
    log,
    camera,
    onSelectCamera,
    correction,
    stream,
    wsReady,
}: ProjectionScreenProps) {
    const streamId = stream.streamId;
    const showToast = useToast();
    useProjStore();

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const mediaRef = useRef<HTMLDivElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const splitRef = useRef<HTMLDivElement>(null);

    const [resultUrl, setResultUrl] = useState<string | null>(null);
    // Место, чей результат показан
    const [resultKey, setResultKey] = useState<string | null>(null);
    const [lutOpen, setLutOpen] = useState(false);
    const [lutSaving, setLutSaving] = useState(false);

    // Состояние плеера этого экрана — для пилюли «Поток»
    const [playerStatus, setPlayerStatus] = useState<PlayerStatusInfo['status']>('connecting');
    // Масштаб слоя в процентах — для числа в полосе
    const [scalePct, setScalePct] = useState(100);

    // Реальное разрешение кадра из метаданных потока: конфиг камеры может врать
    const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);

    // Пресет, на который оператор хочет перейти, пока не подтвердил потерю точек
    const [pendingPreset, setPendingPreset] = useState<string | null>(null);
    // Камеры, для которых в пришедшем пресете нашлась сохранённая разметка
    const [restorable, setRestorable] = useState<string[]>([]);

    // Список камер: селект панели, клик по месту и проход «Применить все»
    const [sourceCams, setSourceCams] = useState<CalibrationCamera[]>([]);
    const [sourceCamsError, setSourceCamsError] = useState(false);

    useEffect(() => {
        let alive = true;
        fetchCalibrationCameras()
            .then(list => {
                if (alive) setSourceCams(list);
            })
            .catch(() => {
                if (alive) setSourceCamsError(true);
            });
        return () => {
            alive = false;
        };
    }, []);

    // Прогресс прохода по всем камерам; null - проход не идёт
    const [applyAllBusy, setApplyAllBusy] = useState<string | null>(null);
    // Свежие пропсы для асинхронного прохода: замыкание их не видит
    const cameraRef = useRef(camera);
    cameraRef.current = camera;
    const streamRef = useRef(stream);
    streamRef.current = stream;
    // Ошибка apply_warp во время прохода; null - ответа ещё нет
    const warpFailRef = useRef<string | null>(null);

    const resultUrlRef = useRef<string | null>(null);

    // Смена пресета обнуляет карты на сервере — старый результат не показываем
    const clearResult = useCallback(() => {
        if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
        resultUrlRef.current = null;
        setResultUrl(null);
        setResultKey(null);
    }, []);

    const toast = useCallback(
        (title: string, desc: string, type: 'ok' | 'err' | 'info') => showToast(title, desc, type),
        [showToast],
    );

    // Смена потока — старое разрешение и статус плеера больше не факт
    useEffect(() => {
        setVideoSize(null);
        setProjVideoSize(0, 0);
        setPlayerStatus('connecting');
    }, [streamId, stream.generation]);

    // Применяет текущий зум к слою видео; канвас внутри слоя, ему нужен только bitmap
    const syncTransform = useCallback(() => {
        if (mediaRef.current) mediaRef.current.style.transform = mediaTransform();
        projSyncZoom();
        setScalePct(Math.round(projState.view.scale * 100));
    }, []);

    // Канвас точек и указатель
    useEffect(() => {
        const canvas = canvasRef.current;
        const media = mediaRef.current;
        if (!canvas || !media) return;

        const detach = attachProjCanvas(canvas, media);

        let draggingPoint = -1;
        let dragMoved = false;
        let dragStart = { x: 0, y: 0 };

        const onDown = (e: PointerEvent) => {
            if (projState.applied || !projHasFrame()) return;
            if (e.ctrlKey || e.shiftKey || e.button !== 0) return;

            if (!projState.activeCam) {
                toast('Камера не выбрана', 'Выберите камеру в списке пресета', 'err');
                return;
            }

            const n = eventToNorm(e);
            if (!n) return;

            dragStart = n;
            dragMoved = false;
            draggingPoint = hitPoint(e);

            if (draggingPoint !== -1) canvas.setPointerCapture(e.pointerId);
        };

        const onMove = (e: PointerEvent) => {
            if (projState.applied || !projState.activeCam || !projHasFrame()) return;
            if (draggingPoint === -1) return;

            const n = eventToNorm(e);
            if (!n) return;

            if (!dragMoved) {
                if (Math.hypot(n.x - dragStart.x, n.y - dragStart.y) < DRAG_THRESHOLD) return;
                dragMoved = true;
            }

            // Перетаскивание не трогает React: перерисовывается только холст
            projState.points[draggingPoint].x = n.x;
            projState.points[draggingPoint].y = n.y;
            projDraw();
        };

        const onUp = (e: PointerEvent) => {
            if (projState.applied || !projState.activeCam || !projHasFrame()) return;
            if (e.ctrlKey || e.shiftKey) return;

            const hitExisting = draggingPoint !== -1;
            const wasDrag = dragMoved;

            if (hitExisting) canvas.releasePointerCapture(e.pointerId);
            draggingPoint = -1;
            dragMoved = false;

            if (!hitExisting && !wasDrag) {
                const maxPts = currentMaxPoints();
                if (maxPts <= 0) {
                    toast('Лимит не получен', 'Камера не содержит max_points', 'err');
                    return;
                }
                if (projState.points.length >= maxPts) {
                    toast('Лимит точек', `Максимум ${maxPts}`, 'err');
                    return;
                }
                const n = eventToNorm(e);
                if (!n) return;
                projState.points.push({ x: n.x, y: n.y, id: Date.now() });
                emitProjChange();
            }

            projDraw();
        };

        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);

        return () => {
            canvas.removeEventListener('pointerdown', onDown);
            canvas.removeEventListener('pointermove', onMove);
            canvas.removeEventListener('pointerup', onUp);
            detach();
        };
    }, [toast]);

    // Зум и панорамирование области warp
    useEffect(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return;

        let panning = false;
        let panStart = { x: 0, y: 0 };

        const onWheel = (e: WheelEvent) => {
            if (!e.shiftKey) return;
            e.preventDefault();

            const rect = wrapper.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;

            // При зажатом shift браузер переносит прокрутку в горизонтальную ось, и deltaY приходит нулевым
            const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
            if (delta === 0) return;

            const v = projState.view;
            const prev = v.scale;
            const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev * (delta < 0 ? 1.15 : 1 / 1.15)));
            if (next === prev) return;

            const ratio = next / prev;
            v.ox = mx - (mx - v.ox) * ratio;
            v.oy = my - (my - v.oy) * ratio;
            v.scale = next;

            clampPan();
            syncTransform();
        };

        const onPanDown = (e: PointerEvent) => {
            if (!(e.button === 1 || (e.button === 0 && e.shiftKey))) return;
            e.preventDefault();
            panning = true;
            panStart = { x: e.clientX - projState.view.ox, y: e.clientY - projState.view.oy };
            wrapper.classList.add('panning');
        };

        const onPanMove = (e: PointerEvent) => {
            if (!panning) return;
            projState.view.ox = e.clientX - panStart.x;
            projState.view.oy = e.clientY - panStart.y;
            clampPan();
            syncTransform();
        };

        const onPanUp = () => {
            if (!panning) return;
            panning = false;
            wrapper.classList.remove('panning');
        };

        wrapper.addEventListener('wheel', onWheel, { passive: false });
        wrapper.addEventListener('pointerdown', onPanDown);
        window.addEventListener('pointermove', onPanMove);
        window.addEventListener('pointerup', onPanUp);

        const observer = new ResizeObserver(() => {
            clampPan();
            syncTransform();
        });
        observer.observe(wrapper);

        clampPan();
        syncTransform();

        return () => {
            wrapper.removeEventListener('wheel', onWheel);
            wrapper.removeEventListener('pointerdown', onPanDown);
            window.removeEventListener('pointermove', onPanMove);
            window.removeEventListener('pointerup', onPanUp);
            observer.disconnect();
        };
    }, [syncTransform]);

    // Экран мог быть смонтирован скрытым — при показе холст надо перерисовать
    useEffect(() => {
        if (active) {
            clampPan();
            syncTransform();
        }
    }, [active, syncTransform]);

    // Без кадра слой точек пуст
    useEffect(() => {
        setProjHasFrame(Boolean(streamId));
    }, [streamId]);

    useEffect(() => {
        return () => {
            if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
        };
    }, []);

    const handleMessage = useCallback(
        (msg: WsMessage) => {
            const meta = msg.meta ?? {};

            switch (meta.method) {
                case PROJ_METHOD.GET_LIST: {
                    projState.presets = meta.presets ?? [];
                    log.log(`Получено ${projState.presets.length} пресетов`, 'ok');
                    emitProjChange();
                    return;
                }

                case PROJ_METHOD.SET_PRESET: {
                    resetPreset({
                        config_key: meta.config_key,
                        name: meta.name,
                        cameras: meta.cameras ?? [],
                    });
                    clearResult();
                    emitProjChange();
                    projDraw();

                    const saved = camerasWithSavedPoints();
                    if (saved.length > 0) setRestorable(saved);
                    return;
                }

                case PROJ_METHOD.APPLY_WARP: {
                    if (msg.ret !== true) {
                        // Проход «Применить все» останавливается на первой ошибке
                        warpFailRef.current = meta.error ?? meta.description ?? 'Сервер вернул ошибку';
                        toast('Warp не применён', meta.error ?? 'Сервер вернул ошибку', 'err');
                        return;
                    }

                    if (msg.imageBytes?.byteLength) {
                        if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
                        const url = URL.createObjectURL(
                            new Blob([msg.imageBytes.slice()], { type: 'image/jpeg' }),
                        );
                        resultUrlRef.current = url;
                        setResultUrl(url);
                        setResultKey(meta.key ?? null);
                    }

                    const key = meta.key;
                    projState.pointsByCam[key] =
                        key === projState.activeCam
                            ? projState.points.slice()
                            : (projState.pointsByCam[key] ?? []).slice();

                    projState.doneSet.add(key);

                    if (meta.camera_id != null) {
                        projState.camId[key] = String(meta.camera_id);
                    } else {
                        log.log(`apply_warp: нет camera_id для <${key}>`, 'warn');
                    }

                    // Ключ коррекции зеркалит запись в пресет: warp без конфигурации стирает метку у места
                    if (typeof meta.calibration === 'string' && meta.calibration) {
                        projState.calibKey[key] = meta.calibration;
                    } else {
                        delete projState.calibKey[key];
                    }

                    emitProjChange();
                    return;
                }

                case PROJ_METHOD.RESET_WARP: {
                    if (msg.ret !== true) {
                        toast('Сброс не выполнен', meta.description ?? 'Сервер вернул ошибку', 'err');
                        return;
                    }
                    // Точки и привязки остаются; гаснут галочки и результат
                    projState.doneSet = new Set();
                    projState.applied = false;
                    clearResult();
                    emitProjChange();
                    projDraw();
                    log.log('Печка warp сброшена', 'ok');
                    return;
                }

                case PROJ_METHOD.SAVE_LUT: {
                    setLutSaving(false);
                    if (msg.ret !== true) {
                        const err = meta.description ?? 'Сервер вернул ошибку';
                        log.log(`save_lut failed: ${err}`, 'err');
                        toast('Не сохранено', err, 'err');
                        return;
                    }
                    log.log(`save_lut ok: id=${meta.id ?? '?'}`, 'ok');
                    toast('Сохранено', `Конфигурация <${meta.id ?? ''}>`, 'ok');
                    setLutOpen(false);

                    // Перезапись живой конфигурации: рестарт вывода за оператором
                    const savedId = String(meta.id ?? '');
                    if (savedId) {
                        void linkerApi.getStatus()
                            .then(st => {
                                if (st.running && st.exportId === savedId) {
                                    toast(
                                        'Конфигурация в эфире',
                                        'Перезапустите вывод в линкере, чтобы применить новые карты',
                                        'info',
                                    );
                                }
                            })
                            .catch(() => {});
                    }
                    return;
                }

                default:
                    log.log(`projection: неизвестный метод ${meta.method}`, 'warn');
            }
        },
        [log, toast, clearResult],
    );

    useEffect(() => ws.subscribe(PROJ_TYPE, handleMessage), [ws, handleMessage]);

    const sendSetPreset = useCallback(
        (key: string) => {
            ws.sendMessage(PROJ_TYPE, { method: PROJ_METHOD.SET_PRESET, config_key: key });
        },
        [ws],
    );

    // Смена пресета сбрасывает всю разметку — спрашиваем, если есть что терять
    const requestPreset = (key: string) => {
        if (key === projState.activePreset?.config_key) return;
        if (hasAnyPoints()) {
            setPendingPreset(key);
            return;
        }
        sendSetPreset(key);
    };

    const selectCamera = (key: string) => {
        projState.activeCam = key;
        projState.applied = false;
        projState.points = (projState.pointsByCam[key] ?? []).slice();
        emitProjChange();
        projDraw();
    };

    const removeLastPoint = () => {
        projState.points.pop();
        emitProjChange();
        projDraw();
    };

    const clearPoints = () => {
        projState.points = [];
        projState.applied = false;
        emitProjChange();
        projDraw();
    };

    const toggleApply = () => {
        if (projState.applied) {
            projState.applied = false;
            emitProjChange();
            projDraw();
            return;
        }

        if (!projState.activeCam) {
            toast('Камера не выбрана', 'Выберите камеру в списке пресета', 'err');
            return;
        }

        const maxPts = currentMaxPoints();
        if (projState.points.length < maxPts) {
            toast('Недостаточно точек', `Необходимо ${maxPts} точки`, 'err');
            return;
        }

        ws.sendMessage(PROJ_TYPE, {
            method: PROJ_METHOD.APPLY_WARP,
            key: projState.activeCam,
            src_points: toWarpPoints(projState.points),
        });
    };

    // Очередь прохода: места с полной разметкой и доступной привязанной камерой
    const applyAllQueue = () => {
        const preset = projState.activePreset;
        if (!preset) return [];
        return preset.cameras
            .map(c => {
                const pts = (projState.pointsByCam[c.key]?.length
                    ? projState.pointsByCam[c.key]
                    : projState.savedPointsByCam[c.key]) ?? [];
                const maxPts = projState.maxPointsByCam[c.key] ?? 0;
                const cam = sourceCams.find(sc => sc.id === projState.camId[c.key]) ?? null;
                return { key: c.key, pts, maxPts, cam };
            })
            .filter(q => q.cam && q.maxPts > 0 && q.pts.length >= q.maxPts);
    };

    // Ожидание условия опросом: пропсы в асинхронном цикле видны через refs
    const waitFor = (cond: () => boolean, timeoutMs: number) =>
        new Promise<boolean>(resolve => {
            const start = Date.now();
            const tick = () => {
                if (cond()) return resolve(true);
                if (Date.now() - start > timeoutMs) return resolve(false);
                window.setTimeout(tick, 200);
            };
            tick();
        });

    // Проход по всем местам с точками и привязками: честное переключение камеры, затем apply_warp;
    // первая ошибка останавливает проход, успевшее примениться остаётся
    const applyAll = async () => {
        const queue = applyAllQueue();
        if (queue.length === 0) return;

        setApplyAllBusy(`0/${queue.length}`);
        try {
            for (let i = 0; i < queue.length; i++) {
                const q = queue[i];
                setApplyAllBusy(`${i + 1}/${queue.length}`);

                if (cameraRef.current?.id !== q.cam!.id) {
                    onSelectCamera(q.cam!);
                    const up = await waitFor(
                        () => cameraRef.current?.id === q.cam!.id
                            && Boolean(streamRef.current.streamId)
                            && !streamRef.current.pending,
                        20_000,
                    );
                    if (!up) throw new Error(`Камера ${q.cam!.displayName} не поднялась`);
                }

                // Место и его точки в рабочий набор, как при клике по списку
                projState.activeCam = q.key;
                projState.applied = false;
                projState.points = q.pts.map(p => ({ ...p }));
                projState.pointsByCam[q.key] = q.pts.map(p => ({ ...p }));
                projState.doneSet.delete(q.key);
                emitProjChange();
                projDraw();

                warpFailRef.current = null;
                ws.sendMessage(PROJ_TYPE, {
                    method: PROJ_METHOD.APPLY_WARP,
                    key: q.key,
                    src_points: toWarpPoints(projState.points),
                });
                const done = await waitFor(
                    () => projState.doneSet.has(q.key) || warpFailRef.current !== null,
                    15_000,
                );
                if (!done) throw new Error(`Ответ по <${q.key}> не пришёл`);
                if (warpFailRef.current) throw new Error(warpFailRef.current);
            }
            toast('Готово', 'Warp применён для всех камер', 'ok');
        } catch (e) {
            toast('Проход остановлен', e instanceof Error ? e.message : String(e), 'err');
        } finally {
            setApplyAllBusy(null);
        }
    };

    const resetWarp = () => {
        ws.sendMessage(PROJ_TYPE, { method: PROJ_METHOD.RESET_WARP });
    };

    // Разделитель результата и кадра: --res на .sv-split в пределах 20–80 %
    const onGutterDown = (e: React.PointerEvent) => {
        e.preventDefault();
        const box = splitRef.current;
        if (!box) return;
        const r = box.getBoundingClientRect();
        const move = (ev: PointerEvent) => {
            const f = Math.max(0.2, Math.min(0.8, (ev.clientX - r.left - 16) / (r.width - 32)));
            box.style.setProperty('--res', `${(f * 100).toFixed(1)}%`);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    const resetGutter = () => splitRef.current?.style.removeProperty('--res');

    // До прихода метаданных живём на конфиге камеры
    const aspect = videoSize
        ? `${videoSize.w} / ${videoSize.h}`
        : camera
            ? `${camera.width} / ${camera.height}`
            : '16 / 9';
    const maxPts = currentMaxPoints();
    const pointsFull = maxPts > 0 && projState.points.length >= maxPts;
    const warpDone = Boolean(projState.activeCam && projState.doneSet.has(projState.activeCam));

    const streamCls = !streamId
        ? stream.pending ? ' warn' : ''
        : playerStatus === 'connected'
            ? ' ok'
            : playerStatus === 'error'
                ? ' err'
                : ' warn';

    const placeName = (key: string | null) =>
        key ? projState.activePreset?.cameras.find(c => c.key === key)?.name || key : null;

    return (
        <div className={`sv sv-proj${active ? '' : ' is-hidden'}`}>
            <div className="sv-main">
                <div className="toolbar">
                    <button
                        className="btn btn--sm"
                        disabled={projState.points.length === 0}
                        onClick={removeLastPoint}
                    >
                        Удалить последнюю
                    </button>
                    <button className="btn btn--sm btn--ghost" onClick={clearPoints}>Очистить</button>
                    {/* Сбрасывает печку и превью, точки и привязки остаются */}
                    {projState.doneSet.size > 0 && (
                        <button
                            className="btn btn--sm btn--ghost"
                            disabled={applyAllBusy !== null}
                            onClick={resetWarp}
                        >
                            Сбросить warp
                        </button>
                    )}
                    <div className="pills">
                        <span className={`pill${pointsFull ? ' ok' : ''}`}>
                            <span className={`dot${pointsFull ? '' : ' acc'}`} />
                            точек {projState.points.length} из {maxPts}
                        </span>
                        <span className={`pill${warpDone ? ' ok' : ''}`}>
                            <span className="dot" />
                            {warpDone ? 'warp применён' : 'warp не применён'}
                        </span>
                        <span className={`pill${streamCls}`}><span className="dot" />Поток</span>
                        <span className="tbar-sep" />
                        <span className="num">{scalePct} %</span>
                    </div>
                </div>

                <div ref={splitRef} className="sv-split">
                    <div className="stream res">
                        <ProjResult url={resultUrl} />
                        <div className="stream-tag">
                            <span className={`pill${resultUrl ? ' ok' : ''}`}>
                                <span className="dot" />
                                Результат{resultKey ? ` · ${placeName(resultKey)}` : ''}
                            </span>
                        </div>
                    </div>

                    <div className="sv-gutter" data-gutter onPointerDown={onGutterDown} onDoubleClick={resetGutter}>
                        <i />
                    </div>

                    <div ref={wrapperRef} className={`stream${projState.applied ? ' is-applied' : ''}`}>
                        <div ref={mediaRef} className="pj-media" style={{ aspectRatio: aspect }}>
                            {streamId ? (
                                <WebRTCPlayer
                                    key={`proj-${streamId}-${stream.generation}`}
                                    cameraId={streamId}
                                    signalingUrl={wsUrl(`/signaling/client/${streamId}`)}
                                    onStatusChange={info => setPlayerStatus(info.status)}
                                    onVideoResolution={(w, h) => {
                                        setVideoSize(prev =>
                                            prev && prev.w === w && prev.h === h ? prev : { w, h },
                                        );
                                        // Letterbox канваса пересчитывается от реального кадра
                                        setProjVideoSize(w, h);
                                        if (camera && Math.abs(w / h - camera.width / camera.height) > 0.001) {
                                            console.warn(
                                                `Проекция: поток ${w}×${h} расходится по аспекту с конфигом камеры ${camera.width}×${camera.height}`,
                                            );
                                        }
                                    }}
                                />
                            ) : (
                                <div className="empty">
                                    {stream.pending ? (
                                        <>
                                            <span className="spin" />
                                            <b>Подключение</b>
                                        </>
                                    ) : (
                                        <>
                                            <Icon name="cam" className="ico" />
                                            <b>Нет сигнала</b>
                                        </>
                                    )}
                                </div>
                            )}

                            {/* Канвас внутри слоя: наследует его transform */}
                            <canvas ref={canvasRef} className="pj-canvas" />
                        </div>

                        <div className="stream-tag">
                            <span className={`pill${streamId && playerStatus === 'connected' ? ' ok' : ''}`}>
                                <span className="dot" />
                                {camera ? `${camera.displayName} · ${camera.id}` : 'Камера не выбрана'}
                            </span>
                            {projState.activeCam && (
                                <span className="pill">камера пресета {projState.activeCam}</span>
                            )}
                        </div>
                        <span className="scene-hint">shift+колесо · масштаб &nbsp; shift+drag · сдвиг</span>
                    </div>
                </div>
            </div>

            <ProjSettings
                onOpenList={() => ws.sendMessage(PROJ_TYPE, { method: PROJ_METHOD.GET_LIST })}
                onSelectPreset={requestPreset}
                onSelectCamera={selectCamera}
                camera={camera}
                onSelectSourceCamera={onSelectCamera}
                correction={correction}
                stream={stream}
                wsReady={wsReady}
                sourceCams={sourceCams}
                sourceCamsError={sourceCamsError}
                busy={applyAllBusy}
                applyAllCount={applyAllQueue().length}
                lutReady={allCamerasDone()}
                onToggleApply={toggleApply}
                onApplyAll={() => void applyAll()}
                onOpenLut={() => setLutOpen(true)}
            />

            {pendingPreset && (
                <ConfirmModal
                    title="Смена пресета"
                    message="Разметка точек будет потеряна, результат сборки сброшен."
                    confirmText="Сменить"
                    onCancel={() => setPendingPreset(null)}
                    onConfirm={() => {
                        sendSetPreset(pendingPreset);
                        setPendingPreset(null);
                    }}
                />
            )}

            {restorable.length > 0 && (
                <ConfirmModal
                    title="Сохранённая разметка"
                    message={
                        'В пресете сохранены точки для камер: ' +
                        restorable.map(key => placeName(key)).join(', ') +
                        '.'
                    }
                    confirmText="Загрузить"
                    cancelText="Начать заново"
                    onCancel={() => setRestorable([])}
                    onConfirm={() => {
                        restoreSavedPoints();
                        setRestorable([]);
                        emitProjChange();
                        projDraw();
                        log.log('Сохранённая разметка восстановлена', 'ok');
                    }}
                />
            )}

            {lutOpen && (
                <LutModal
                    saving={lutSaving}
                    onClose={() => setLutOpen(false)}
                    onSubmit={(id, name) => {
                        setLutSaving(true);
                        log.log(`save_lut sent: id=${id} name="${name}"`, 'info');
                        ws.sendMessage(PROJ_TYPE, { method: PROJ_METHOD.SAVE_LUT, id, name });
                    }}
                />
            )}
        </div>
    );
}
