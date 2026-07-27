import { useCallback, useEffect, useRef, useState } from 'react';
import { linkerApi } from '../../api/linker';
import type { SurroundModelFile, TopConfig, TopPatch } from '../../api/linker';
import type { SurroundTab } from './SurroundPanel';
import { Num, Range, RotSlider, Subhead, Toggle, clampSide } from './SurroundPanel';

/**
 * Настройки плоской сшивки по вкладкам колонки «Параметры вывода»:
 * stream — разрешение кадра, scene — версия карт, шов и подложка,
 * model — библиотека .glb, images — рисунки экспорта. Вкладки «Камеры» у top нет.
 *
 * Всё новое живёт на версиях текущего поколения печки: легаси v1 обновляется
 * перезаписью конфигурации через «Рассчитать LUT» на сборке. Правки уходят
 * частичным мёржем POST /linker/top; коммит слайдера шва перепекает веса
 * на сервере без новой версии.
 */

interface TopPanelProps {
    /** Вывод этой конфигурации в эфире в режиме сверху. */
    live: boolean;
    exportId: string | null;
    tab: SurroundTab;
    onError: (title: string, e: unknown) => void;
    /** Перезапуск вывода с новым разрешением: стоп, запись, старт делает экран. */
    onApplyResolution: (res: { width: number; height: number }) => Promise<boolean>;
    /** Уведомление экрана: пересчёт или смена версии перезапустили вывод. */
    onOutputRestarted: () => void;
}

