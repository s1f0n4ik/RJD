import React, { useEffect, useRef, useState } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import {
    Map as MapIcon,
    ThreeSixty as ThreeSixtyIcon,
    ViewInAr as ViewInArIcon,
} from '@mui/icons-material';
import WebRTCPlayer, { type SignalingSender } from './WebRTCPlayer';

/**
 * Плеер потока 360: жестовый канвас поверх видеоконтента.
 *
 * Канвас повторяет прямоугольник реального кадра (как у NeuralWebRTCPlayer)
 * и собирает жесты: горизонталь — движение по орбите, вертикаль — наклон
 * взгляда, колесо и щипок — зум. Дельты нормируются на размер канваса и
 * уходят в сигналинг-WS сообщениями type=orbit с троттлингом; работают они
 * или нет — решает сервер: в автооблёте дельты игнорируются.
 *
 * Кнопки (controls) — для мест отображения вне страницы линкера: тумблер
 * ручного вращения и переключение top/surround. Переключение плеер делает
 * сам: REST по активной конфигурации, ожидание пересборки вывода, ремоунт.
 * На странице линкера кнопок нет — там управляет форма параметров.
 */

export type SurroundViewMode = 'top' | 'surround';

const SEND_INTERVAL_MS = 33;
const WHEEL_ZOOM_STEP = 0.0008;
const SWITCH_POLL_MS = 1_000;
const SWITCH_TIMEOUT_MS = 20_000;

interface SurroundWebRTCPlayerProps {
    cameraId: string;
    cameraName?: string;
    signalingUrl: string;
    onError?: (error: string) => void;
    background?: string;
    /** Кнопки оверлея. Жесты живут и без них — на странице линкера. */
    controls?: boolean;
}

/** Статус линкера: ровно те поля, что нужны плееру. */
async function fetchLinkerStatus(): Promise<{
    running: boolean;
    streamId: string;
    viewMode: SurroundViewMode;
    width: number;
    height: number;
} | null> {
    try {
        const res = await fetch('/linker/status');
        const json = await res.json();
        const d = json?.data ?? json;
        return {
            running: Boolean(d?.running),
            streamId: String(d?.stream_id ?? ''),
            viewMode: d?.view_mode === 'surround' ? 'surround' : 'top',
            width: Number(d?.width) || 0,
            height: Number(d?.height) || 0,
        };
    } catch {
        return null;
    }
}

const STATUS_WATCH_MS = 5_000;

/** Прямоугольник видеоконтента внутри <video> c object-fit: contain. */
function getVideoContentRect(video: HTMLVideoElement): DOMRect | null {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const elem = video.getBoundingClientRect();
    if (!elem.width || !elem.height) return null;

    const videoAspect = vw / vh;
    const containerAspect = elem.width / elem.height;

    let contentW: number, contentH: number;
    if (videoAspect > containerAspect) {
        contentW = elem.width;
        contentH = elem.width / videoAspect;
    } else {
        contentH = elem.height;
        contentW = elem.height * videoAspect;
    }

    return new DOMRect(
        (elem.width - contentW) / 2,
        (elem.height - contentH) / 2,
        contentW,
        contentH,
    );
}

