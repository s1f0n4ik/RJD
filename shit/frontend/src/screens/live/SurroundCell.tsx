/**
 * Ячейка виртуального потока 360.
 *
 * Поверх видео — жестовый слой ровно по кадру: горизонталь ведёт по орбите,
 * вертикаль наклоняет взгляд, колесо и щипок приближают. Дельты нормируются
 * на размер кадра и уходят в сигналинг сообщениями type=orbit с троттлингом;
 * слушается ли ручное вращение — решает устройство.
 *
 * Кнопок режима вывода (сверху / круговой) здесь нет: это настройка модуля,
 * ей место на вкладке «Система 360».
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    useWebRTCPlayer,
    type PlayerMessage,
    type PlayerStats,
    type PlayerStatus,
} from '../../components/webrtc/useWebRTCPlayer';
import { getVideoContentRect } from '../../components/webrtc/video-rect';
import { formatDeviceDate, formatDeviceTime } from '../../app/useDeviceClock';
import { CellFlash, CellState, useFlash } from './CellOverlays';
import type { Overlays } from './model';

const SEND_INTERVAL_MS = 33;
const WHEEL_ZOOM_STEP = 0.0008;

interface SurroundCellProps {
    streamId: string;
    name: string;
    signalingUrl: string;
    overlays: Overlays;
    deviceTimeMs: number | null;
    collectStats: boolean;
    /** Режим орбиты из сохранённого отображения */
    initialManual?: boolean;
    onManualChange?: (manual: boolean) => void;
    onStatus?: (status: PlayerStatus) => void;
    onStats?: (stats: PlayerStats | null) => void;
}

function num(value: number | null | undefined, digits: number): string {
    return value === null || value === undefined ? '—' : value.toFixed(digits).replace('.', ',');
}

