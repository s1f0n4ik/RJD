import { useRef, useState } from 'react';
import { Icon } from '../../../../app/Icons';

// Результат сшивки: картинка из ответа apply_warp с зумом колесом и перетаскиванием

interface ProjResultProps {
    // blob-url последнего пришедшего кадра
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

    if (!url) {
        return (
            <div className="empty">
                <Icon name="empty" className="ico" />
                <b>Результата нет</b>
            </div>
        );
    }

    return (
        <div
            className="pj-res-wrap"
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
        >
            <img
                className="pj-res"
                src={url}
                alt=""
                style={{ transform: `translate(${view.ox}px, ${view.oy}px) scale(${view.scale})` }}
            />
        </div>
    );
}
