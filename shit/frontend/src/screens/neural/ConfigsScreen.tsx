import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../app/Icons';
import { ConfirmModal } from '../../features/birdview/components/common/ConfirmModal';
import { useToast } from '../../features/birdview/components/common/Toast';
import { neuralApi } from '../../features/neural/api/client';
import type { ConfigSummary, ModelFile, NeuralConfig, TrackerType } from '../../features/neural/api/types';
import { ConfigEditor } from './ConfigEditor';
import { ImportModal } from './ImportModal';

const blankConfig = (): NeuralConfig => ({
    name: '',
    model_path: '',
    thresholds: { nms: 0.45, confidence: 0.5 },
    tracker: null,
    superclasses: {},
    classes: {},
});

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const plural = (n: number, one: string, few: string, many: string) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
};

// Сводка по конфигурации для списка: число классов и цвет первого суперкласса
interface ListMeta {
    classes: number;
    color: string;
}

export function ConfigsScreen() {
    const toast = useToast();

    const [items, setItems] = useState<ConfigSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [meta, setMeta] = useState<Record<string, ListMeta>>({});
    const [usage, setUsage] = useState<Record<string, number>>({});
    const [models, setModels] = useState<ModelFile[]>([]);
    const [trackerTypes, setTrackerTypes] = useState<TrackerType[]>([{ type: 'iou', name: 'IoU' }]);

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [original, setOriginal] = useState<NeuralConfig | null>(null);
    const [draft, setDraft] = useState<NeuralConfig | null>(null);
    const [idDraft, setIdDraft] = useState('');
    const [loadingCfg, setLoadingCfg] = useState(false);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const [toDelete, setToDelete] = useState<ConfigSummary | null>(null);
    const [importOpen, setImportOpen] = useState(false);

    const reloadList = useCallback(async () => {
        try {
            const { configurations } = await neuralApi.listConfigurations();
            setItems(configurations);
            setSelectedId(cur => (cur && configurations.some(c => c.id === cur) ? cur : configurations[0]?.id ?? null));
            const entries = await Promise.all(configurations.map(async c => {
                try {
                    const [cls, sup] = await Promise.all([neuralApi.getClasses(c.id), neuralApi.getSuperclasses(c.id)]);
                    return [c.id, { classes: cls.classes.length, color: sup.superclasses[0]?.color ?? cls.classes[0]?.color ?? 'var(--line-hi)' }] as const;
                } catch {
                    return [c.id, { classes: 0, color: 'var(--line-hi)' }] as const;
                }
            }));
            setMeta(Object.fromEntries(entries));
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    const reloadUsage = useCallback(async () => {
        try {
            const descs = await neuralApi.getState();
            const map: Record<string, number> = {};
            // Конфигурация слота выводится из его видеопотока
            for (const d of descs) if (d.config_id) map[d.config_id] = (map[d.config_id] ?? 0) + 1;
            setUsage(map);
        } catch {
            setUsage({});
        }
    }, []);

    const reloadModels = useCallback(() => {
        neuralApi.listModels().then(setModels).catch(() => setModels([]));
    }, []);

    useEffect(() => {
        reloadList();
        reloadUsage();
        reloadModels();
        neuralApi.getTrackerTypes().then(r => r.types?.length && setTrackerTypes(r.types)).catch(() => {});
    }, [reloadList, reloadUsage, reloadModels]);

    // Выбранная конфигурация грузится целиком; правки живут в копии
    useEffect(() => {
        if (creating || !selectedId) return;
        let cancelled = false;
        setLoadingCfg(true);
        setErr(null);
        neuralApi.getConfiguration(selectedId)
            .then(cfg => {
                if (cancelled) return;
                const full: NeuralConfig = { ...blankConfig(), ...cfg, thresholds: { ...blankConfig().thresholds, ...cfg.thresholds } };
                setOriginal(full);
                setDraft(clone(full));
            })
            .catch(e => !cancelled && setErr(e instanceof Error ? e.message : String(e)))
            .finally(() => !cancelled && setLoadingCfg(false));
        return () => { cancelled = true; };
    }, [selectedId, creating]);

    const dirty = useMemo(() => creating || (!!draft && !!original && JSON.stringify(draft) !== JSON.stringify(original)), [creating, draft, original]);

    const idError = useMemo(() => {
        if (!creating) return null;
        const id = idDraft.trim();
        if (!id) return null;
        if (/\s/.test(id)) return 'Идентификатор без пробелов';
        if (items.some(c => c.id === id)) return 'Конфигурация с таким идентификатором уже есть';
        return null;
    }, [creating, idDraft, items]);

    const canSave = !!draft && dirty && !saving && !!draft.model_path && (!creating || (!!idDraft.trim() && !idError));

    const startCreate = () => {
        setCreating(true);
        setIdDraft('');
        setOriginal(null);
        setDraft(blankConfig());
        setErr(null);
    };

    const selectExisting = (id: string) => {
        setCreating(false);
        setSelectedId(id);
    };

    const cancel = () => {
        setErr(null);
        if (creating) {
            // Выбранная конфигурация перезагрузится эффектом по смене creating
            setCreating(false);
            setDraft(null);
            return;
        }
        if (original) setDraft(clone(original));
    };

    const save = async () => {
        if (!draft) return;
        const id = creating ? idDraft.trim() : selectedId;
        if (!id) return;
        setSaving(true);
        setErr(null);
        try {
            await neuralApi.importConfigurations({ [id]: draft }, 'merge');
            toast(creating ? 'Конфигурация создана' : 'Конфигурация сохранена', draft.name || id, 'ok');
            setCreating(false);
            setOriginal(clone(draft));
            await reloadList();
            setSelectedId(id);
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    };

    const remove = async (cfg: ConfigSummary) => {
        setToDelete(null);
        try {
            await neuralApi.deleteConfiguration(cfg.id);
            toast('Конфигурация удалена', cfg.name || cfg.id, 'ok');
            if (selectedId === cfg.id) {
                setSelectedId(null);
                setDraft(null);
                setOriginal(null);
            }
            await reloadList();
            reloadUsage();
        } catch (e) {
            toast('Не удалось удалить', e instanceof Error ? e.message : String(e), 'err');
        }
    };

    const uploadModel = async (file: File): Promise<string | null> => {
        try {
            const saved = await neuralApi.uploadModel(file);
            reloadModels();
            toast('Модель загружена', saved.filename, 'ok');
            return saved.path;
        } catch (e) {
            toast('Модель не загрузилась', e instanceof Error ? e.message : String(e), 'err');
            return null;
        }
    };

    const used = selectedId ? usage[selectedId] ?? 0 : 0;

    return (
        <div className="nv">
            <div className="nv-main">
                <div className="nv-body">
                    {creating || draft ? (
                        <>
                            <div className="mod-title">
                                <h2>{creating ? 'Новая конфигурация' : draft?.name || selectedId}</h2>
                                {!creating && (
                                    used > 0
                                        ? <span className="pill ok"><span className="dot" />в {used} {plural(used, 'слоте', 'слотах', 'слотах')}</span>
                                        : <span className="pill"><span className="dot" />не используется</span>
                                )}
                                {dirty && !creating && <span className="tag is-warn">есть несохранённые правки</span>}
                                <button className="btn spacer" disabled={!dirty || saving} onClick={cancel}>Отменить</button>
                                <button className="btn btn--acc" disabled={!canSave} onClick={save}>
                                    {saving ? 'Сохранение…' : creating ? 'Создать' : 'Сохранить'}
                                </button>
                            </div>
                            {err && <div className="banner is-err" style={{ marginBottom: 14 }}><Icon name="warn" size={15} />{err}</div>}
                            {loadingCfg || !draft ? (
                                <div className="nv-stack">
                                    <div className="skel" style={{ height: 160 }} />
                                    <div className="skel" style={{ height: 120 }} />
                                </div>
                            ) : (
                                <ConfigEditor
                                    value={draft}
                                    onChange={setDraft}
                                    creating={creating}
                                    id={creating ? idDraft : selectedId ?? ''}
                                    onIdChange={setIdDraft}
                                    idError={idError}
                                    models={models}
                                    onUploadModel={uploadModel}
                                    trackerTypes={trackerTypes}
                                />
                            )}
                        </>
                    ) : loading ? (
                        <div className="nv-stack">
                            <div className="skel" style={{ height: 40, width: '40%' }} />
                            <div className="skel" style={{ height: 160 }} />
                        </div>
                    ) : (
                        <div className="empty" style={{ minHeight: 320 }}>
                            <Icon name="empty" className="ico" />
                            <b>{err ? 'Конфигурации не загрузились' : 'Конфигураций нет'}</b>
                            {err ? <p>{err}</p> : <button className="btn btn--sm btn--acc" onClick={startCreate}>Новая конфигурация</button>}
                        </div>
                    )}
                </div>
            </div>

            <aside className="nv-list">
                <div className="eyebrow">Конфигурации — {items.length}</div>
                {loading && (
                    <div className="skel-rows">
                        <div className="skel" style={{ width: '78%' }} />
                        <div className="skel" style={{ width: '56%' }} />
                    </div>
                )}
                {items.map(c => {
                    const m = meta[c.id];
                    const inUse = (usage[c.id] ?? 0) > 0;
                    const isSel = !creating && c.id === selectedId;
                    return (
                        <div
                            key={c.id}
                            className={`row-item${isSel ? ' is-sel' : ''}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => selectExisting(c.id)}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectExisting(c.id); } }}
                        >
                            <span className="chip-col" style={{ background: m?.color ?? 'var(--line-hi)' }} />
                            <span className="nm">{c.name || c.id}</span>
                            {m && <span className="num">{m.classes} кл.</span>}
                            <button
                                className="icon-btn"
                                disabled={inUse}
                                data-tip={inUse ? 'Видеопоток конфигурации стоит в слоте' : 'Удалить'}
                                onClick={e => { e.stopPropagation(); if (!inUse) setToDelete(c); }}
                            >
                                <Icon name="trash" size={13} />
                            </button>
                        </div>
                    );
                })}
                {creating && (
                    <div className="row-item is-sel is-new">
                        <span className="chip-col" style={{ background: 'var(--line-hi)' }} />
                        <span className="nm">{idDraft.trim() || 'Новая конфигурация'}</span>
                    </div>
                )}
                <div className="foot">
                    <button className="btn btn--sm btn--wide" disabled={creating} onClick={startCreate}>
                        <Icon name="plus" size={15} className="ico" />Новая конфигурация
                    </button>
                    <button className="btn btn--sm btn--wide" onClick={() => setImportOpen(true)}>Импорт конфигураций</button>
                </div>
            </aside>

            {toDelete && (
                <ConfirmModal
                    title="Удалить конфигурацию"
                    message={`«${toDelete.name || toDelete.id}» будет удалена с устройства. Файл модели останется.`}
                    confirmText="Удалить"
                    danger
                    onConfirm={() => remove(toDelete)}
                    onCancel={() => setToDelete(null)}
                />
            )}
            {importOpen && (
                <ImportModal
                    existing={items}
                    onClose={() => setImportOpen(false)}
                    onImported={n => {
                        setImportOpen(false);
                        toast('Импорт выполнен', `${n} ${plural(n, 'конфигурация', 'конфигурации', 'конфигураций')}`, 'ok');
                        reloadList();
                    }}
                />
            )}
        </div>
    );
}
