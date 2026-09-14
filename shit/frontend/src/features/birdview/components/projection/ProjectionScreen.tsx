import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { Switch } from '../../../../app/Modal';
import type { BirdviewWs } from '../../hooks/useBirdviewWs';
import type { EventLog } from '../../hooks/useEventLog';
import type { CalibrationCamera, WsMessage } from '../../api/ws-types';
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
    restorePlacePoints,
    restoreSavedPoints,
    syncActivePoints,
    useProjStore,
} from '../../state/proj-store';
import type { ProjPoint } from '../../state/proj-store';
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

import type { StreamPlayerState } from '../shared/StreamPlayer';

interface ProjectionScreenProps {
    playerState: StreamPlayerState | null;
    // Узел, в который раздел переносит общий плеер
    onPlayerHost: (node: HTMLElement | null) => void;
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
    playerState,
    onPlayerHost,
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
    // Масштаб слоя в процентах — для числа в полосе
    const [scalePct, setScalePct] = useState(100);

    // Реальное разрешение кадра из метаданных потока: конфиг камеры может врать

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
    // Ход прохода: место в работе, счётчик и флаг остановки
    const [applyKey, setApplyKey] = useState<string | null>(null);
    const [applyStep, setApplyStep] = useState<{ done: number; total: number } | null>(null);
    const abortRef = useRef(false);
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

    // Смена потока — старое разрешение больше не факт
    useEffect(() => {
        setProjVideoSize(0, 0);
    }, [streamId, stream.generation]);

    const videoSize =
        playerState?.width && playerState?.height ? { w: playerState.width, h: playerState.height } : null;

