import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { Switch } from '../../../../app/Modal';
import { Select } from '../../../../app/Select';
import { linkerApi } from '../../api/linker';
import type {
    SurroundCameraPose,
    SurroundConfig,
    SurroundModelFile,
    SurroundPatch,
} from '../../api/linker';

// Настройки объёмного вида по вкладкам: stream — кадр и орбита, scene — габарит, подложка, чаша,
// model — библиотека .glb, cameras — позы мест. Значения из GET /linker/surround, правки — POST мёржем

const REFRESH_AFTER_BAKE_MS = 800;

// 'images' живёт только у top-панели, surround её не получает
export type SurroundTab = 'stream' | 'scene' | 'model' | 'cameras' | 'images';

// Полная поза для ручки оверрайда
interface PosePayload {
    position: [number, number, number];
    yaw: number;
    pitch: number;
    roll: number;
}

interface SurroundPanelProps {
    // Вывод этой конфигурации в эфире в объёмном режиме
    live: boolean;
    exportId: string | null;
    tab: SurroundTab;
    // Имена мест из конфигурации, по ключу
    placeNames: Record<string, string>;
    onError: (title: string, e: unknown) => void;
    // Перезапуск вывода с новым разрешением: стоп, запись, старт делает экран
    onApplyResolution: (res: { width: number; height: number }) => Promise<boolean>;
}

// Числовое поле .tf с фиксацией по blur или Enter
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
    // Каждое нажатие клавиши: кнопкам применения видно ввод до blur
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
        <label className="tf">
            <span className="tf-cap">{label}</span>
            <input
                className="tf-in"
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
                // Колесо меняло значение под курсором
                onWheel={e => e.currentTarget.blur()}
                onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                }}
            />
        </label>
    );
}

// Кламп стороны кадра: диапазон кодека и кратность 16
export function clampSide(v: number, hi: number): number {
    return Math.min(hi, Math.max(256, Math.round(v / 16) * 16));
}

// Слайдер .tf: значение видно при перетаскивании, уходит по отпусканию
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
        <div className="tf">
            <span className="tf-cap">{label}</span>
            <div className="tf-range">
                <input
                    className="rng"
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={shown}
                    onChange={e => setDrag(Number(e.target.value))}
                    onPointerUp={commit}
                    onBlur={commit}
                />
                <span className="val">{fmt ? fmt(shown) : shown.toFixed(2)}</span>
            </div>
        </div>
    );
}

