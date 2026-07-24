import { useCallback, useEffect, useRef, useState } from 'react';
import { linkerApi } from '../../api/linker';
import type { SurroundCameraPose, SurroundConfig, SurroundPatch } from '../../api/linker';

/**
 * Настройки объёмного вида: аккордеоны в колонке «Параметры вывода».
 *
 * Значения приходят из живой печки ручкой GET /linker/surround, правки уходят
 * частичным мёржем POST /linker/surround и применяются сервером в эфире без
 * переподключения. Поля и тумблеры шлют изменение сразу, слайдеры — по
 * отпусканию. Позы камер после тяжёлых правок перечитываются с задержкой:
 * перепечка выполняется в цикле кадра, и свежие высоты появляются не мгновенно.
 */

const REFRESH_AFTER_BAKE_MS = 800;

interface SurroundPanelProps {
    /** Вывод этой конфигурации в эфире в объёмном режиме. */
    live: boolean;
    exportId: string | null;
    /** Имена мест из конфигурации, по ключу. */
    placeNames: Record<string, string>;
    onError: (title: string, e: unknown) => void;
}

/** Компактное числовое поле с фиксацией по blur или Enter. */
function Num({
    label,
    value,
    step,
    placeholder,
    onCommit,
}: {
    label: string;
    value: number | null;
    step?: number;
    placeholder?: string;
    onCommit: (value: number) => void;
}) {
    const [draft, setDraft] = useState(value === null ? '' : String(value));

    useEffect(() => {
        setDraft(value === null ? '' : String(value));
    }, [value]);

    const commit = () => {
        if (draft.trim() === '' && value === null) return;
        const parsed = Number(draft);
        if (Number.isFinite(parsed)) onCommit(parsed);
        else setDraft(value === null ? '' : String(value));
    };

    return (
        <label className="srd-num">
            <span className="srd-num-label">{label}</span>
            <input
                className="field-input"
                type="number"
                step={step ?? 0.01}
                value={draft}
                placeholder={placeholder}
                onChange={e => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                }}
            />
        </label>
    );
}

/** Слайдер: значение видно при перетаскивании, уходит только по отпусканию. */
function Range({
    label,
    value,
    min,
    max,
    step,
    fmt,
    onCommit,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    fmt?: (v: number) => string;
    onCommit: (value: number) => void;
}) {
    const [drag, setDrag] = useState<number | null>(null);
    const shown = drag ?? value;

    const commit = () => {
        if (drag !== null && drag !== value) onCommit(drag);
        setDrag(null);
    };

    return (
        <div className="srd-range">
            <div className="srd-range-head">
                <span>{label}</span>
                <span className="srd-range-val">{fmt ? fmt(shown) : shown.toFixed(2)}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={shown}
                onChange={e => setDrag(Number(e.target.value))}
                onPointerUp={commit}
                onBlur={commit}
            />
        </div>
    );
}

function Toggle({
    label,
    on,
    onChange,
}: {
    label: string;
    on: boolean;
    onChange: (on: boolean) => void;
}) {
    return (
        <button
            type="button"
            className="srd-toggle"
            aria-pressed={on}
            onClick={() => onChange(!on)}
        >
            <span className="srd-toggle-track" aria-hidden="true">
                <span className="srd-toggle-knob" />
            </span>
            <span>{label}</span>
        </button>
    );
}

function Section({
    title,
    summary,
    open,
    onToggle,
    children,
}: {
    title: string;
    summary: string;
    open: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}) {
    return (
        <div className="srd-sec">
            <button type="button" className="srd-head" onClick={onToggle}>
                <span className="srd-car">{open ? '▼' : '▶'}</span>
                <span>{title}</span>
                <span className="srd-sum">{summary}</span>
            </button>
            {open && <div className="srd-body">{children}</div>}
        </div>
    );
}

