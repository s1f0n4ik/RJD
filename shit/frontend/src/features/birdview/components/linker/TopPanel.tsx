import { useCallback, useEffect, useRef, useState } from 'react';
import { Switch } from '../../../../app/Modal';
import { Select } from '../../../../app/Select';
import { linkerApi } from '../../api/linker';
import type { SurroundModelFile, TopConfig, TopPatch } from '../../api/linker';
import type { SurroundTab } from './SurroundPanel';
import { ModelSelect, Num, Range, RotRow, Subhead, clampSide } from './SurroundPanel';

// Настройки плоской сшивки по вкладкам: stream — кадр, scene — версия карт, шов, подложка,
// model — библиотека .glb, images — рисунки экспорта. Легаси-версия даёт только селект версии

interface TopPanelProps {
    // Вывод этой конфигурации в эфире в режиме сверху
    live: boolean;
    exportId: string | null;
    tab: SurroundTab;
    onError: (title: string, e: unknown) => void;
    // Перезапуск вывода с новым разрешением: стоп, запись, старт делает экран
    onApplyResolution: (res: { width: number; height: number }) => Promise<boolean>;
    // Пересчёт или смена версии перезапустили вывод
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
        return <span className="spin" />;
    }

    // Легаси-версия: из нового доступен только селектор версии
    const legacy = cfg.generation < cfg.currentGeneration;
    const versionBlock = (
        <>
            <Subhead>
                Версия карт
                {legacy && <span className="tag is-warn">карты v{cfg.generation} · нужен пересчёт</span>}
            </Subhead>
            <div className="tf">
                <span className="tf-cap">Активная</span>
                <Select
                    value={cfg.activeVersion}
                    options={cfg.versions.map(v => ({ value: v.key, label: versionLabel(v.key, v.created) }))}
                    disabled={versionBusy || cfg.versions.length < 2}
                    onChange={v => void switchVersion(v)}
                />
            </div>
        </>
    );

    if (legacy) return versionBlock;

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
                {/* Пропорции канваса сохраняются: лишнее пространство кадра заливается чёрным */}
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
            </>
        );
    }

    if (tab === 'scene') {
        return (
            <>
                {versionBlock}

                <Subhead>Швы</Subhead>
                {/* Коммит слайдера перепекает веса активной версии на месте */}
                <Range label="Ширина шва" value={cfg.blend} min={0.05} max={1} step={0.05}
                    onCommit={v => apply({ blend: v })} />
                <Switch on={cfg.photometric} onToggle={v => apply({ photometric: v })}>
                    Фотонормализация
                </Switch>

                <Subhead>Подложка</Subhead>
                <Switch on={cfg.plate} onToggle={v => apply({ plate: v })}>
                    Показывать подложку
                </Switch>
                {/* Пусто или 0 — размер от габарита с запасом */}
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
            </>
        );
    }

    if (tab === 'images') {
        if (cfg.images.length === 0) {
            return <div className="empty">Рисунков нет</div>;
        }
        return (
            <>
                <Subhead>Рисунки</Subhead>
                {cfg.images.map(img => {
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
                        <div key={img.name} className="imgf">
                            <Switch on={img.visible} onToggle={v => push({ visible: v })}>
                                {img.name}
                            </Switch>
                            {img.visible && (
                                <>
                                    <div className="tf-row">
                                        <Num label="Ширина, px" value={img.width} step={1}
                                            onCommit={v => v > 0 && push({ width: Math.round(v) })} />
                                        <Num label="Высота, px" value={img.height} step={1}
                                            onCommit={v => v > 0 && push({ height: Math.round(v) })} />
                                    </div>
                                    {resized && (
                                        <button
                                            type="button"
                                            className="btn btn--sm btn--ghost"
                                            onClick={() => push({
                                                width: img.defaultWidth,
                                                height: img.defaultHeight,
                                            })}
                                        >
                                            Исходный размер · {img.defaultWidth}×{img.defaultHeight}
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    );
                })}
            </>
        );
    }

    // tab === 'model'
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
        </>
    );
}
