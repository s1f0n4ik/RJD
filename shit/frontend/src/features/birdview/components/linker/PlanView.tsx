import { useEffect, useRef, useState } from 'react';
import type { PlanGeometry } from './plan-geometry';
import type { LinkerBindings, LinkerCamera } from '../../api/linker';

/**
 * Схема назначения камер.
 *
 * Каждый прямоугольник — место камеры на канвасе, взятое из конфигурации.
 * Оператор нажимает на место, а не сопоставляет ключ вроде left_front с
 * бортом, поэтому ключи в интерфейсе не показываются вовсе.
 */

interface PlanViewProps {
    geometry: PlanGeometry;
    bindings: LinkerBindings;
    cameras: LinkerCamera[];
    /** Во время эфира привязки менять нельзя: карты читает работающий поток. */
    locked: boolean;
    onAssign: (key: string, cameraId: string | null) => void;
}

export function PlanView({ geometry, bindings, cameras, locked, onAssign }: PlanViewProps) {
    const [openKey, setOpenKey] = useState<string | null>(null);
    const [showReal, setShowReal] = useState(false);
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!openKey) return;
        const onOutside = (e: MouseEvent) => {
            if (!hostRef.current?.contains(e.target as Node)) setOpenKey(null);
        };
        const onEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpenKey(null);
        };
        document.addEventListener('mousedown', onOutside);
        document.addEventListener('keydown', onEsc);
        return () => {
            document.removeEventListener('mousedown', onOutside);
            document.removeEventListener('keydown', onEsc);
        };
    }, [openKey]);

    useEffect(() => {
        if (locked) setOpenKey(null);
    }, [locked]);

    const nameOf = (id: string) => cameras.find(c => c.id === id)?.display_name ?? id;
    const open = geometry.tiles.find(t => t.key === openKey) ?? null;

    return (
        <div className="plan-host" ref={hostRef}>
            <svg
                className="plan-svg"
                viewBox={`0 0 ${geometry.view.width} ${geometry.view.height}`}
                preserveAspectRatio="xMidYMid meet"
                role="group"
                aria-label="Схема мест камер"
            >
                {geometry.overlays.map((rect, i) => (
                    <rect
                        key={`ov-${i}`}
                        className="plan-overlay"
                        x={rect.x}
                        y={rect.y}
                        width={rect.w}
                        height={rect.h}
                        rx={Math.min(rect.w, rect.h) * 0.06}
                    />
                ))}

                {geometry.tiles.map(t => {
                    const rect = showReal ? t.real : t.tile;
                    const pad = showReal ? 0 : 4;
                    const camera = bindings[t.key];
                    const cx = rect.x + rect.w / 2;
                    const cy = rect.y + rect.h / 2;

                    return (
                        <g
                            key={t.key}
                            className={
                                'plan-place' +
                                (camera ? ' assigned' : '') +
                                (openKey === t.key ? ' active' : '') +
                                (locked ? ' locked' : '')
                            }
                            tabIndex={locked ? -1 : 0}
                            role="button"
                            aria-label={`Место ${t.key}`}
                            onClick={() => !locked && setOpenKey(k => (k === t.key ? null : t.key))}
                            onKeyDown={e => {
                                if (locked) return;
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setOpenKey(k => (k === t.key ? null : t.key));
                                }
                            }}
                        >
                            <rect
                                className="plan-place-shape"
                                x={rect.x + pad}
                                y={rect.y + pad}
                                width={Math.max(1, rect.w - pad * 2)}
                                height={Math.max(1, rect.h - pad * 2)}
                                rx={8}
                            />
                            <text className="plan-place-cam" x={cx} y={cy + 5} textAnchor="middle">
                                {camera ? nameOf(camera) : 'не назначена'}
                            </text>
                        </g>
                    );
                })}
            </svg>

            {open && !locked && (
                <PlacePicker
                    title={open.key}
                    cameras={cameras}
                    bindings={bindings}
                    placeKey={open.key}
                    onPick={id => {
                        onAssign(open.key, id);
                        setOpenKey(null);
                    }}
                />
            )}

            <label className="plan-real-toggle">
                <input
                    type="checkbox"
                    checked={showReal}
                    onChange={e => setShowReal(e.target.checked)}
                />
                реальные зоны с нахлёстом
            </label>
        </div>
    );
}

interface PlacePickerProps {
    title: string;
    placeKey: string;
    cameras: LinkerCamera[];
    bindings: LinkerBindings;
    onPick: (cameraId: string | null) => void;
}

/**
 * Список камер для места. Выпадает по центру сцены, а не у самого места:
 * места бывают у самого края, и всплывающий список там пришлось бы поджимать.
 */
function PlacePicker({ title, placeKey, cameras, bindings, onPick }: PlacePickerProps) {
    const takenBy = (id: string) =>
        Object.entries(bindings).find(([key, cam]) => cam === id && key !== placeKey)?.[0];

    return (
        <div className="plan-picker" role="menu" onClick={e => e.stopPropagation()}>
            <div className="plan-picker-head">{title}</div>

            {cameras.length === 0 ? (
                <div className="plan-picker-empty">Нет доступных камер</div>
            ) : (
                cameras.map(c => {
                    const taken = takenBy(c.id);
                    return (
                        <button
                            key={c.id}
                            type="button"
                            className={`plan-picker-item${taken ? ' taken' : ''}`}
                            onClick={() => onPick(c.id)}
                        >
                            <span>{c.display_name}</span>
                            <span className="plan-picker-note">{taken ? 'занята' : c.id}</span>
                        </button>
                    );
                })
            )}

            {bindings[placeKey] && (
                <button
                    type="button"
                    className="plan-picker-item clear"
                    onClick={() => onPick(null)}
                >
                    Снять камеру
                </button>
            )}
        </div>
    );
}