function versionLabel(key: string, created: number): string {
    if (!created) return key;
    const d = new Date(created * 1000);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${key} · ${dd}.${mm} ${hh}:${mi}`;
}

export function TopPanel({
    live,
    exportId,
    tab,
    onError,
    onApplyResolution,
    onOutputRestarted,
}: TopPanelProps) {
    const [cfg, setCfg] = useState<TopConfig | null>(null);
    const [models, setModels] = useState<SurroundModelFile[]>([]);
    const modelFileRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    // Свободный угол включается сам, если сохранённый не кратен 90
    const [freeAngle, setFreeAngle] = useState(false);
    // Черновик разрешения: уходит кнопкой, поле само держит кратность 16
    const [resDraft, setResDraft] = useState<{ width: number; height: number } | null>(null);
    const [resApplying, setResApplying] = useState(false);
    const [versionBusy, setVersionBusy] = useState(false);

    const refetchModels = useCallback(() => {
        linkerApi.listModels().then(setModels).catch(() => setModels([]));
    }, []);

    const refetch = useCallback(async () => {
        if (!exportId) return;
        try {
            setCfg(await linkerApi.getTop(exportId));
        } catch (e) {
            onError('Не удалось прочитать настройки сшивки', e);
        }
    }, [exportId, onError]);

    // Настройки читаются по выбранной конфигурации, эфир не обязателен
    useEffect(() => {
        setCfg(null);
        setResDraft(null);
        if (exportId) {
            void refetch();
            refetchModels();
        }
    }, [exportId, refetch, refetchModels]);

    useEffect(() => {
        if (cfg && cfg.model.rotation % 90 !== 0) setFreeAngle(true);
    }, [cfg]);

    const apply = useCallback(
        (patch: TopPatch) => {
            if (!cfg || !exportId) return;
            // Оптимистичное применение: при отказе сервера значения перечитываются
            setCfg({
                ...cfg,
                ...(patch.blend !== undefined ? { blend: patch.blend } : {}),
                ...(patch.photometric !== undefined ? { photometric: patch.photometric } : {}),
                ...(patch.plate !== undefined ? { plate: patch.plate } : {}),
                ...(patch.plate_length !== undefined ? { plateLength: patch.plate_length } : {}),
                ...(patch.plate_width !== undefined ? { plateWidth: patch.plate_width } : {}),
                ...(patch.model ? { model: { ...cfg.model, ...patch.model } } : {}),
                ...(patch.resolution ? { resolution: patch.resolution } : {}),
                ...(patch.images
                    ? {
                        images: cfg.images.map(img =>
                            patch.images![img.name]
                                ? { ...img, ...patch.images![img.name] }
                                : img,
                        ),
                    }
                    : {}),
            });
            linkerApi.postTop(patch, exportId).catch(e => {
                onError('Настройка не применена', e);
                void refetch();
            });
        },
        [cfg, exportId, refetch, onError],
    );

    // Загрузка в библиотеку и привязка к конфигурации одним действием
    const uploadModel = useCallback(
        async (file: File) => {
            if (!exportId) return;
            setUploading(true);
            try {
                const name = await linkerApi.uploadModel(file);
                await linkerApi.postTop({ model: { source: name } }, exportId);
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

    const switchVersion = useCallback(
        async (version: string) => {
            if (!exportId || !cfg || version === cfg.activeVersion) return;
            setVersionBusy(true);
            try {
                await linkerApi.setTopVersion(version, exportId);
                await refetch();
                if (live) onOutputRestarted();
            } catch (e) {
                onError('Версия не переключена', e);
            } finally {
                setVersionBusy(false);
            }
        },
        [exportId, cfg, live, refetch, onError, onOutputRestarted],
    );

    if (!exportId) return null;
    if (!cfg) {
        return <div className="srd-hint">Загрузка настроек…</div>;
    }

    // Легаси-версия: из нового доступен только селектор версии
    const legacy = cfg.generation < cfg.currentGeneration;
    const legacyHint = (
        <div className="srd-hint">
            Активна версия {cfg.activeVersion} старой печки. Настройки сшивки
            появятся после перезаписи конфигурации через «Рассчитать LUT»
        </div>
    );

    if (tab === 'stream') {
        if (legacy) return legacyHint;
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
                {/* Пропорции канваса сохраняются: лишнее пространство кадра
                    заливается чёрными полями, картинка не тянется */}
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
                                setCfg(prev =>
                                    prev ? { ...prev, resolution: norm } : prev,
                                );
                                setResDraft(null);
                                void refetch();
                            })
                            .finally(() => setResApplying(false));
                    }}
                >
                    {resApplying
                        ? 'Применение…'
                        : live
                          ? 'Применить · перезапуск вывода'
                          : 'Применить'}
                </button>
            </div>
        );
    }

    if (tab === 'scene') {
        return (
            <div className="srd-panel">
                <Subhead>Версия карт</Subhead>
                <label className="srd-num">
                    <span className="srd-num-label">Активная</span>
                    <select
                        className="field-input"
                        value={cfg.activeVersion}
                        disabled={versionBusy || cfg.versions.length < 2}
                        onChange={e => void switchVersion(e.target.value)}
                    >
                        {cfg.versions.map(v => (
                            <option key={v.key} value={v.key}>
                                {versionLabel(v.key, v.created)}
                            </option>
                        ))}
                    </select>
                </label>
                {legacy ? legacyHint : (
                    <>
                        <Subhead>Швы</Subhead>
                        {/* Коммит слайдера перепекает веса активной версии на месте */}
                        <Range label="Ширина шва" value={cfg.blend} min={0.05} max={1} step={0.05}
                            onCommit={v => apply({ blend: v })} />
                        <Toggle label="Фотонормализация" on={cfg.photometric}
                            onChange={v => apply({ photometric: v })} />

                        <Subhead>Подложка</Subhead>
                        <Toggle label="Показывать подложку" on={cfg.plate}
                            onChange={v => apply({ plate: v })} />
                        {/* Пусто или 0 — размер от габарита с запасом */}
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
                    </>
                )}
            </div>
        );
    }

    if (tab === 'images') {
        if (legacy) return legacyHint;
        return (
            <div className="srd-panel">
                <Subhead>Рисунки</Subhead>
                {cfg.images.length === 0 ? (
                    <div className="srd-hint">
                        В конфигурации нет рисунков — они добавляются в конфигураторе
                    </div>
                ) : (
                    cfg.images.map(img => {
                        // Тройка шлётся целиком: сервер заменяет запись рисунка
                        const push = (patch: Partial<{ visible: boolean; width: number; height: number }>) =>
                            apply({
                                images: {
                                    [img.name]: {
                                        visible: img.visible,
                                        width: img.width,
                                        height: img.height,
                                        ...patch,
                                    },
                                },
                            });
                        const resized = img.width !== img.defaultWidth
                            || img.height !== img.defaultHeight;
                        return (
                            <div key={img.name} className="srd-image">
                                <Toggle label={img.name} on={img.visible}
                                    onChange={v => push({ visible: v })} />
                                {img.visible && (
                                    <>
                                        <div className="srd-row">
                                            <Num label="Ширина, px" value={img.width} step={1}
                                                onCommit={v => v > 0 && push({ width: Math.round(v) })} />
                                            <Num label="Высота, px" value={img.height} step={1}
                                                onCommit={v => v > 0 && push({ height: Math.round(v) })} />
                                        </div>
                                        {resized && (
                                            <button
                                                type="button"
                                                className="srd-reset"
                                                onClick={() => push({
                                                    width: img.defaultWidth,
                                                    height: img.defaultHeight,
                                                })}
                                            >
                                                ↺ Исходный размер · {img.defaultWidth}×{img.defaultHeight}
                                            </button>
                                        )}
                                    </>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        );
    }

    // tab === 'model'
    if (legacy) return legacyHint;
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
                    placeholder="габарит"
                    onCommit={v => apply({ model: { length: Math.max(0, v) } })} />
                <Num label="Ширина" value={cfg.model.width || null}
                    placeholder="габарит"
                    onCommit={v => apply({ model: { width: Math.max(0, v) } })} />
                <Num label="Высота" value={cfg.model.height || null}
                    placeholder="габарит"
                    onCommit={v => apply({ model: { height: Math.max(0, v) } })} />
            </div>
            <Range label="Прозрачность" value={1 - cfg.model.alpha} min={0} max={1} step={0.05}
                fmt={v => `${Math.round(v * 100)}%`}
                onCommit={v => apply({ model: { alpha: Number((1 - v).toFixed(2)) } })} />
        </div>
    );
}
