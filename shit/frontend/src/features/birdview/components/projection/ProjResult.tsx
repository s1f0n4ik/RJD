import { useRef, useState } from 'react';

/**
 * Результат сшивки: картинка из ответа apply_warp с зумом и перетаскиванием.
 * Порт proj-result.js.
 *
 * Канвас #projResultImg из оригинала не переносится: в него никогда ничего
 * не рисовалось, результат всегда показывался вставляемым <img>.
 */

interface ProjResultProps {
    /** blob-url последнего пришедшего кадра. */
    url: string | null;
}

export function ProjResult({ url }: ProjResultProps) {
    const [view, setView] = useState({ scale: 1, ox: 0, oy: 0 });
    const dragRef = useRef<{ startX: number; startY: number } | null>(null);

    const onWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        setView(v => ({
            ...v,
            scale: Math.min(8, Math.max(0.25, v.scale * (e.deltaY < 0 ? 1.1 : 0.9))),
        }));
    };

    const onPointerDown = (e: React.PointerEvent) => {
        dragRef.current = { startX: e.clientX - view.ox, startY: e.clientY - view.oy };
        e.currentTarget.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d) return;
        setView(v => ({ ...v, ox: e.clientX - d.startX, oy: e.clientY - d.startY }));
    };

    const onPointerUp = (e: React.PointerEvent) => {
        dragRef.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
    };

    return (
        <div
            className="proj-result-canvas"
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
        >
            {url ? (
                <img
                    className="proj-result-img"
                    src={url}
                    alt=""
                    style={{
                        transform: `translate(${view.ox}px, ${view.oy}px) scale(${view.scale})`,
                    }}
                />
            ) : (
                <div className="no-signal">
                    <div className="no-signal-icon">⊘</div>
                    <div className="no-signal-text">Нет данных</div>
                    <div className="no-signal-sub">Примените warp для отображения</div>
                </div>
            )}
            <div className="proj-canvas-hint">scroll — zoom · drag — pan</div>
        </div>
    );
}
