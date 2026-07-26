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

export type SurroundTab = 'stream' | 'scene' | 'model' | 'cameras';

/** Черновик позы: правки копятся локально и уходят одной кнопкой. */
interface PoseDraft {
    position: [number, number, number];
    yaw: number;
    pitch: number;
    roll: number;
}

function poseOf(pose: SurroundCameraPose): PoseDraft {
    return {
        position: [...pose.position] as [number, number, number],
        yaw: pose.yaw,
        pitch: pose.pitch,
        roll: pose.roll,
    };
}

function samePose(a: PoseDraft, b: PoseDraft): boolean {
    return a.position[0] === b.position[0]
        && a.position[1] === b.position[1]
        && a.position[2] === b.position[2]
        && a.yaw === b.yaw && a.pitch === b.pitch && a.roll === b.roll;
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
function Num({
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
function clampSide(v: number, hi: number): number {
    return Math.min(hi, Math.max(256, Math.round(v / 16) * 16));
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

/** Слайдер угла в ряду кнопок: значение видно, уходит по отпусканию. */
function RotSlider({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
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

/** Заголовок группы внутри вкладки. */
function Subhead({ children }: { children: React.ReactNode }) {
    return <div className="srd-subhead">{children}</div>;
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
    // Черновики поз по местам: одна кнопка шлёт все изменённые
    const [poseDrafts, setPoseDrafts] = useState<Record<string, PoseDraft>>({});
    const [applyingPoses, setApplyingPoses] = useState(false);

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

    // Правка позы копится в черновике места, на сервер не уходит
    const editPose = useCallback(
        (pose: SurroundCameraPose, current: PoseDraft, patch: Partial<PoseDraft>) => {
            setPoseDrafts(prev => ({
                ...prev,
                [pose.placeKey]: { ...current, ...patch },
            }));
        },
        [],
    );

    // Отправка всех изменённых поз разом, перепечка одна на пакет
    const applyPoses = useCallback(async () => {
        if (!exportId || !cfg) return;
        const dirty = Object.entries(poseDrafts).filter(([key, draft]) => {
            const server = cfg.cameras.find(c => c.placeKey === key);
            return server && !samePose(draft, poseOf(server));
        });
        if (dirty.length === 0) return;

        setApplyingPoses(true);
        try {
            for (const [key, draft] of dirty) {
                await linkerApi.setSurroundCamera(key, draft, exportId);
            }
            setPoseDrafts({});
            scheduleRefetch();
        } catch (e) {
            onError('Позы не применены', e);
            void refetch();
        } finally {
            setApplyingPoses(false);
        }
    }, [exportId, cfg, poseDrafts, scheduleRefetch, refetch, onError]);

    const resetPose = useCallback(
        (pose: SurroundCameraPose) => {
            if (!exportId) return;
            setPoseDrafts(prev => {
                const next = { ...prev };
                delete next[pose.placeKey];
                return next;
            });
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
    const shown = selectedPose
        ? poseDrafts[selectedPose.placeKey] ?? poseOf(selectedPose)
        : null;
    const dirtyCount = Object.entries(poseDrafts).filter(([key, draft]) => {
        const server = cfg.cameras.find(c => c.placeKey === key);
        return server && !samePose(draft, poseOf(server));
    }).length;

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
                                aria-pressed={selectedPose?.placeKey === c.placeKey}
                                onClick={() => setPlace(c.placeKey)}
                            >
                                {placeNames[c.placeKey] || c.placeKey}
                            </button>
                        ))}
                    </div>
                    {selectedPose && shown && (
                        <>
                            <div className="srd-pnp">
                                {selectedPose.source === 'manual' ? 'ручная поза' : 'PnP'}
                                {' · h='}
                                {selectedPose.height.toFixed(3)} м
                                {selectedPose.source === 'pnp' &&
                                    ` · ${selectedPose.reprojectionError.toFixed(1)} px`}
                            </div>
                            <div className="srd-row">
                                <Num label="X, м" value={shown.position[0]}
                                    onCommit={v => editPose(selectedPose, shown, {
                                        position: [v, shown.position[1], shown.position[2]],
                                    })} />
                                <Num label="Y, м" value={shown.position[1]}
                                    onCommit={v => editPose(selectedPose, shown, {
                                        position: [shown.position[0], v, shown.position[2]],
                                    })} />
                                <Num label="Z, м" value={shown.position[2]}
                                    onCommit={v => editPose(selectedPose, shown, {
                                        position: [shown.position[0], shown.position[1], v],
                                    })} />
                            </div>
                            <div className="srd-row">
                                <Num label="Yaw, °" value={shown.yaw} step={1}
                                    onCommit={v => editPose(selectedPose, shown, { yaw: v })} />
                                <Num label="Pitch, °" value={shown.pitch} step={1}
                                    onCommit={v => editPose(selectedPose, shown, { pitch: v })} />
                                <Num label="Roll, °" value={shown.roll} step={1}
                                    onCommit={v => editPose(selectedPose, shown, { roll: v })} />
                            </div>
                            {/* Черновики переживают переключение мест: пакет уходит один */}
                            <button
                                type="button"
                                className="srd-apply"
                                disabled={dirtyCount === 0 || applyingPoses}
                                onClick={() => void applyPoses()}
                            >
                                {applyingPoses
                                    ? 'Применение…'
                                    : dirtyCount > 1
                                      ? `Применить (${dirtyCount} камеры)`
                                      : 'Применить'}
                            </button>
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
        </div>
    );
}