    // Letterbox канваса пересчитывается от реального кадра
    useEffect(() => {
        if (!videoSize) return;
        setProjVideoSize(videoSize.w, videoSize.h);
        if (camera && Math.abs(videoSize.w / videoSize.h - camera.width / camera.height) > 0.001) {
            console.warn(
                `Проекция: поток ${videoSize.w}×${videoSize.h} расходится по аспекту с конфигом камеры ${camera.width}×${camera.height}`,
            );
        }
    }, [videoSize?.w, videoSize?.h, camera]);

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
                syncActivePoints();
                emitProjChange();
            } else if (wasDrag) {
                // Точку сдвинули: набор изменился, прежний warp места больше не годится
                syncActivePoints();
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

    // Выбор камеры в панели — это назначение её активному месту пресета
    const assignCamera = (cam: CalibrationCamera) => {
        if (projState.activeCam) projState.camId[projState.activeCam] = cam.id;
        onSelectCamera(cam);
    };

    // Возврат к разметке, пришедшей с конфигурацией: сервер для этого не нужен
    const restorePlace = (key: string) => {
        restorePlacePoints(key);
        emitProjChange();
        projDraw();
        log.log(`Разметка места <${key}> восстановлена из конфигурации`, 'ok');
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
        syncActivePoints();
        emitProjChange();
        projDraw();
    };

    const clearPoints = () => {
        projState.points = [];
        syncActivePoints();
        emitProjChange();
        projDraw();
    };

    // План прохода: что применяем и что пропускаем, с причиной пропуска.
    // Места с готовым warp не трогаем — правка точек снимает готовность сама
    const applyPlan = () => {
        const preset = projState.activePreset;
        const queue: { key: string; pts: ProjPoint[]; cam: CalibrationCamera }[] = [];
        const skipped: { key: string; why: string }[] = [];
        if (!preset) return { queue, skipped };

        for (const c of preset.cameras) {
            if (projState.doneSet.has(c.key)) continue;

            // Только рабочий набор: сохранённая разметка попадает в него
            // через «Загрузить», и пустой набор значит «оператор стёр точки»
            const pts = projState.pointsByCam[c.key] ?? [];
            const maxPts = projState.maxPointsByCam[c.key] ?? 0;
            const cam = sourceCams.find(sc => sc.id === projState.camId[c.key]) ?? null;

            if (!cam) {
                skipped.push({ key: c.key, why: projState.camId[c.key] ? 'камера не отвечает' : 'нет камеры' });
                continue;
            }
            if (maxPts <= 0 || pts.length < maxPts) {
                skipped.push({ key: c.key, why: `точек ${pts.length} из ${maxPts || '?'}` });
                continue;
            }
            queue.push({ key: c.key, pts, cam });
        }
        return { queue, skipped };
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

    const stopApply = () => {
        abortRef.current = true;
    };

    // Проход по местам плана: честное переключение камеры, затем apply_warp;
    // первая ошибка останавливает проход, успевшее примениться остаётся
    const applyAll = async () => {
        const { queue, skipped } = applyPlan();
        if (queue.length === 0) {
            if (skipped.length) {
                toast('Применять нечего', skipped.map(s => `${placeName(s.key)} — ${s.why}`).join('; '), 'err');
            }
            return;
        }

        abortRef.current = false;
        setApplyStep({ done: 0, total: queue.length });
        try {
            for (let i = 0; i < queue.length; i++) {
                const q = queue[i];
                if (abortRef.current) throw new Error('Остановлено оператором');
                setApplyStep({ done: i, total: queue.length });
                setApplyKey(q.key);

                if (cameraRef.current?.id !== q.cam!.id) {
                    onSelectCamera(q.cam!);
                    const up = await waitFor(
                        () => abortRef.current
                            || (cameraRef.current?.id === q.cam!.id
                                && Boolean(streamRef.current.streamId)
                                && !streamRef.current.pending),
                        20_000,
                    );
                    if (abortRef.current) throw new Error('Остановлено оператором');
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
                    () => abortRef.current || projState.doneSet.has(q.key) || warpFailRef.current !== null,
                    15_000,
                );
                if (abortRef.current) throw new Error('Остановлено оператором');
                if (!done) throw new Error(`Ответ по <${q.key}> не пришёл`);
                if (warpFailRef.current) throw new Error(warpFailRef.current);
                setApplyStep({ done: i + 1, total: queue.length });
            }

            const tail = skipped.length
                ? `Пропущены: ${skipped.map(s => `${placeName(s.key)} — ${s.why}`).join('; ')}`
                : 'Все места пресета собраны';
            toast('Готово', tail, skipped.length ? 'info' : 'ok');
        } catch (e) {
            toast('Проход остановлен', e instanceof Error ? e.message : String(e), 'err');
        } finally {
            setApplyKey(null);
            setApplyStep(null);
            abortRef.current = false;
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

    const streaming = playerState?.status === 'streaming';

    // Камера, назначенная активному месту: без неё кадр в редакторе не показываем
    const boundCamId = projState.activeCam ? projState.camId[projState.activeCam] ?? null : null;

    const streamCls = !streamId
        ? stream.pending ? ' warn' : ''
        : streaming
            ? ' ok'
            : playerState?.error
                ? ' err'
                : ' warn';

    const placeName = (key: string | null) =>
        key ? projState.activePreset?.cameras.find(c => c.key === key)?.name || key : null;

    return (
        <div className={`sv sv-proj${active ? '' : ' is-hidden'}`}>
            <div className="sv-main">
                <div className="toolbar">
                    {/* Коррекция общая с калибровкой: тумблер там, где виден кадр */}
                    {correction.ready && (
                        <Switch on={correction.enabled} disabled={!wsReady} onToggle={correction.setEnabled}>
                            Коррекция
                        </Switch>
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
                                <span className="seps">
                                    <span>Результат</span>
                                    {resultKey ? <span>{placeName(resultKey)}</span> : null}
                                </span>
                            </span>
                        </div>

                        {/* Сбрасывает печку и превью, точки и привязки остаются */}
                        {projState.doneSet.size > 0 && (
                            <div className="pj-acts">
                                <button
                                    className="icon-btn ib-over"
                                    data-tip="Сбросить warp"
                                    disabled={applyKey !== null}
                                    onClick={resetWarp}
                                >
                                    <Icon name="reset" size={13} />
                                </button>
                            </div>
                        )}
                    </div>

                    <div className="sv-gutter" data-gutter onPointerDown={onGutterDown} onDoubleClick={resetGutter}>
                        <i />
                    </div>

                    <div ref={wrapperRef} className={`stream${projState.applied ? ' is-applied' : ''}`}>
                        <div ref={mediaRef} className="pj-media" style={{ aspectRatio: aspect }}>
                            {!projState.activeCam ? (
                                <div className="empty">
                                    <Icon name="cursor" className="ico" />
                                    <b>Место не выбрано</b>
                                    <p>Выберите место в списке камер справа</p>
                                </div>
                            ) : !boundCamId ? (
                                <div className="empty">
                                    <Icon name="cam" className="ico" />
                                    <b>Камера не назначена</b>
                                    <p>Назначьте камеру месту {placeName(projState.activeCam)} в блоке «Камера»</p>
                                </div>
                            ) : streamId ? (
                                <div className="player" ref={onPlayerHost} />
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
                            <span className={`pill${projState.activeCam ? ' ok' : ''}`}>
                                <span className="dot" />
                                {projState.activeCam ? placeName(projState.activeCam) : 'Место не выбрано'}
                            </span>
                            <span className={`pill${boundCamId && streamId && streaming ? ' ok' : ''}`}>
                                <span className="dot" />
                                {boundCamId
                                    ? camera && camera.id === boundCamId
                                        ? (
                                            <span className="seps">
                                                <span>{camera.displayName}</span>
                                                <span>{camera.id}</span>
                                            </span>
                                          )
                                        : boundCamId
                                    : 'Камера не назначена'}
                            </span>
                        </div>
                        <div className="pj-acts">
                            <button
                                className="icon-btn ib-over"
                                data-tip="Удалить последнюю точку"
                                disabled={projState.points.length === 0}
                                onClick={removeLastPoint}
                            >
                                <Icon name="undo" size={13} />
                            </button>
                            <button
                                className="icon-btn ib-over"
                                data-tip="Очистить точки"
                                disabled={projState.points.length === 0}
                                onClick={clearPoints}
                            >
                                <Icon name="eraser" size={13} />
                            </button>
                        </div>

                        <span className="scene-hint">
                            <span className="seps"><span>shift+колесо</span><span>масштаб</span></span>
                            &nbsp;&nbsp;&nbsp;
                            <span className="seps"><span>shift+drag</span><span>сдвиг</span></span>
                        </span>
                    </div>
                </div>
            </div>

            <ProjSettings
                onOpenList={() => ws.sendMessage(PROJ_TYPE, { method: PROJ_METHOD.GET_LIST })}
                onSelectPreset={requestPreset}
                onSelectCamera={selectCamera}
                onRestorePlace={restorePlace}
                camera={camera}
                onSelectSourceCamera={assignCamera}
                correction={correction}
                stream={stream}
                wsReady={wsReady}
                sourceCams={sourceCams}
                sourceCamsError={sourceCamsError}
                applying={applyKey !== null}
                applyKey={applyKey}
                applyStep={applyStep}
                applyCount={applyPlan().queue.length}
                lutReady={allCamerasDone()}
                onApply={() => void applyAll()}
                onStopApply={stopApply}
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