export function SurroundPanel({ live, exportId, placeNames, onError }: SurroundPanelProps) {
    const [cfg, setCfg] = useState<SurroundConfig | null>(null);
    const [open, setOpen] = useState<Record<string, boolean>>({ machine: true });
    const [place, setPlace] = useState<string | null>(null);
    const refreshTimer = useRef<number>(0);

    const refetch = useCallback(async () => {
        if (!exportId) return;
        try {
            setCfg(await linkerApi.getSurround(exportId));
        } catch (e) {
            onError('Не удалось прочитать настройки объёма', e);
        }
    }, [exportId, onError]);

    useEffect(() => {
        if (live) void refetch();
        else setCfg(null);
        return () => window.clearTimeout(refreshTimer.current);
    }, [live, refetch]);

    // Перепечка идёт в цикле кадра: свежие позы забираются с задержкой
    const scheduleRefetch = useCallback(() => {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => void refetch(), REFRESH_AFTER_BAKE_MS);
    }, [refetch]);

    const apply = useCallback(
        (patch: SurroundPatch, rebake = false) => {
            if (!cfg || !exportId) return;
            // Оптимистичное применение: при отказе сервера значения перечитываются
            setCfg({
                ...cfg,
                ...(patch.machine ? { machine: { ...cfg.machine, ...patch.machine } } : {}),
                ...(patch.bowl ? { bowl: { ...cfg.bowl, ...patch.bowl } } : {}),
                ...(patch.orbit ? { orbit: { ...cfg.orbit, ...patch.orbit } } : {}),
                ...(patch.model ? { model: { ...cfg.model, ...patch.model } } : {}),
                ...(patch.plate !== undefined ? { plate: patch.plate } : {}),
                ...(patch.wireframe !== undefined ? { wireframe: patch.wireframe } : {}),
                ...(patch.photometric !== undefined ? { photometric: patch.photometric } : {}),
            });
            linkerApi
                .postSurround(patch, exportId)
                .then(() => {
                    if (rebake) scheduleRefetch();
                })
                .catch(e => {
                    onError('Настройка не применена', e);
                    void refetch();
                });
        },
        [cfg, exportId, scheduleRefetch, refetch, onError],
    );

    const applyPose = useCallback(
        (pose: SurroundCameraPose, patch: Partial<SurroundCameraPose>) => {
            if (!exportId) return;
            const next = { ...pose, ...patch };
            setCfg(prev =>
                prev
                    ? {
                          ...prev,
                          cameras: prev.cameras.map(c =>
                              c.placeKey === pose.placeKey ? { ...next, source: 'manual' } : c,
                          ),
                      }
                    : prev,
            );
            linkerApi
                .setSurroundCamera(
                    pose.placeKey,
                    { position: next.position, yaw: next.yaw, pitch: next.pitch, roll: next.roll },
                    exportId,
                )
                .then(scheduleRefetch)
                .catch(e => {
                    onError('Поза не применена', e);
                    void refetch();
                });
        },
        [exportId, scheduleRefetch, refetch, onError],
    );

    const resetPose = useCallback(
        (pose: SurroundCameraPose) => {
            if (!exportId) return;
            linkerApi
                .setSurroundCamera(pose.placeKey, { reset: true }, exportId)
                .then(scheduleRefetch)
                .catch(e => onError('Сброс не применён', e));
        },
        [exportId, scheduleRefetch, onError],
    );

    if (!live) {
        return (
            <div className="srd-hint">
                Настройки объёма доступны, когда вывод этой конфигурации в эфире
            </div>
        );
    }
    if (!cfg) {
        return <div className="srd-hint">Загрузка настроек…</div>;
    }

    const toggle = (key: string) => setOpen(o => ({ ...o, [key]: !o[key] }));
    const m = cfg.machine;
    const selectedPose =
        cfg.cameras.find(c => c.placeKey === place) ?? cfg.cameras[0] ?? null;

    return (
        <div className="srd-panel">
            <Section
                title="Габарит"
                summary={`${m.length.toFixed(2)}×${m.width.toFixed(2)}×${m.height.toFixed(2)} м`}
                open={Boolean(open.machine)}
                onToggle={() => toggle('machine')}
            >
                <div className="srd-row">
                    <Num label="Длина" value={m.length}
                        onCommit={v => v > 0 && apply({ machine: { length: v } }, true)} />
                    <Num label="Ширина" value={m.width}
                        onCommit={v => v > 0 && apply({ machine: { width: v } }, true)} />
                    <Num label="Высота" value={m.height}
                        onCommit={v => v > 0 && apply({ machine: { height: v } }, true)} />
                </div>
                <Toggle label="Подложка" on={cfg.plate} onChange={v => apply({ plate: v })} />
            </Section>

            <Section
                title="Чаша"
                summary={`стенка ${cfg.bowl.wall.toFixed(2)}`}
                open={Boolean(open.bowl)}
                onToggle={() => toggle('bowl')}
            >
                <Range label="Стенка (высота)" value={cfg.bowl.wall} min={0.1} max={3} step={0.05}
                    onCommit={v => apply({ bowl: { wall: v } }, true)} />
                <Range label="Дно (до загиба)" value={cfg.bowl.floor} min={0.1} max={3} step={0.05}
                    onCommit={v => apply({ bowl: { floor: Math.min(v, cfg.bowl.outer - 0.1) } }, true)} />
                <Range label="Край" value={cfg.bowl.outer} min={0.5} max={5} step={0.05}
                    onCommit={v => apply({ bowl: { outer: Math.max(v, cfg.bowl.floor + 0.1) } }, true)} />
                <Range label="Ширина шва" value={cfg.bowl.blend} min={0.05} max={1} step={0.05}
                    onCommit={v => apply({ bowl: { blend: v } }, true)} />
                <Toggle label="Фотонормализация" on={cfg.photometric}
                    onChange={v => apply({ photometric: v })} />
                <Toggle label="Сетка без кадров" on={cfg.wireframe}
                    onChange={v => apply({ wireframe: v })} />
            </Section>

            <Section
                title="Орбита"
                summary={`${cfg.orbit.distance.toFixed(1)} / ${cfg.orbit.height.toFixed(1)}`}
                open={Boolean(open.orbit)}
                onToggle={() => toggle('orbit')}
            >
                <Range label="Дистанция" value={cfg.orbit.distance} min={1} max={8} step={0.1}
                    onCommit={v => apply({ orbit: { distance: v } })} />
                <Range label="Высота" value={cfg.orbit.height} min={0.2} max={5} step={0.1}
                    onCommit={v => apply({ orbit: { height: v } })} />
                <Range label="Скорость облёта" value={cfg.orbit.speed} min={0} max={1} step={0.05}
                    onCommit={v => apply({ orbit: { speed: v } })} />
            </Section>

            <Section
                title="Модель"
                summary={
                    cfg.model.length || cfg.model.width || cfg.model.height
                        ? 'свои размеры'
                        : '= габарит'
                }
                open={Boolean(open.model)}
                onToggle={() => toggle('model')}
            >
                {/* Пусто или 0 — размер берётся из габарита */}
                <div className="srd-row">
                    <Num label="Длина" value={cfg.model.length || null}
                        placeholder={m.length.toFixed(2)}
                        onCommit={v => apply({ model: { length: Math.max(0, v) } })} />
                    <Num label="Ширина" value={cfg.model.width || null}
                        placeholder={m.width.toFixed(2)}
                        onCommit={v => apply({ model: { width: Math.max(0, v) } })} />
                    <Num label="Высота" value={cfg.model.height || null}
                        placeholder={m.height.toFixed(2)}
                        onCommit={v => apply({ model: { height: Math.max(0, v) } })} />
                </div>
                <Range label="Прозрачность" value={1 - cfg.model.alpha} min={0} max={1} step={0.05}
                    fmt={v => `${Math.round(v * 100)}%`}
                    onCommit={v => apply({ model: { alpha: Number((1 - v).toFixed(2)) } })} />
            </Section>

            <Section
                title="Камеры"
                summary={`${cfg.cameras.length}`}
                open={Boolean(open.cameras)}
                onToggle={() => toggle('cameras')}
            >
                {cfg.cameras.length === 0 ? (
                    <div className="srd-hint">Печка ещё не отдала позы камер</div>
                ) : (
                    <>
                        <div className="srd-chips">
                            {cfg.cameras.map(c => (
                                <button
                                    key={c.placeKey}
                                    type="button"
                                    className="srd-chip"
                                    aria-pressed={selectedPose?.placeKey === c.placeKey}
                                    onClick={() => setPlace(c.placeKey)}
                                >
                                    {placeNames[c.placeKey] || c.placeKey}
                                </button>
                            ))}
                        </div>
                        {selectedPose && (
                            <>
                                <div className="srd-pnp">
                                    {selectedPose.source === 'manual' ? 'ручная поза' : 'PnP'}
                                    {' · h='}
                                    {selectedPose.height.toFixed(3)} м
                                    {selectedPose.source === 'pnp' &&
                                        ` · ${selectedPose.reprojectionError.toFixed(1)} px`}
                                </div>
                                <div className="srd-row">
                                    <Num label="X, м" value={selectedPose.position[0]}
                                        onCommit={v => applyPose(selectedPose, {
                                            position: [v, selectedPose.position[1], selectedPose.position[2]],
                                        })} />
                                    <Num label="Y, м" value={selectedPose.position[1]}
                                        onCommit={v => applyPose(selectedPose, {
                                            position: [selectedPose.position[0], v, selectedPose.position[2]],
                                        })} />
                                    <Num label="Z, м" value={selectedPose.position[2]}
                                        onCommit={v => applyPose(selectedPose, {
                                            position: [selectedPose.position[0], selectedPose.position[1], v],
                                        })} />
                                </div>
                                <div className="srd-row">
                                    <Num label="Yaw, °" value={selectedPose.yaw} step={1}
                                        onCommit={v => applyPose(selectedPose, { yaw: v })} />
                                    <Num label="Pitch, °" value={selectedPose.pitch} step={1}
                                        onCommit={v => applyPose(selectedPose, { pitch: v })} />
                                    <Num label="Roll, °" value={selectedPose.roll} step={1}
                                        onCommit={v => applyPose(selectedPose, { roll: v })} />
                                </div>
                                <button
                                    type="button"
                                    className="srd-reset"
                                    disabled={selectedPose.source !== 'manual'}
                                    onClick={() => resetPose(selectedPose)}
                                >
                                    ↺ Сбросить к PnP
                                </button>
                            </>
                        )}
                    </>
                )}
            </Section>
        </div>
    );
}
