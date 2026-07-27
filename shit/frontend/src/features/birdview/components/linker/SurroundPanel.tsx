import { useCallback, useEffect, useRef, useState } from 'react';
import { linkerApi } from '../../api/linker';
import type {
    SurroundCameraPose,
    SurroundConfig,
    SurroundModelFile,
    SurroundPatch,
} from '../../api/linker';

/**
 * Настройки объёмного вида, разложенные по вкладкам колонки «Параметры
 * вывода»: stream — кадр и орбита, scene — габарит, подложка и чаша,
 * model — библиотека .glb и её параметры, cameras — позы мест.
 *
 * Значения приходят из живой печки ручкой GET /linker/surround, правки уходят
 * частичным мёржем POST /linker/surround и применяются сервером в эфире без
 * переподключения. Поля и тумблеры шлют изменение сразу, слайдеры — по
 * отпусканию. Позы камер после тяжёлых правок перечитываются с задержкой:
 * перепечка выполняется в цикле кадра, и свежие высоты появляются не мгновенно.
 */

const REFRESH_AFTER_BAKE_MS = 800;

// 'images' живёт только у top-панели, surround её не получает
export type SurroundTab = 'stream' | 'scene' | 'model' | 'cameras' | 'images';

/** Полная поза, которую ждёт ручка оверрайда. */
interface PosePayload {
    position: [number, number, number];
    yaw: number;
    pitch: number;
    roll: number;
}

interface SurroundPanelProps {
    /** Вывод этой конфигурации в эфире в объёмном режиме. */
    live: boolean;
    exportId: string | null;
    /** Какая вкладка колонки открыта. */
    tab: SurroundTab;
    /** Имена мест из конфигурации, по ключу. */
    placeNames: Record<string, string>;
    onError: (title: string, e: unknown) => void;
    /** Перезапуск вывода с новым разрешением: стоп, запись, старт делает экран. */
    onApplyResolution: (res: { width: number; height: number }) => Promise<boolean>;
}

/** Компактное числовое поле с фиксацией по blur или Enter. */
export function Num({
    label,
    value,
    step,
    placeholder,
    onCommit,
    onInput,
}: {
    label: string;
    value: number | null;
    step?: number;
    placeholder?: string;
    onCommit: (value: number) => void;
    /** Каждое нажатие клавиши: кнопкам применения видно ввод до blur. */
    onInput?: (value: number) => void;
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
                onChange={e => {
                    setDraft(e.target.value);
                    if (onInput) {
                        const parsed = Number(e.target.value);
                        if (Number.isFinite(parsed)) onInput(parsed);
                    }
                }}
                onBlur={commit}
                // Колесо меняло значение под курсором и мешало ввести своё
                onWheel={e => e.currentTarget.blur()}
                onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                }}
            />
        </label>
    );
}

/** Кламп стороны кадра: диапазон кодека и кратность 16. */
export function clampSide(v: number, hi: number): number {
    return Math.min(hi, Math.max(256, Math.round(v / 16) * 16));
}