// Слайдер угла в ряду .rot: занимает место чипов, уходит по отпусканию
export function RotSlider({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
    const [drag, setDrag] = useState<number | null>(null);
    const shown = drag ?? value;

    const commit = () => {
        if (drag !== null && drag !== value) onCommit(drag);
        setDrag(null);
    };

    return (
        <div className="tf-range">
            <input
                className="rng"
                type="range"
                min={0}
                max={360}
                step={5}
                value={shown}
                onChange={e => setDrag(Number(e.target.value))}
                onPointerUp={commit}
                onBlur={commit}
            />
            <span className="val">{Math.round(shown)}°</span>
        </div>
    );
}

// Заголовок группы внутри вкладки
export function Subhead({ children }: { children: React.ReactNode }) {
    return <div className="sub-h">{children}</div>;
}

// Селект модели из библиотеки .glb
export function ModelSelect({
    models,
    source,
    onPick,
}: {
    models: SurroundModelFile[];
    source: string;
    onPick: (name: string) => void;
}) {
    const known = models.some(mf => mf.name === source);
    return (
        <div className="tf">
            <span className="tf-cap">Модель</span>
            <Select
                value={known ? source : ''}
                options={models.map(mf => ({
                    value: mf.name,
                    label: mf.name,
                    hint: `${(mf.size / 1024 / 1024).toFixed(1)} МБ`,
                }))}
                placeholder="—"
                emptyText="Нет моделей"
                onChange={v => {
                    if (v) onPick(v);
                }}
            />
        </div>
    );
}

// Ряд поворота: чипы 0/90/180/270 либо слайдер свободного угла, справа чип «∠»
export function RotRow({
    rotation,
    freeAngle,
    onToggleFree,
    onCommit,
}: {
    rotation: number;
    freeAngle: boolean;
    onToggleFree: () => void;
    onCommit: (deg: number) => void;
}) {
    return (
        <div className="rot">
            {freeAngle ? (
                <RotSlider value={rotation} onCommit={onCommit} />
            ) : (
                [0, 90, 180, 270].map(deg => (
                    <button
                        key={deg}
                        type="button"
                        className={`chip${rotation === deg ? ' is-on' : ''}`}
                        onClick={() => onCommit(deg)}
                    >
                        {deg}°
                    </button>
                ))
            )}
            <button
                type="button"
                className={`chip ang${freeAngle ? ' is-on' : ''}`}
                title="Свободный угол"
                onClick={onToggleFree}
            >
                ∠
            </button>
        </div>
    );
}

// Позиция: степпер с кнопками по краям и откатом к PnP
function PoseStepper({
    label,
    value,
    base,
    step,
    onCommit,
}: {
    label: string;
    value: number;
    // Расчётное PnP-значение — база отката
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
        <div className="tf">
            <span className="tf-cap">{label}</span>
            <div className="stp">
                <button type="button" onClick={() => onCommit(+(value - step).toFixed(4))}>−</button>
                <input
                    className="tf-in"
                    type="number"
                    step={step}
                    value={draft}
                    style={changed ? { color: 'var(--acc)' } : undefined}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={commitDraft}
                    onWheel={e => e.currentTarget.blur()}
                    onKeyDown={e => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                />
                <button type="button" onClick={() => onCommit(+(value + step).toFixed(4))}>+</button>
                <button
                    type="button"
                    className={`rst${changed ? ' is-act' : ''}`}
                    disabled={!changed}
                    title="К PnP"
                    onClick={() => onCommit(base)}
                >
                    <Icon name="refresh" size={12} />
                </button>
            </div>
        </div>
    );
}

// Угол: слайдер во всю строку, значение и откат к PnP справа
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
        <div className="tf">
            <span className="tf-cap">{label}</span>
            <div className="tf-range">
                <input
                    className="rng"
                    type="range"
                    min={min}
                    max={max}
                    step={0.5}
                    value={shown}
                    onChange={e => setDrag(Number(e.target.value))}
                    onPointerUp={commit}
                    onBlur={commit}
                />
                <span className="val" style={changed ? { color: 'var(--acc)' } : undefined}>
                    {shown.toFixed(1)}
                </span>
                <button
                    type="button"
                    className={`rst${changed ? ' is-act' : ''}`}
                    disabled={!changed}
                    title="К PnP"
                    onClick={() => onCommit(base)}
                >
                    <Icon name="refresh" size={12} />
                </button>
            </div>
        </div>
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

    // Сохранённый угол не кратен 90 — панель открывается в свободном режиме
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

    // Поза сразу видна в форме, на сервер уходит одним POST после паузы 300 мс
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
        return <div className="empty">Вывод остановлен</div>;
    }
    if (!cfg) {
        return <span className="spin" />;
    }

    const m = cfg.machine;
    const selectedPose =
        cfg.cameras.find(c => c.placeKey === place) ?? cfg.cameras[0] ?? null;

    if (tab === 'stream') {
        const res = resDraft ?? cfg.resolution;
        const resDirty = res.width !== cfg.resolution.width
            || res.height !== cfg.resolution.height;
        return (
            <>
                <Subhead>Кадр</Subhead>
                {/* Кратность 16 обязательна для кодека: поле выравнивает по blur, отправка страхуется ещё раз */}
                <div className="tf-row">
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
                    className="btn btn--wide"
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
                                // Опрос статуса на рестарте молчит, live не мигает: cfg обновляется явно
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
                <Switch on={cfg.orbit.interactive}
                    onToggle={v => apply({ orbit: { interactive: v } })}>
                    Ручное вращение на отображении
                </Switch>
            </>
        );
    }

    if (tab === 'scene') {
        return (
            <>
                <Subhead>Габарит, м</Subhead>
                <div className="tf-row">
                    <Num label="Длина" value={m.length}
                        onCommit={v => v > 0 && apply({ machine: { length: v } }, true)} />
                    <Num label="Ширина" value={m.width}
                        onCommit={v => v > 0 && apply({ machine: { width: v } }, true)} />
                    <Num label="Высота" value={m.height}
                        onCommit={v => v > 0 && apply({ machine: { height: v } }, true)} />
                </div>

                <Subhead>Подложка</Subhead>
                <Switch on={cfg.plate} onToggle={v => apply({ plate: v })}>
                    Показывать подложку
                </Switch>
                {/* Пусто или 0 — размер от габарита на фактор чаши */}
                {cfg.plate && (
                    <div className="tf-row">
                        <Num label="Длина" value={cfg.plateLength || null}
                            placeholder="авто"
                            onCommit={v => apply({ plate_length: Math.max(0, v) })} />
                        <Num label="Ширина" value={cfg.plateWidth || null}
                            placeholder="авто"
                            onCommit={v => apply({ plate_width: Math.max(0, v) })} />
                    </div>
                )}

                <Subhead>Чаша</Subhead>
                <Range label="Стенка · высота" value={cfg.bowl.wall} min={0.1} max={6} step={0.05}
                    onCommit={v => apply({ bowl: { wall: v } }, true)} />
                {/* Дно сдвигает начало стенки, её вынос от дна не зависит */}
                <Range label="Дно · до загиба" value={cfg.bowl.floor} min={0.1} max={6} step={0.05}
                    onCommit={v => apply({ bowl: { floor: v } }, true)} />
                <Range label="Стенка · вынос" value={cfg.bowl.outer} min={0} max={6} step={0.05}
                    fmt={v => (v === 0 ? 'вертикаль' : v.toFixed(2))}
                    onCommit={v => apply({ bowl: { outer: v } }, true)} />
                <Range label="Скругление углов" value={cfg.bowl.corner} min={0} max={4} step={0.05}
                    fmt={v => (v === 0 ? 'прямые' : v.toFixed(2))}
                    onCommit={v => apply({ bowl: { corner: v } }, true)} />
                <Range label="Ширина шва" value={cfg.bowl.blend} min={0.05} max={1} step={0.05}
                    onCommit={v => apply({ bowl: { blend: v } }, true)} />
                <Switch on={cfg.photometric} onToggle={v => apply({ photometric: v })}>
                    Фотонормализация
                </Switch>
                <Switch on={cfg.wireframe} onToggle={v => apply({ wireframe: v })}>
                    Сетка без кадров
                </Switch>
            </>
        );
    }

    if (tab === 'model') {
        return (
            <>
                <Subhead>Библиотека</Subhead>
                <ModelSelect models={models} source={cfg.model.source}
                    onPick={name => apply({ model: { source: name } })} />
                <div className="brow">
                    <button
                        type="button"
                        className="btn"
                        disabled={uploading}
                        onClick={() => modelFileRef.current?.click()}
                    >
                        {uploading ? 'Загрузка…' : 'Загрузить .glb'}
                    </button>
                    <button
                        type="button"
                        className="btn btn--ghost"
                        disabled={!cfg.model.source}
                        onClick={() => apply({ model: { source: '' } })}
                    >
                        Убрать модель
                    </button>
                </div>
                <input
                    ref={modelFileRef}
                    type="file"
                    accept=".glb"
                    hidden
                    onChange={e => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void uploadModel(file);
                    }}
                />

                <Subhead>Поворот</Subhead>
                <RotRow rotation={cfg.model.rotation} freeAngle={freeAngle}
                    onToggleFree={() => setFreeAngle(!freeAngle)}
                    onCommit={deg => apply({ model: { rotation: deg } })} />

                <Subhead>Размеры, м</Subhead>
                <div className="tf-row">
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
            </>
        );
    }

    // tab === 'cameras'
    // Шаг степпера от габарита: у стенда миллиметры, у машины сантиметры
    const minSide = Math.min(m.length || 0, m.width || 0);
    const posStep = minSide > 0
        ? Math.min(0.05, Math.max(0.005, Math.round(minSide / 50 / 0.005) * 0.005))
        : 0.01;

    const p = selectedPose;

    if (cfg.cameras.length === 0) {
        return <div className="empty">Поз камер нет</div>;
    }

    return (
        <>
            <div className="chips">
                {cfg.cameras.map(c => (
                    <button
                        key={c.placeKey}
                        type="button"
                        className={`chip${p?.placeKey === c.placeKey ? ' is-on' : ''}`}
                        onClick={() => setPlace(c.placeKey)}
                    >
                        {placeNames[c.placeKey] || c.placeKey}
                    </button>
                ))}
            </div>
            {p && (
                <>
                    <div className="pnp">
                        <b>{p.source === 'manual' ? 'ручная поза' : 'PnP'}</b>
                        {`· h ${p.height.toFixed(3)} м · ${p.reprojectionError.toFixed(1)} px`}
                        {p.source === 'manual' && <span className="tag is-warn">оверрайд</span>}
                    </div>

                    <Subhead>Позиция, м</Subhead>
                    <PoseStepper label="X" value={p.position[0]}
                        base={p.pnp.position[0]} step={posStep}
                        onCommit={v => sendPose(p.placeKey, {
                            position: [v, p.position[1], p.position[2]],
                            yaw: p.yaw, pitch: p.pitch, roll: p.roll,
                        })} />
                    <PoseStepper label="Y · высота" value={p.position[1]}
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
                        className="btn btn--wide"
                        disabled={p.source !== 'manual'}
                        onClick={() => resetPose(p)}
                    >
                        Сбросить камеру к PnP
                    </button>
                </>
            )}
        </>
    );
}
