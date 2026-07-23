import { useEffect, useRef, useState } from 'react';
import type { PlanGeometry, Rect } from './plan-geometry';
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

    // Отправная точка кегля: канвасы бывают и 570, и 1850 в стороне, и
    // фиксированный размер в одном случае теряется, в другом закрывает всё
    const label = Math.max(geometry.view.width, geometry.view.height) * 0.022;

    /**
     * Кегль, при котором надпись помещается в свою рамку.
     *
     * Единый размер на всю схему не годится: узкое место получает текст
     * шире себя, и он вылезает за границы. Измерить строку без DOM нельзя,
     * поэтому считаем по моноширинному шагу — примерно 0.6 кегля на знак.
     */
    const fit = (text: string, box: Rect, cap = label) => {
        if (!text) return cap;
        const byWidth = (box.w * 0.88) / (text.length * 0.6);
        const byHeight = box.h * 0.22;
        return Math.max(1, Math.min(cap, byWidth, byHeight));
    };

    return (
        <div className="plan-host" ref={hostRef}>
            <svg
                className="plan-svg"
                viewBox={`0 0 ${geometry.view.width} ${geometry.view.height}`}
                preserveAspectRatio="xMidYMid meet"
                role="group"
                aria-label="Схема мест камер"
            >
                {geometry.overlays.map((ov, i) => {
                    const cx = ov.rect.x + ov.rect.w / 2;
                    const cy = ov.rect.y + ov.rect.h / 2;

                    const kindSize = fit('ГАБАРИТ', ov.rect, label * 0.72);
                    const nameSize = fit(ov.name, ov.rect, label * 0.86);
                    // На мелкой рамке подпись превратится в нечитаемую кашу
                    const roomy = Math.min(kindSize, nameSize) > label * 0.3;

                    return (
                        <g key={`ov-${i}`} className="plan-overlay-group">
                            <rect
                                className="plan-overlay"
                                x={ov.rect.x}
                                y={ov.rect.y}
                                width={ov.rect.w}
                                height={ov.rect.h}
                                rx={Math.min(ov.rect.w, ov.rect.h) * 0.06}
                            />
                            {roomy && (
                                <>
                                    <text
                                        className="plan-overlay-kind"
                                        x={cx}
                                        y={cy - nameSize * 0.55}
                                        textAnchor="middle"
                                        style={{ fontSize: kindSize }}
                                    >
                                        ГАБАРИТ
                                    </text>
                                    <text
                                        className="plan-overlay-name"
                                        x={cx}
                                        y={cy + nameSize * 0.9}
                                        textAnchor="middle"
                                        style={{ fontSize: nameSize }}
                                    >
                                        {ov.name}
                                    </text>
                                </>
                            )}
                        </g>
                    );
                })}

                {geometry.tiles.map(t => {
                    const rect = t.rect;
                    const camera = bindings[t.key];
                    const cx = rect.x + rect.w / 2;
                    const cy = rect.y + rect.h / 2;

                    const camText = camera ? nameOf(camera) : 'не назначена';
                    // Оба ярлыка живут в одной рамке, поэтому кегль берём
                    // общий по худшему из них — иначе строки разъедутся
                    const size = Math.min(
                        fit(t.name, rect, label * 0.78),
                        fit(camText, rect, label),
                    );

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
                            aria-label={`Место ${t.name}`}
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
                                x={rect.x}
                                y={rect.y}
                                width={rect.w}
                                height={rect.h}
                                rx={8}
                            />
                            <text
                                className="plan-place-title"
                                x={cx}
                                y={cy - size * 0.45}
                                textAnchor="middle"
                                style={{ fontSize: size * 0.82 }}
                            >
                                {t.name}
                            </text>
                            <text
                                className="plan-place-cam"
                                x={cx}
                                y={cy + size}
                                textAnchor="middle"
                                style={{ fontSize: size }}
                            >
                                {camText}
                            </text>
                        </g>
                    );
                })}
            </svg>

            {open && !locked && (
                <PlacePicker
                    title={open.name}
                    cameras={cameras}
                    bindings={bindings}
                    placeKey={open.key}
                    onPick={id => {
                        onAssign(open.key, id);
                        setOpenKey(null);
                    }}
                />
            )}

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
