import { useCallback, useEffect, useRef, useState } from 'react';
import WebRTCPlayer from '../../../../components/WebRTCPlayer';
import type { BirdviewWs } from '../../hooks/useBirdviewWs';
import type { EventLog } from '../../hooks/useEventLog';
import type { CalibrationCamera, WsMessage } from '../../api/ws-types';
import { wsUrl } from '../../constants';
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
} from './proj-canvas';
import { ProjSettings } from './ProjSettings';
import { ProjResult } from './ProjResult';
import { LutModal } from './LutModal';

/**
 * Экран «Сборка» (проекция). Порт page-2.
 *
 * Живой кадр берётся вторым экземпляром WebRTCPlayer с тем же streamId:
 * брокер допускает несколько клиентов на камеру, а два независимых плеера
 * избавляют от переноса одного <video> между экранами.
 *
 * Геометрия слоя точек задаётся соотношением сторон камеры через CSS
 * aspect-ratio, поэтому канвас совпадает с кадром без расчёта letterbox.
 */

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

    const [settingsOpen, setSettingsOpen] = useState(false);
    const [resultUrl, setResultUrl] = useState<string | null>(null);
    const [lutOpen, setLutOpen] = useState(false);
    const [lutSaving, setLutSaving] = useState(false);

    // Пресет, на который оператор хочет перейти, пока не подтвердил потерю точек
    const [pendingPreset, setPendingPreset] = useState<string | null>(null);
    // Камеры, для которых в пришедшем пресете нашлась сохранённая разметка
    const [restorable, setRestorable] = useState<string[]>([]);

    const resultUrlRef = useRef<string | null>(null);

    /** Смена пресета обнуляет карты на сервере — показывать старый результат нельзя. */
    const clearResult = useCallback(() => {
        if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
        resultUrlRef.current = null;
        setResultUrl(null);
    }, []);

    const toast = useCallback(
        (title: string, desc: string, type: 'ok' | 'err' | 'info') => showToast(title, desc, type),
        [showToast],
    );

    /** Применяет текущий зум к слою видео. Канвас перерисовывается сам. */
    const syncTransform = useCallback(() => {
        if (mediaRef.current) mediaRef.current.style.transform = mediaTransform();
        projDraw();
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
            if (projState.applied) return;
            if (e.ctrlKey || e.shiftKey || e.button !== 0) return;

            if (!projState.activeCam) {
                toast('Камера не выбрана', 'Выберите камеру в настройках', 'err');
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
            if (projState.applied || !projState.activeCam) return;
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
            if (projState.applied || !projState.activeCam) return;
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
            if (!e.ctrlKey) return;
            e.preventDefault();

            const rect = wrapper.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;

            const v = projState.view;
            const prev = v.scale;
            const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
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

                    emitProjChange();
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

    /** Смена вида конфигурации сбрасывает всю разметку — спрашиваем, если есть что терять. */
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
            toast('Камера не выбрана', 'Выберите камеру в настройках', 'err');
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

    const openLut = () => {
        if (!allCamerasDone()) {
            toast('Нельзя сохранить', 'Не все камеры применены', 'err');
            return;
        }
        setLutOpen(true);
    };

    const aspect = camera ? `${camera.width} / ${camera.height}` : '16 / 9';
    const maxPts = currentMaxPoints();

    return (
        <main className={`main-layout proj-layout ${active ? '' : 'hidden'}`}>
            <ProjSettings
                open={settingsOpen}
                onToggle={() => setSettingsOpen(o => !o)}
                onOpenList={() => ws.sendMessage(PROJ_TYPE, { method: PROJ_METHOD.GET_LIST })}
                onSelectPreset={requestPreset}
                onSelectCamera={selectCamera}
                camera={camera}
                onSelectSourceCamera={onSelectCamera}
                correction={correction}
                stream={stream}
                wsReady={wsReady}
            />

            <section className={`proj-warp-area${settingsOpen ? ' shifted' : ''}`}>
                <div className="viewer-header">
                    <span className="viewer-label">WARP — Точки проекции</span>
                    <div className="viewer-meta">
                        <span className="meta-tag">{projState.points.length} / {maxPts}</span>
                        <span className="meta-tag">
                            Режим: {projState.applied ? 'применён' : 'редактирование'}
                        </span>
                    </div>
                </div>

                <div
                    ref={wrapperRef}
                    className={`proj-warp-wrapper${projState.applied ? ' applied' : ''}`}
                >
                    {streamId ? (
                        <div
                            ref={mediaRef}
                            className="proj-media-layer"
                            style={{ aspectRatio: aspect }}
                        >
                            <WebRTCPlayer
                                key={`proj-${streamId}`}
                                cameraId={streamId}
                                signalingUrl={wsUrl(`/signaling/client/${streamId}`)}
                            />
                        </div>
                    ) : (
                        <div ref={mediaRef} className="proj-media-layer" style={{ aspectRatio: aspect }}>
                            <div className="no-signal">
                                <div className="no-signal-icon">{stream.pending ? '◌' : '⊘'}</div>
                                <div className="no-signal-text">
                                    {stream.pending ? 'Подключение' : 'Нет сигнала'}
                                </div>
                                <div className="no-signal-sub">
                                    {stream.pending
                                        ? 'Калибратор поднимает поток, это занимает несколько секунд'
                                        : 'Выберите камеру в настройках слева'}
                                </div>
                            </div>
                        </div>
                    )}

                    <canvas ref={canvasRef} className="proj-warp-canvas" />
                    <div className="proj-zoom-hint">ctrl+scroll — zoom · shift+drag — pan</div>
                </div>

                <div className="viewer-footer">
                    <div className="footer-left">
                        <button className="btn btn-ghost btn-sm" onClick={removeLastPoint}>
                            ← Удалить
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={clearPoints}>
                            ✕ Очистить
                        </button>
                    </div>
                    <div className="footer-right">
                        <button className="btn btn-primary btn-sm" onClick={toggleApply}>
                            {projState.applied ? '✎ Вернуть редактирование' : '⊛ Применить warp'}
                        </button>
                    </div>
                </div>
            </section>

            <section className="proj-result-area">
                <div className="viewer-header">
                    <span className="viewer-label">BIRDVIEW — Результат</span>
                </div>

                <ProjResult url={resultUrl} />

                <button
                    className="btn proj-lut-btn"
                    disabled={!allCamerasDone()}
                    title={
                        allCamerasDone()
                            ? 'Сохранить конфигурацию stitching'
                            : 'Доступно после применения warp на всех камерах'
                    }
                    onClick={openLut}
                >
                    ⊙ Рассчитать LUT
                </button>
            </section>

            {pendingPreset && (
                <ConfirmModal
                    title="Смена конфигурации"
                    message="Разметка точек будет потеряна, а результат сборки сброшен. Продолжить?"
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
                        'В этой конфигурации сохранены точки для камер: ' +
                        restorable
                            .map(
                                key =>
                                    projState.activePreset?.cameras.find(c => c.key === key)?.name ||
                                    key,
                            )
                            .join(', ') +
                        '. Загрузить их?'
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
        </main>
    );
}