const SurroundWebRTCPlayer: React.FC<SurroundWebRTCPlayerProps> = ({
    cameraId,
    cameraName,
    signalingUrl,
    onError,
    background,
    controls = false,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const rafRef = useRef<number | null>(null);
    const prevVideoRect = useRef<DOMRect | null>(null);

    const signalingRef = useRef<SignalingSender | null>(null);

    // Накопитель жестов между отправками
    const accumRef = useRef({ dx: 0, dy: 0, dzoom: 0 });
    const pointersRef = useRef(new Map<number, { x: number; y: number }>());
    const pinchDistRef = useRef(0);
    const [dragging, setDragging] = useState(false);

    const [manual, setManual] = useState(false);
    // Последний подтверждённый сервером режим: откат при отказе
    const lastConfirmedRef = useRef(false);

    // Режим вывода для кнопок; переключение ремоунтит внутренний плеер
    const [viewMode, setViewMode] = useState<SurroundViewMode | null>(null);
    const [switching, setSwitching] = useState(false);
    const [reconnectNonce, setReconnectNonce] = useState(0);

    // ── <video> изнутри WebRTCPlayer через DOM-поиск, как у Neural ──
    useEffect(() => {
        let found = false;
        const poll = setInterval(() => {
            if (!containerRef.current) return;
            const vid = containerRef.current.querySelector<HTMLVideoElement>('video');
            if (vid && !found) {
                found = true;
                videoRef.current = vid;
                clearInterval(poll);
            }
        }, 100);
        return () => clearInterval(poll);
    }, []);

    // ── Канвас строго по прямоугольнику видеоконтента ──
    useEffect(() => {
        const sync = () => {
            rafRef.current = requestAnimationFrame(sync);

            const canvas = canvasRef.current;
            const video = videoRef.current;
            if (!canvas || !video) return;

            const rect = getVideoContentRect(video);
            if (!rect) return;

            const prev = prevVideoRect.current;
            if (
                prev &&
                Math.abs(prev.x - rect.x) < 0.5 &&
                Math.abs(prev.y - rect.y) < 0.5 &&
                Math.abs(prev.width - rect.width) < 0.5 &&
                Math.abs(prev.height - rect.height) < 0.5
            ) return;

            prevVideoRect.current = rect;
            canvas.style.left = `${rect.x}px`;
            canvas.style.top = `${rect.y}px`;
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
        };

        rafRef.current = requestAnimationFrame(sync);
        return () => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        };
    }, []);

    // ── Отправка накопленных дельт, не чаще SEND_INTERVAL_MS ──
    useEffect(() => {
        const id = window.setInterval(() => {
            const acc = accumRef.current;
            if (!acc.dx && !acc.dy && !acc.dzoom) return;

            const sender = signalingRef.current;
            if (!sender) return;

            const pack = (v: number) => Number(Math.max(-1, Math.min(1, v)).toFixed(4));
            sender.send({
                type: 'orbit',
                dx: pack(acc.dx),
                dy: pack(acc.dy),
                dzoom: pack(acc.dzoom),
            });
            accumRef.current = { dx: 0, dy: 0, dzoom: 0 };
        }, SEND_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, []);

    // ── Колесо: preventDefault требует non-passive слушателя ──
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            // Колесо вверх - приближение, сервер сужает орбиту
            accumRef.current.dzoom += -e.deltaY * WHEEL_ZOOM_STEP;
        };
        canvas.addEventListener('wheel', onWheel, { passive: false });
        return () => canvas.removeEventListener('wheel', onWheel);
    }, []);

    // ── Стартовое положение тумблера — дефолт конфигурации вывода ──
    useEffect(() => {
        if (!controls) return;
        let cancelled = false;
        fetch('/linker/surround')
            .then(r => r.json())
            .then(json => {
                const d = json?.data ?? json;
                if (!cancelled && typeof d?.orbit?.interactive === 'boolean') {
                    setManual(d.orbit.interactive);
                    lastConfirmedRef.current = d.orbit.interactive;
                }
            })
            .catch(() => {
                // Ручка молчит - тумблер остаётся в авто
            });
        return () => { cancelled = true; };
    }, [controls]);

    // ── Режим вывода для кнопок ──
    useEffect(() => {
        if (!controls) return;
        let cancelled = false;
        void fetchLinkerStatus().then(st => {
            if (!cancelled && st) setViewMode(st.viewMode);
        });
        return () => { cancelled = true; };
    }, [controls]);

    // ── Сторож пересборки вывода ──
    // Смена разрешения или режима на сервере пересоздаёт пайплайн, а старая
    // WebRTC-сессия виснет. Изменение размера кадра в статусе — сигнал
    // пересоздать соединение ремоунтом внутреннего плеера.
    const lastShapeRef = useRef<string | null>(null);
    useEffect(() => {
        const id = window.setInterval(() => {
            void fetchLinkerStatus().then(st => {
                if (!st || !st.running || st.streamId !== cameraId) return;
                if (!st.width || !st.height) return;

                const shape = `${st.viewMode}-${st.width}x${st.height}`;
                if (lastShapeRef.current === null) {
                    lastShapeRef.current = shape;
                    return;
                }
                if (lastShapeRef.current !== shape) {
                    lastShapeRef.current = shape;
                    setViewMode(st.viewMode);
                    setReconnectNonce(n => n + 1);
                }
            });
        }, STATUS_WATCH_MS);
        return () => window.clearInterval(id);
    }, [cameraId]);

    // Переключение режима: REST по активной конфигурации, ожидание пересборки
    const switchMode = async () => {
        if (!viewMode || switching) return;
        const next: SurroundViewMode = viewMode === 'surround' ? 'top' : 'surround';
        setSwitching(true);
        try {
            const res = await fetch('/linker/view-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ view_mode: next }),
            });
            if (!res.ok) throw new Error(await res.text().catch(() => `${res.status}`));

            const deadline = Date.now() + SWITCH_TIMEOUT_MS;
            let up = false;
            while (Date.now() < deadline) {
                const st = await fetchLinkerStatus();
                if (st?.running && st.streamId) { up = true; break; }
                await new Promise(r => setTimeout(r, SWITCH_POLL_MS));
            }
            if (!up) throw new Error('Вывод не поднялся после смены режима');

            setViewMode(next);
            // Размер кадра у режимов разный: сессия пересоздаётся ремоунтом
            setReconnectNonce(n => n + 1);
        } catch (e) {
            onError?.(e instanceof Error ? e.message : String(e));
        } finally {
            setSwitching(false);
        }
    };

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointersRef.current.size === 2) {
            const [a, b] = [...pointersRef.current.values()];
            pinchDistRef.current = Math.hypot(a.x - b.x, a.y - b.y);
        }
        setDragging(true);
    };

    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const p = pointersRef.current.get(e.pointerId);
        if (!p) return;

        const rect = e.currentTarget.getBoundingClientRect();
        const prevX = p.x;
        const prevY = p.y;
        p.x = e.clientX;
        p.y = e.clientY;

        if (pointersRef.current.size === 1) {
            if (rect.width > 0) accumRef.current.dx += (p.x - prevX) / rect.width;
            if (rect.height > 0) accumRef.current.dy += (p.y - prevY) / rect.height;
        }
        else if (pointersRef.current.size === 2) {
            // Щипок: пальцы врозь - приближение
            const [a, b] = [...pointersRef.current.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            if (pinchDistRef.current > 0 && rect.width > 0) {
                accumRef.current.dzoom += (d - pinchDistRef.current) / rect.width;
            }
            pinchDistRef.current = d;
        }
    };

    const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
        pointersRef.current.delete(e.pointerId);
        pinchDistRef.current = 0;
        if (pointersRef.current.size === 0) setDragging(false);
    };

    const toggleManual = () => {
        const next = !manual;
        const sender = signalingRef.current;
        if (!sender) return;
        // Оптимистично: отказ сервера откатит через ответ orbit
        if (sender.send({ type: 'orbit', mode: next ? 'manual' : 'auto' })) {
            setManual(next);
        }
    };

    // Ответы приходят только на смену режима: успех фиксирует, отказ откатывает
    const handleOrbitReply = (msg: Record<string, unknown>) => {
        if (msg.client !== signalingRef.current?.clientId) return;
        if (msg.ret === 'success') {
            const desc = String(msg.description ?? '');
            if (desc.startsWith('mode=')) {
                const on = desc === 'mode=manual';
                setManual(on);
                lastConfirmedRef.current = on;
            }
            return;
        }
        setManual(lastConfirmedRef.current);
        onError?.(String(msg.description ?? 'orbit rejected'));
    };

    return (
        <Box
            ref={containerRef}
            sx={{ position: 'relative', width: '100%', height: '100%' }}
        >
            <WebRTCPlayer
                key={`inner-${cameraId}-${reconnectNonce}`}
                cameraId={cameraId}
                cameraName={cameraName}
                signalingUrl={signalingUrl}
                onError={onError}
                signalingRef={signalingRef}
                onExtraMessage={handleOrbitReply}
                background={background}
            />

            {/* Жестовый слой: позицию и размер ведёт RAF по видеоконтенту */}
            <canvas
                ref={canvasRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    // Нулевой до первого кадра: размер и позицию ведёт RAF
                    width: 0,
                    height: 0,
                    zIndex: 10,
                    touchAction: 'none',
                    cursor: dragging ? 'grabbing' : 'grab',
                }}
            />

            {controls && (
                <Box
                    sx={{
                        position: 'absolute',
                        bottom: 6,
                        right: 44,
                        zIndex: 20,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.5,
                    }}
                >
                    {viewMode === 'surround' && (
                        <Tooltip
                            title={manual ? 'Вернуть автооблёт' : 'Ручное вращение'}
                            placement="top"
                            arrow
                        >
                            <IconButton
                                size="small"
                                onClick={toggleManual}
                                disabled={switching}
                                sx={{
                                    bgcolor: 'rgba(0,0,0,0.55)',
                                    color: manual ? 'success.light' : 'grey.500',
                                    width: 32,
                                    height: 32,
                                    '&:hover': { bgcolor: 'rgba(0,0,0,0.8)' },
                                }}
                            >
                                <ThreeSixtyIcon fontSize="small" />
                            </IconButton>
                        </Tooltip>
                    )}

                    {viewMode !== null && (
                        <Tooltip
                            title={viewMode === 'surround' ? 'Вид сверху' : 'Объёмный вид'}
                            placement="top"
                            arrow
                        >
                            <IconButton
                                size="small"
                                onClick={() => void switchMode()}
                                disabled={switching}
                                sx={{
                                    bgcolor: 'rgba(0,0,0,0.55)',
                                    color: switching ? 'grey.600' : 'grey.300',
                                    width: 32,
                                    height: 32,
                                    '&:hover': { bgcolor: 'rgba(0,0,0,0.8)' },
                                }}
                            >
                                {viewMode === 'surround'
                                    ? <MapIcon fontSize="small" />
                                    : <ViewInArIcon fontSize="small" />}
                            </IconButton>
                        </Tooltip>
                    )}
                </Box>
            )}
        </Box>
    );
};

export default SurroundWebRTCPlayer;
