import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../../app/Icons';
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

// Ширина пикера .pick: зажим позиции в границы схемы
const PICKER_W = 230;

export function PlanView({ geometry, bindings, cameras, locked, onAssign }: PlanViewProps) {
    // Пикер открывается у точки клика, а не по центру сцены
    const [openAt, setOpenAt] = useState<{ key: string; x: number; y: number } | null>(null);
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!openAt) return;
        const onOutside = (e: MouseEvent) => {
            if (!hostRef.current?.contains(e.target as Node)) setOpenAt(null);
        };
        const onEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpenAt(null);
        };
        document.addEventListener('mousedown', onOutside);
        document.addEventListener('keydown', onEsc);
        return () => {
            document.removeEventListener('mousedown', onOutside);
            document.removeEventListener('keydown', onEsc);
        };
    }, [openAt]);

    useEffect(() => {
        if (locked) setOpenAt(null);
    }, [locked]);

    /** Точка клика в координатах контейнера, зажатая так, чтобы пикер поместился. */
    const pickerPos = (clientX: number, clientY: number) => {
        const host = hostRef.current?.getBoundingClientRect();
        if (!host) return { x: 8, y: 8 };
        const x = Math.max(8, Math.min(clientX - host.left, host.width - PICKER_W - 8));
        const y = Math.max(8, Math.min(clientY - host.top, host.height - 280));
        return { x, y };
    };

    const togglePicker = (key: string, clientX?: number, clientY?: number) => {
        setOpenAt(prev => {
            if (prev?.key === key) return null;
            // Клавиатура координат не даёт — пикер встаёт по центру
            const host = hostRef.current?.getBoundingClientRect();
            const pos = clientX !== undefined && clientY !== undefined
                ? pickerPos(clientX, clientY)
                : { x: ((host?.width ?? 0) - PICKER_W) / 2, y: (host?.height ?? 0) * 0.3 };
            return { key, ...pos };
        });
    };

    const nameOf = (id: string) => cameras.find(c => c.id === id)?.display_name ?? id;
    const open = geometry.tiles.find(t => t.key === openAt?.key) ?? null;

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
                viewBox={`0 0 ${geometry.view.width} ${geometry.view.height}`}
                preserveAspectRatio="xMidYMid meet"
                role="group"
                aria-label="Схема мест камер"
            >
                {geometry.machine && (
                    <g className="plan-machine-group">
                        <rect
                            className="plan-machine"
                            x={geometry.machine.x}
                            y={geometry.machine.y}
                            width={geometry.machine.w}
                            height={geometry.machine.h}
                            rx={Math.min(geometry.machine.w, geometry.machine.h) * 0.04}
                            fill="rgba(232,163,61,0.08)"
                            stroke="#E8A33D"
                            strokeDasharray="8 5"
                            strokeWidth={Math.max(geometry.view.width, geometry.view.height) * 0.003}
                        />
                        <text
                            x={geometry.machine.x + geometry.machine.w / 2}
                            y={geometry.machine.y + geometry.machine.h / 2}
                            textAnchor="middle"
                            fill="#E8A33D"
                            style={{ fontSize: fit('МАШИНА', geometry.machine, label * 0.8) }}
                        >
                            МАШИНА
                        </text>
                    </g>
                )}

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
                    // Подпись в центре тяжести трапеции: центр ректа после
                    // срезов по швам может уехать к соседу
                    const cx = t.center.x;
                    const cy = t.center.y;

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
                                (openAt?.key === t.key ? ' active' : '') +
                                (locked ? ' locked' : '')
                            }
                            tabIndex={locked ? -1 : 0}
                            role="button"
                            aria-label={`Место ${t.name}`}
                            onClick={e => !locked && togglePicker(t.key, e.clientX, e.clientY)}
                            onKeyDown={e => {
                                if (locked) return;
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    togglePicker(t.key);
                                }
                            }}
                        >
                            <polygon
                                className="plan-place-shape"
                                points={t.poly.map(p => `${p.x},${p.y}`).join(' ')}
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

                {/* Значки камер как в конфигураторе: декорация, клик проходит сквозь */}
                {geometry.icons.map(ic => {
                    const s = Math.max(geometry.view.width, geometry.view.height);
                    const bodyL = s * 0.02;
                    const bodyH = s * 0.017;
                    const lensL = s * 0.006;
                    const lensH = s * 0.011;
                    const fov = s * 0.034;

                    return (
                        <g
                            key={`ico-${ic.key}`}
                            className="plan-cam-icon"
                            transform={`translate(${ic.x} ${ic.y}) rotate(${ic.angleDeg})`}
                            pointerEvents="none"
                        >
                            <line
                                className="plan-cam-ray"
                                strokeWidth={s * 0.0012}
                                x1={lensL}
                                y1={0}
                                x2={lensL + 0.906 * fov}
                                y2={-0.423 * fov}
                            />
                            <line
                                className="plan-cam-ray"
                                strokeWidth={s * 0.0012}
                                x1={lensL}
                                y1={0}
                                x2={lensL + 0.906 * fov}
                                y2={0.423 * fov}
                            />
                            <rect
                                className="plan-cam-body"
                                strokeWidth={s * 0.0015}
                                x={-bodyL}
                                y={-bodyH / 2}
                                width={bodyL}
                                height={bodyH}
                            />
                            <rect
                                className="plan-cam-lens"
                                strokeWidth={s * 0.001}
                                x={0}
                                y={-lensH / 2}
                                width={lensL}
                                height={lensH}
                            />
                        </g>
                    );
                })}
            </svg>

            {open && openAt && !locked && (
                <PlacePicker
                    title={open.name}
                    cameras={cameras}
                    bindings={bindings}
                    placeKey={open.key}
                    position={{ left: openAt.x, top: openAt.y }}
                    onPick={id => {
                        onAssign(open.key, id);
                        setOpenAt(null);
                    }}
                />
            )}

            {locked && (
                <div className="plan-lock">
                    <Icon name="lock" />
                    Остановите вывод, чтобы изменить привязки
                </div>
            )}
        </div>
    );
}

interface PlacePickerProps {
    title: string;
    placeKey: string;
    cameras: LinkerCamera[];
    bindings: LinkerBindings;
    /** Точка клика в координатах контейнера, уже зажатая в его границы. */
    position: { left: number; top: number };
    onPick: (cameraId: string | null) => void;
}

/** Список камер для места. Выпадает у точки клика по месту. */
function PlacePicker({ title, placeKey, cameras, bindings, position, onPick }: PlacePickerProps) {
    const takenBy = (id: string) =>
        Object.entries(bindings).find(([key, cam]) => cam === id && key !== placeKey)?.[0];

    return (
        <div className="card pick" role="menu" style={position} onClick={e => e.stopPropagation()}>
            <div className="pick-h eyebrow">{title}</div>

            {cameras.length === 0 ? (
                <div className="empty">Нет камер</div>
            ) : (
                cameras.map(c => {
                    const taken = takenBy(c.id);
                    return (
                        <button
                            key={c.id}
                            type="button"
                            className={`row-item${taken ? ' is-taken' : ''}`}
                            onClick={() => onPick(c.id)}
                        >
                            <span className="nm">{c.display_name}</span>
                            <span className="num">{taken ? 'занята' : c.id}</span>
                        </button>
                    );
                })
            )}

            {bindings[placeKey] && (
                <button
                    type="button"
                    className="row-item is-clear"
                    onClick={() => onPick(null)}
                >
                    <span className="nm">Снять камеру</span>
                </button>
            )}
        </div>
    );
}