/** Слайдер: значение видно при перетаскивании, уходит только по отпусканию. */
export function Range({
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

/** Слайдер угла в ряду кнопок: значение видно, уходит по отпусканию. */
export function RotSlider({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
    const [drag, setDrag] = useState<number | null>(null);
    const shown = drag ?? value;

    const commit = () => {
        if (drag !== null && drag !== value) onCommit(drag);
        setDrag(null);
    };

    return (
        <>
            <input
                type="range"
                min={0}
                max={360}
                step={5}
                value={shown}
                onChange={e => setDrag(Number(e.target.value))}
                onPointerUp={commit}
                onBlur={commit}
            />
            <span className="srd-rot-val">{Math.round(shown)}°</span>
        </>
    );
}

export function Toggle({
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

/** Заголовок группы внутри вкладки. */
export function Subhead({ children }: { children: React.ReactNode }) {
    return <div className="srd-subhead">{children}</div>;
}

/**
 * Строка поля позы: подпись, текущее значение и откат к PnP сверху,
 * контрол на всю ширину снизу. Откат жив, только когда значение отличается
 * от расчётного — тогда он красный, а значение подсвечено акцентом.
 */
function PoseRow({
    label,
    shown,
    changed,
    onReset,
    children,
}: {
    label: string;
    shown: string;
    changed: boolean;
    onReset: () => void;
    children: React.ReactNode;
}) {
    return (
        <div className="srd-pose">
            <div className="srd-pose-head">
                <span className="srd-num-label">{label}</span>
                <span className={`srd-pose-val${changed ? ' changed' : ''}`}>{shown}</span>
                <button
                    type="button"
                    className={`srd-pose-reset${changed ? ' active' : ''}`}
                    disabled={!changed}
                    title="Откатить поле к PnP"
                    onClick={onReset}
                >
                    ↺
                </button>
            </div>
            {children}
        </div>
    );
}

/** Позиция: ручной ввод плюс степпер с крупными кнопками по краям. */
function PoseStepper({
    label,
    value,
    base,
    step,
    onCommit,
}: {
    label: string;
    value: number;
    /** Расчётное PnP-значение — база отката. */
    base: number;
    step: number;
    onCommit: (value: number) => void;
}) {
    const [draft, setDraft] = useState(value.toFixed(3));

    useEffect(() => {
        setDraft(value.toFixed(3));
    }, [value]);

    const changed = Math.abs(value - base) > 1e-6;

    const commitDraft = () => {
        const parsed = Number(draft);
        if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
        else setDraft(value.toFixed(3));
    };

    return (
        <PoseRow label={label} shown={value.toFixed(3)} changed={changed}
            onReset={() => onCommit(base)}>
            <div className="srd-stepper">
                <button type="button" onClick={() => onCommit(+(value - step).toFixed(4))}>−</button>
                <input
                    type="number"
                    step={step}
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={commitDraft}
                    onWheel={e => e.currentTarget.blur()}
                    onKeyDown={e => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                />
                <button type="button" onClick={() => onCommit(+(value + step).toFixed(4))}>+</button>
            </div>
        </PoseRow>
    );
}

/** Угол: слайдер во всю строку, уходит по отпусканию. */
function PoseSlider({
    label,
    value,
    base,
    min,
    max,
    onCommit,
}: {
    label: string;
    value: number;
    base: number;
    min: number;
    max: number;
    onCommit: (value: number) => void;
}) {
    const [drag, setDrag] = useState<number | null>(null);
    const shown = drag ?? value;
    const changed = Math.abs(value - base) > 1e-6;

    const commit = () => {
        if (drag !== null && drag !== value) onCommit(drag);
        setDrag(null);
    };

    return (
        <PoseRow label={label} shown={`${shown.toFixed(1)}°`} changed={changed}
            onReset={() => onCommit(base)}>
            <input
                type="range"
                min={min}
                max={max}
                step={0.5}
                value={shown}
                onChange={e => setDrag(Number(e.target.value))}
                onPointerUp={commit}
                onBlur={commit}
            />
            <div className="srd-ticks">
                <span>{min}°</span>
                <span>0°</span>
                <span>{max}°</span>
            </div>
        </PoseRow>
    );
}

export function SurroundPanel({
    live,
    exportId,
    tab,
    placeNames,
    onError,
    onApplyResolution,
}: SurroundPanelProps) {
    const [cfg, setCfg] = useState<SurroundConfig | null>(null);
    const [place, setPlace] = useState<string | null>(null);
    const refreshTimer = useRef<number>(0);
    const modelFileRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    // Свободный угол включается сам, если сохранённый не кратен 90
    const [freeAngle, setFreeAngle] = useState(false);
    const [models, setModels] = useState<SurroundModelFile[]>([]);
    // Черновик разрешения: уходит кнопкой, поле само держит кратность 16
    const [resDraft, setResDraft] = useState<{ width: number; height: number } | null>(null);
    const [resApplying, setResApplying] = useState(false);
    // Живая отправка позы с дебаунсом: щелчки степпера склеиваются в один POST
    const poseTimer = useRef<number>(0);
    const posePendingRef = useRef<{ placeKey: string; pose: PosePayload } | null>(null);

    const refetchModels = useCallback(() => {
        linkerApi.listModels().then(setModels).catch(() => setModels([]));
    }, []);

    const refetch = useCallback(async () => {
        if (!exportId) return;
        try {
            setCfg(await linkerApi.getSurround(exportId));
        } catch (e) {
            onError('Не удалось прочитать настройки объёма', e);
        }
    }, [exportId, onError]);

    useEffect(() => {
        if (live) {
            void refetch();
            refetchModels();
        }
        else setCfg(null);
        return () => window.clearTimeout(refreshTimer.current);
    }, [live, refetch, refetchModels]);

    // Сохранённый угол не кратен 90 - панель открывается в свободном режиме
    useEffect(() => {
        if (cfg && cfg.model.rotation % 90 !== 0) setFreeAngle(true);
    }, [cfg]);

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
                ...(patch.plate_length !== undefined ? { plateLength: patch.plate_length } : {}),
                ...(patch.plate_width !== undefined ? { plateWidth: patch.plate_width } : {}),
                ...(patch.resolution ? { resolution: patch.resolution } : {}),
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

    // Отправка накопленной позы немедленно: смена места не должна её терять
    const flushPose = useCallback(() => {
        window.clearTimeout(poseTimer.current);
        const p = posePendingRef.current;
        posePendingRef.current = null;
        if (!p || !exportId) return;
        linkerApi
            .setSurroundCamera(p.placeKey, p.pose, exportId)
            .then(scheduleRefetch)
            .catch(e => {
                onError('Поза не применена', e);
                void refetch();
            });
    }, [exportId, scheduleRefetch, refetch, onError]);

    /**
     * Живое применение позы: значение сразу видно в форме и уходит на сервер
     * одним POST после паузы в 300 мс — щелчки степпера склеиваются, каждая
     * отправка перепекается в цикле кадра.
     */
    const sendPose = useCallback(
        (placeKey: string, pose: PosePayload) => {
            if (!exportId) return;
            setCfg(prev => prev
                ? {
                    ...prev,
                    cameras: prev.cameras.map(c => c.placeKey === placeKey
                        ? { ...c, ...pose, source: 'manual' as const }
                        : c),
                }
                : prev);

            if (posePendingRef.current && posePendingRef.current.placeKey !== placeKey) {
                flushPose();
            }
            posePendingRef.current = { placeKey, pose };
            window.clearTimeout(poseTimer.current);
            poseTimer.current = window.setTimeout(flushPose, 300);
        },
        [exportId, flushPose],
    );

    useEffect(() => {
        return () => window.clearTimeout(poseTimer.current);
    }, []);

    const resetPose = useCallback(
        (pose: SurroundCameraPose) => {
            if (!exportId) return;
            posePendingRef.current = null;
            window.clearTimeout(poseTimer.current);
            linkerApi
                .setSurroundCamera(pose.placeKey, { reset: true }, exportId)
                .then(scheduleRefetch)
                .catch(e => onError('Сброс не применён', e));
        },
        [exportId, scheduleRefetch, onError],
    );

    // Загрузка в библиотеку и привязка к конфигурации одним действием
    const uploadModel = useCallback(
        async (file: File) => {
            if (!exportId) return;
            setUploading(true);
            try {
                const name = await linkerApi.uploadModel(file);
                await linkerApi.postSurround({ model: { source: name } }, exportId);
                setCfg(prev =>
                    prev ? { ...prev, model: { ...prev.model, source: name } } : prev,
                );
                refetchModels();
            } catch (e) {
                onError('Модель не загружена', e);
            } finally {
                setUploading(false);
            }
        },
        [exportId, onError, refetchModels],
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

    const m = cfg.machine;
    const selectedPose =
        cfg.cameras.find(c => c.placeKey === place) ?? cfg.cameras[0] ?? null;

    if (tab === 'stream') {
        const res = resDraft ?? cfg.resolution;
        const resDirty = res.width !== cfg.resolution.width
            || res.height !== cfg.resolution.height;
        return (
            <div className="srd-panel">
                <Subhead>Кадр</Subhead>
                {/* Кратность 16 обязательна для кодека: поле выравнивает по
                    blur, отправка страхуется ещё раз. Кнопка видит каждый ввод */}
                <div className="srd-row">
                    <Num label="Ширина" value={res.width} step={16}
                        onInput={v => setResDraft({ width: v, height: res.height })}
                        onCommit={v => setResDraft({
                            width: clampSide(v, 3840), height: res.height,
                        })} />
                    <Num label="Высота" value={res.height} step={16}
                        onInput={v => setResDraft({ width: res.width, height: v })}
                        onCommit={v => setResDraft({
                            width: res.width, height: clampSide(v, 2160),
                        })} />
                </div>
                <button
                    type="button"
                    className="srd-apply"
                    disabled={!resDirty || resApplying}
                    onClick={() => {
                        const norm = {
                            width: clampSide(res.width, 3840),
                            height: clampSide(res.height, 2160),
                        };
                        setResDraft(norm);
                        setResApplying(true);
                        void onApplyResolution(norm)
                            .then(ok => {
                                if (!ok) return;
                                // Статус-поллинг во время рестарта молчит, live не
                                // мигает - без явного обновления cfg покажет старое
                                setCfg(prev =>
                                    prev ? { ...prev, resolution: norm } : prev,
                                );
                                setResDraft(null);
                                void refetch();
                            })
                            .finally(() => setResApplying(false));
                    }}
                >
                    {resApplying ? 'Перезапуск вывода…' : 'Применить · перезапуск вывода'}
                </button>

                <Subhead>Орбита</Subhead>
                <Range label="Дистанция" value={cfg.orbit.distance} min={1} max={8} step={0.1}
                    onCommit={v => apply({ orbit: { distance: v } })} />
                <Range label="Высота" value={cfg.orbit.height} min={0.2} max={5} step={0.1}
                    onCommit={v => apply({ orbit: { height: v } })} />
                <Range label="Скорость облёта" value={cfg.orbit.speed} min={0} max={1} step={0.05}
                    onCommit={v => apply({ orbit: { speed: v } })} />
                {/* Действует сразу на живой вывод, кнопка плеера может перебить */}
                <Toggle label="Ручное вращение на отображении" on={cfg.orbit.interactive}
                    onChange={v => apply({ orbit: { interactive: v } })} />
            </div>
        );
    }

    if (tab === 'scene') {
        return (
            <div className="srd-panel">
                <Subhead>Габарит, м</Subhead>
                <div className="srd-row">
                    <Num label="Длина" value={m.length}
                        onCommit={v => v > 0 && apply({ machine: { length: v } }, true)} />
                    <Num label="Ширина" value={m.width}
                        onCommit={v => v > 0 && apply({ machine: { width: v } }, true)} />
                    <Num label="Высота" value={m.height}
                        onCommit={v => v > 0 && apply({ machine: { height: v } }, true)} />
                </div>

                <Subhead>Подложка</Subhead>
                <Toggle label="Показывать подложку" on={cfg.plate}
                    onChange={v => apply({ plate: v })} />
                {/* Пусто или 0 — размер от габарита на фактор чаши */}
                {cfg.plate && (
                    <div className="srd-row">
                        <Num label="Длина" value={cfg.plateLength || null}
                            placeholder="авто"
                            onCommit={v => apply({ plate_length: Math.max(0, v) })} />
                        <Num label="Ширина" value={cfg.plateWidth || null}
                            placeholder="авто"
                            onCommit={v => apply({ plate_width: Math.max(0, v) })} />
                    </div>
                )}

                <Subhead>Чаша</Subhead>
                <Range label="Стенка (высота)" value={cfg.bowl.wall} min={0.1} max={6} step={0.05}
                    onCommit={v => apply({ bowl: { wall: v } }, true)} />
                {/* Дно сдвигает начало стенки, её вынос от дна не зависит */}
                <Range label="Дно (до загиба)" value={cfg.bowl.floor} min={0.1} max={6} step={0.05}
                    onCommit={v => apply({ bowl: { floor: v } }, true)} />
                <Range label="Стенка (вынос)" value={cfg.bowl.outer} min={0} max={6} step={0.05}
                    fmt={v => (v === 0 ? 'вертикаль' : v.toFixed(2))}
                    onCommit={v => apply({ bowl: { outer: v } }, true)} />
                <Range label="Скругление углов" value={cfg.bowl.corner} min={0} max={4} step={0.05}
                    fmt={v => (v === 0 ? 'прямые' : v.toFixed(2))}
                    onCommit={v => apply({ bowl: { corner: v } }, true)} />
                <Range label="Ширина шва" value={cfg.bowl.blend} min={0.05} max={1} step={0.05}
                    onCommit={v => apply({ bowl: { blend: v } }, true)} />
                <Toggle label="Фотонормализация" on={cfg.photometric}
                    onChange={v => apply({ photometric: v })} />
                <Toggle label="Сетка без кадров" on={cfg.wireframe}
                    onChange={v => apply({ wireframe: v })} />
            </div>
        );
    }

    if (tab === 'model') {
        const known = models.some(mf => mf.name === cfg.model.source);
        return (
            <div className="srd-panel">
                <Subhead>Библиотека</Subhead>
                <label className="srd-num">
                    <span className="srd-num-label">Модель</span>
                    <select
                        className="field-input"
                        value={known ? cfg.model.source : ''}
                        disabled={models.length === 0}
                        onChange={e => {
                            if (e.target.value) apply({ model: { source: e.target.value } });
                        }}
                    >
                        {models.length === 0 ? (
                            <option value="">Ничего не найдено — загрузите .glb</option>
                        ) : (
                            <>
                                <option value="">— выберите модель —</option>
                                {models.map(mf => (
                                    <option key={mf.name} value={mf.name}>
                                        {mf.name} · {(mf.size / 1024 / 1024).toFixed(1)} МБ
                                    </option>
                                ))}
                            </>
                        )}
                    </select>
                </label>
                <div className="srd-model-file">
                    <button
                        type="button"
                        className="srd-reset"
                        disabled={uploading}
                        onClick={() => modelFileRef.current?.click()}
                    >
                        {uploading ? 'Загрузка…' : '⬆ Загрузить .glb'}
                    </button>
                    {cfg.model.source && (
                        <button
                            type="button"
                            className="srd-reset"
                            onClick={() => apply({ model: { source: '' } })}
                        >
                            ✕ Убрать модель
                        </button>
                    )}
                </div>
                <input
                    ref={modelFileRef}
                    type="file"
                    accept=".glb"
                    style={{ display: 'none' }}
                    onChange={e => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void uploadModel(file);
                    }}
                />

                <Subhead>Поворот</Subhead>
                {/* Пятая кнопка включает свободный угол: слайдер встаёт на место кнопок */}
                <div className="srd-rotrow">
                    {freeAngle ? (
                        <RotSlider
                            value={cfg.model.rotation}
                            onCommit={v => apply({ model: { rotation: v } })}
                        />
                    ) : (
                        [0, 90, 180, 270].map(deg => (
                            <button
                                key={deg}
                                type="button"
                                className="srd-chip"
                                aria-pressed={cfg.model.rotation === deg}
                                onClick={() => apply({ model: { rotation: deg } })}
                            >
                                {deg}°
                            </button>
                        ))
                    )}
                    <button
                        type="button"
                        className="srd-chip srd-chip-fixed"
                        aria-pressed={freeAngle}
                        title="Свободный угол"
                        onClick={() => setFreeAngle(!freeAngle)}
                    >
                        ∠
                    </button>
                </div>

                <Subhead>Размеры, м (пусто — габарит)</Subhead>
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
            </div>
        );
    }

    // tab === 'cameras'
    // Шаг степпера от габарита: у стенда миллиметры, у машины сантиметры
    const minSide = Math.min(m.length || 0, m.width || 0);
    const posStep = minSide > 0
        ? Math.min(0.05, Math.max(0.005, Math.round(minSide / 50 / 0.005) * 0.005))
        : 0.01;

    const p = selectedPose;

    return (
        <div className="srd-panel">
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
                                aria-pressed={p?.placeKey === c.placeKey}
                                onClick={() => setPlace(c.placeKey)}
                            >
                                {placeNames[c.placeKey] || c.placeKey}
                            </button>
                        ))}
                    </div>
                    {p && (
                        <>
                            <div className="srd-pnp">
                                {p.source === 'manual' ? 'ручная поза' : 'PnP'}
                                {' · h='}
                                {p.height.toFixed(3)} м
                                {` · ${p.reprojectionError.toFixed(1)} px`}
                            </div>

                            <Subhead>Позиция, м</Subhead>
                            <PoseStepper label="X" value={p.position[0]}
                                base={p.pnp.position[0]} step={posStep}
                                onCommit={v => sendPose(p.placeKey, {
                                    position: [v, p.position[1], p.position[2]],
                                    yaw: p.yaw, pitch: p.pitch, roll: p.roll,
                                })} />
                            <PoseStepper label="Y (высота)" value={p.position[1]}
                                base={p.pnp.position[1]} step={posStep}
                                onCommit={v => sendPose(p.placeKey, {
                                    position: [p.position[0], v, p.position[2]],
                                    yaw: p.yaw, pitch: p.pitch, roll: p.roll,
                                })} />
                            <PoseStepper label="Z" value={p.position[2]}
                                base={p.pnp.position[2]} step={posStep}
                                onCommit={v => sendPose(p.placeKey, {
                                    position: [p.position[0], p.position[1], v],
                                    yaw: p.yaw, pitch: p.pitch, roll: p.roll,
                                })} />

                            <Subhead>Углы, °</Subhead>
                            <PoseSlider label="Yaw" value={p.yaw} base={p.pnp.yaw}
                                min={-180} max={180}
                                onCommit={v => sendPose(p.placeKey, {
                                    position: [...p.position] as [number, number, number],
                                    yaw: v, pitch: p.pitch, roll: p.roll,
                                })} />
                            <PoseSlider label="Pitch" value={p.pitch} base={p.pnp.pitch}
                                min={-90} max={90}
                                onCommit={v => sendPose(p.placeKey, {
                                    position: [...p.position] as [number, number, number],
                                    yaw: p.yaw, pitch: v, roll: p.roll,
                                })} />
                            <PoseSlider label="Roll" value={p.roll} base={p.pnp.roll}
                                min={-180} max={180}
                                onCommit={v => sendPose(p.placeKey, {
                                    position: [...p.position] as [number, number, number],
                                    yaw: p.yaw, pitch: p.pitch, roll: v,
                                })} />

                            <button
                                type="button"
                                className="srd-reset"
                                disabled={p.source !== 'manual'}
                                onClick={() => resetPose(p)}
                            >
                                ↺ Сбросить камеру к PnP
                            </button>
                        </>
                    )}
                </>
            )}
        </div>
    );
}
