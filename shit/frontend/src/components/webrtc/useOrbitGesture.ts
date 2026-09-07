import { useEffect, useRef, useState } from 'react';
import { getVideoContentRect } from './video-rect';

// Жесты орбиты 360: горизонталь ведёт по орбите, вертикаль наклоняет взгляд, колесо и щипок приближают

const SEND_INTERVAL_MS = 33;
const WHEEL_ZOOM_STEP = 0.0008;

interface UseOrbitGestureOptions {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    /** Отправка в сигналинг; false — WS закрыт */
    send: (data: Record<string, unknown>) => boolean;
    /** Слой отрисован и собирает жесты */
    enabled: boolean;
    /** Жест начался: пока он идёт, ячейку нельзя перетаскивать */
    onGestureLock?: (locked: boolean) => void;
}

interface UseOrbitGestureResult {
    layerRef: React.RefObject<HTMLDivElement>;
    dragging: boolean;
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
}

export function useOrbitGesture({
    videoRef,
    send,
    enabled,
    onGestureLock,
}: UseOrbitGestureOptions): UseOrbitGestureResult {
    const layerRef = useRef<HTMLDivElement>(null);

    const pointersRef = useRef(new Map<number, { x: number; y: number }>());
    const pinchRef = useRef(0);
    const accumRef = useRef({ dx: 0, dy: 0, dzoom: 0 });

    const [dragging, setDragging] = useState(false);

    // Слой держится точно по кадру: при contain по краям поля
    useEffect(() => {
        if (!enabled) return;
        let frame = 0;
        const sync = () => {
            frame = requestAnimationFrame(sync);
            const video = videoRef.current;
            const layer = layerRef.current;
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
    }, [videoRef, enabled]);

    // Накопленные дельты уходят пачкой, не чаще SEND_INTERVAL_MS
    useEffect(() => {
        if (!enabled) return;
        const timer = window.setInterval(() => {
            const acc = accumRef.current;
            if (!acc.dx && !acc.dy && !acc.dzoom) return;

            const pack = (value: number) => Number(Math.max(-1, Math.min(1, value)).toFixed(4));
            send({ type: 'orbit', dx: pack(acc.dx), dy: pack(acc.dy), dzoom: pack(acc.dzoom) });
            accumRef.current = { dx: 0, dy: 0, dzoom: 0 };
        }, SEND_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [send, enabled]);

    // Колесо: preventDefault требует non-passive слушателя
    useEffect(() => {
        const layer = layerRef.current;
        if (!enabled || !layer) return;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            // Колесо вверх — приближение, устройство сужает орбиту
            accumRef.current.dzoom += -event.deltaY * WHEEL_ZOOM_STEP;
        };
        layer.addEventListener('wheel', onWheel, { passive: false });
        return () => layer.removeEventListener('wheel', onWheel);
    }, [enabled]);

    // Снятый слой не оставляет за собой ни захвата перетаскивания, ни накопленных дельт
    useEffect(() => {
        if (enabled) return;
        pointersRef.current.clear();
        pinchRef.current = 0;
        accumRef.current = { dx: 0, dy: 0, dzoom: 0 };
        setDragging(false);
        onGestureLock?.(false);
    }, [enabled, onGestureLock]);

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        onGestureLock?.(true);
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
        if (pointersRef.current.size === 0) {
            setDragging(false);
            onGestureLock?.(false);
        }
    };

    return { layerRef, dragging, onPointerDown, onPointerMove, onPointerUp };
}