export function SurroundCell({
    streamId,
    name,
    signalingUrl,
    overlays,
    deviceTimeMs,
    collectStats,
    initialManual,
    onManualChange,
    onStatus,
    onStats,
}: SurroundCellProps) {
    const boxRef = useRef<HTMLDivElement>(null);
    const gestureRef = useRef<HTMLDivElement>(null);

    const pointersRef = useRef(new Map<number, { x: number; y: number }>());
    const pinchRef = useRef(0);
    const accumRef = useRef({ dx: 0, dy: 0, dzoom: 0 });
    // Последнее подтверждённое устройством состояние: к нему откатываемся при отказе
    const confirmedRef = useRef(Boolean(initialManual));
    const initialAppliedRef = useRef(false);

    const [manual, setManual] = useState(Boolean(initialManual));
    const [dragging, setDragging] = useState(false);

    const handleMessage = useCallback((msg: PlayerMessage) => {
        if (msg.type !== 'orbit') return;

        if (msg.ret === 'success') {
            const description = String(msg.description ?? '');
            if (description.startsWith('mode=')) {
                const on = description === 'mode=manual';
                confirmedRef.current = on;
                setManual(on);
                onManualChange?.(on);
            }
            return;
        }

        // Отказ устройства откатывает кнопку к подтверждённому состоянию
        setManual(confirmedRef.current);
    }, [onManualChange]);

    const { flash, show: showFlash, hide: hideFlash } = useFlash();

    const { status, errorInfo, videoRef, stats, send } = useWebRTCPlayer({
        cameraId: streamId,
        signalingUrl,
        collectStats,
        onMessage: handleMessage,
    });

    useEffect(() => {
        onStatus?.(status);
    }, [status, onStatus]);

    useEffect(() => {
        onStats?.(stats);
    }, [stats, onStats]);

    // При живом кадре причина показывается плашкой, а не занимает центр
    useEffect(() => {
        if (status !== 'streaming' || !errorInfo) return;
        showFlash(errorInfo.text, errorInfo.code);
    }, [status, errorInfo, showFlash]);

    // Слой жестов держится точно по кадру: при contain по краям поля
    useEffect(() => {
        let frame = 0;
        const sync = () => {
            frame = requestAnimationFrame(sync);
            const video = videoRef.current;
            const layer = gestureRef.current;
            if (!video || !layer) return;

            const rect = getVideoContentRect(video);
            if (!rect) return;

            layer.style.left = `${rect.x}px`;
            layer.style.top = `${rect.y}px`;
            layer.style.width = `${rect.width}px`;
            layer.style.height = `${rect.height}px`;
        };
        frame = requestAnimationFrame(sync);
        return () => cancelAnimationFrame(frame);
    }, [videoRef]);

    // Накопленные дельты уходят пачкой, не чаще SEND_INTERVAL_MS
    useEffect(() => {
        const timer = window.setInterval(() => {
            const acc = accumRef.current;
            if (!acc.dx && !acc.dy && !acc.dzoom) return;

            const pack = (value: number) => Number(Math.max(-1, Math.min(1, value)).toFixed(4));
            send({ type: 'orbit', dx: pack(acc.dx), dy: pack(acc.dy), dzoom: pack(acc.dzoom) });
            accumRef.current = { dx: 0, dy: 0, dzoom: 0 };
        }, SEND_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [send]);

    // Колесо: preventDefault требует non-passive слушателя
    useEffect(() => {
        const layer = gestureRef.current;
        if (!layer) return;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            // Колесо вверх — приближение, устройство сужает орбиту
            accumRef.current.dzoom += -event.deltaY * WHEEL_ZOOM_STEP;
        };
        layer.addEventListener('wheel', onWheel, { passive: false });
        return () => layer.removeEventListener('wheel', onWheel);
    }, []);

    // Режим из сохранённого отображения применяется один раз, когда пошло видео
    useEffect(() => {
        if (initialManual === undefined || initialAppliedRef.current) return;
        if (status !== 'streaming') return;
        if (send({ type: 'orbit', mode: initialManual ? 'manual' : 'auto' })) {
            initialAppliedRef.current = true;
        }
    }, [initialManual, status, send]);

    const toggleManual = () => {
        const next = !manual;
        // Оптимистично: отказ устройства откатит ответом orbit
        if (send({ type: 'orbit', mode: next ? 'manual' : 'auto' })) {
            setManual(next);
            onManualChange?.(next);
        }
    };

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointersRef.current.size === 2) {
            const [a, b] = [...pointersRef.current.values()];
            pinchRef.current = Math.hypot(a.x - b.x, a.y - b.y);
        }
        setDragging(true);
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const point = pointersRef.current.get(event.pointerId);
        if (!point) return;

        const rect = event.currentTarget.getBoundingClientRect();
        const prevX = point.x;
        const prevY = point.y;
        point.x = event.clientX;
        point.y = event.clientY;

        if (pointersRef.current.size === 1) {
            if (rect.width > 0) accumRef.current.dx += (point.x - prevX) / rect.width;
            if (rect.height > 0) accumRef.current.dy += (point.y - prevY) / rect.height;
            return;
        }

        // Щипок: пальцы врозь — приближение
        if (pointersRef.current.size === 2) {
            const [a, b] = [...pointersRef.current.values()];
            const distance = Math.hypot(a.x - b.x, a.y - b.y);
            if (pinchRef.current > 0 && rect.width > 0) {
                accumRef.current.dzoom += (distance - pinchRef.current) / rect.width;
            }
            pinchRef.current = distance;
        }
    };

    const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
        pointersRef.current.delete(event.pointerId);
        pinchRef.current = 0;
        if (pointersRef.current.size === 0) setDragging(false);
    };

    const live = status === 'streaming';

    return (
        <div className="cellv" ref={boxRef}>
            <video ref={videoRef} autoPlay playsInline muted className="cellv-video" />

            <div
                ref={gestureRef}
                className={`cellv-gesture${dragging ? ' is-drag' : ''}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
            />

            <div className="cell-bar">
                {overlays.name && <span className="nm">{name}</span>}
                {live && (
                    <span className="num">
                        {num(stats?.fps, 1)} fps · {num(stats?.mbits, 1)} Мбит/с
                    </span>
                )}
            </div>

            {!live && <CellState status={status} error={errorInfo} />}
            {live && flash && <CellFlash flash={flash} onClose={hideFlash} />}

            {overlays.time && (
                <span className="cellv-time">
                    {formatDeviceDate(deviceTimeMs)} · {formatDeviceTime(deviceTimeMs)}
                </span>
            )}

            <button
                className={`badge-360${manual ? ' is-on' : ''}`}
                title={manual ? 'Ручное вращение включено' : 'Включить ручное вращение'}
                onClick={event => { event.stopPropagation(); toggleManual(); }}
            >
                вращение
            </button>
        </div>
    );
}
