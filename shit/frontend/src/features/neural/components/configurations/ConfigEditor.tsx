import { useCallback, useEffect, useMemo, useState } from 'react';
import { neuralApi } from '../../api/client';
import type { ClassDef, ModelFile, NeuralConfig, SuperclassDef } from '../../api/types';
import { ClassPalette } from './ClassPalette';
import { SuperclassPalette } from './SuperclassPalette';
import { ModelUpload } from './ModelUpload';

interface ConfigEditorProps {
    configId: string | null;
    /** Если задан — режим создания новой конфигурации (ещё нет на сервере). */
    seed: NeuralConfig | null;
    models: ModelFile[];
    onRefreshModels: () => void;
    /** originalId === null → создание; иначе сохранение/переименование. */
    onSave: (originalId: string | null, newId: string, config: NeuralConfig) => Promise<void>;
    onDiscardNew: () => void;
}

export function ConfigEditor({
                                 configId,
                                 seed,
                                 models,
                                 onRefreshModels,
                                 onSave,
                                 onDiscardNew,
                             }: ConfigEditorProps) {
    const isNew = seed !== null;

    const [original, setOriginal] = useState<NeuralConfig | null>(null);
    const [draft, setDraft] = useState<NeuralConfig | null>(null);
    const [idDraft, setIdDraft] = useState('');
    const [editing, setEditing] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
        setErr(null);
        if (seed) {
            setOriginal(structuredClone(seed));
            setDraft(structuredClone(seed));
            setIdDraft('new_config');
            setEditing(true);
            return;
        }
        if (!configId) {
            setOriginal(null);
            setDraft(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setEditing(false);
        setIdDraft(configId);
        neuralApi
            .getConfiguration(configId)
            .then((cfg) => {
                if (cancelled) return;
                setOriginal(cfg);
                setDraft(structuredClone(cfg));
            })
            .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)))
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [configId, seed]);

    const idChanged = !isNew && idDraft.trim() !== (configId ?? '');
    const dirty = useMemo(() => {
        if (isNew) return true;
        return (!!draft && !!original && JSON.stringify(draft) !== JSON.stringify(original)) || idChanged;
    }, [isNew, draft, original, idChanged]);

    // ── патчи ──────────────────────────────────────────────────
    const patch = useCallback((p: Partial<NeuralConfig>) => setDraft((d) => (d ? { ...d, ...p } : d)), []);

    const patchClass = useCallback((id: string, cp: Partial<ClassDef>) => {
        setDraft((d) => (d ? { ...d, classes: { ...d.classes, [id]: { ...d.classes[id], ...cp } } } : d));
    }, []);

    const patchSuper = useCallback((key: string, sp: Partial<SuperclassDef>) => {
        setDraft((d) =>
            d ? { ...d, superclasses: { ...d.superclasses, [key]: { ...d.superclasses[key], ...sp } } } : d,
        );
    }, []);

    const renameSuper = useCallback((oldKey: string, newKey: string) => {
        setDraft((d) => {
            if (!d || !newKey || newKey === oldKey || newKey in d.superclasses) return d;
            const superclasses: Record<string, SuperclassDef> = {};
            for (const [k, v] of Object.entries(d.superclasses)) superclasses[k === oldKey ? newKey : k] = v;
            const classes: Record<string, ClassDef> = {};
            for (const [id, c] of Object.entries(d.classes)) {
                classes[id] = c.superclass === oldKey ? { ...c, superclass: newKey } : c;
            }
            return { ...d, superclasses, classes };
        });
    }, []);

    const addSuper = useCallback((key: string) => {
        setDraft((d) =>
            d ? { ...d, superclasses: { ...d.superclasses, [key]: { name: key, color: '#4aa8ff' } } } : d,
        );
    }, []);

    const removeSuper = useCallback((key: string) => {
        setDraft((d) => {
            if (!d) return d;
            const superclasses = { ...d.superclasses };
            delete superclasses[key];
            const classes: Record<string, ClassDef> = {};
            for (const [id, c] of Object.entries(d.classes)) {
                classes[id] = c.superclass === key ? { ...c, superclass: '' } : c;
            }
            return { ...d, superclasses, classes };
        });
    }, []);

    const addClass = useCallback(() => {
        setDraft((d) => {
            if (!d) return d;
            const nums = Object.keys(d.classes).map(Number).filter((n) => !Number.isNaN(n));
            const nextId = String(nums.length ? Math.max(...nums) + 1 : 0);
            const superKey = Object.keys(d.superclasses)[0] ?? '';
            const fresh: ClassDef = { name: 'Новый класс', server_id: '', superclass: superKey, color: '#4aa8ff' };
            return { ...d, classes: { ...d.classes, [nextId]: fresh } };
        });
    }, []);

    const removeClass = useCallback((id: string) => {
        setDraft((d) => {
            if (!d) return d;
            const classes = { ...d.classes };
            delete classes[id];
            return { ...d, classes };
        });
    }, []);

    // ── сохранение ─────────────────────────────────────────────
    async function save() {
        if (!draft) return;
        const newId = idDraft.trim();
        if (!newId) return setErr('Укажите id конфигурации');
        if (/\s/.test(newId)) return setErr('id не должен содержать пробелы');
        setSaving(true);
        setErr(null);
        try {
            await onSave(isNew ? null : configId, newId, draft);
            if (!isNew) {
                setOriginal(structuredClone(draft));
                setEditing(false);
            }
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    }

    function cancel() {
        if (isNew) {
            onDiscardNew();
            return;
        }
        if (original) setDraft(structuredClone(original));
        setIdDraft(configId ?? '');
        setEditing(false);
        setErr(null);
    }

    if (!isNew && !configId) {
        return (
            <div className="panel" style={{ alignItems: 'center', justifyContent: 'center', minHeight: 200 }}>
                <span className="editor-empty">выберите конфигурацию слева или создайте новую</span>
            </div>
        );
    }
    if (loading || !draft) return <div className="panel"><span className="spinner">загрузка…</span></div>;

    return (
        <>
            <div className="panel">
                <div className="panel-header">
                    <span className="panel-icon">⚙</span>
                    <span className="panel-title">{isNew ? 'Новая конфигурация' : `Параметры · ${configId}`}</span>
                    {!editing ? (
                        <button className="btn btn-primary btn-sm" onClick={() => setEditing(true)}>✎ редактировать</button>
                    ) : (
                        <button className="btn btn-ghost btn-sm" onClick={cancel}>{isNew ? 'отменить создание' : 'отмена'}</button>
                    )}
                </div>

                {editing && (
                    <label className="field-group">
                        <span className="field-label">ID конфигурации</span>
                        <input
                            className="field-input"
                            value={idDraft}
                            placeholder="railway_camera"
                            onChange={(e) => setIdDraft(e.target.value)}
                        />
                        {idChanged && <span className="hint">будет переименована из «{configId}»</span>}
                    </label>
                )}

                <label className="field-group">
                    <span className="field-label">Название</span>
                    <input className="field-input" value={draft.name} disabled={!editing}
                           onChange={(e) => patch({ name: e.target.value })} />
                </label>

                <ModelUpload
                    models={models}
                    currentPath={draft.model_path}
                    editing={editing}
                    onPick={(model_path) => patch({ model_path })}
                    onUploaded={onRefreshModels}
                />

                <div className="field-row params">
                    <label className="field-group">
                        <span className="field-label">Width</span>
                        <input className="field-input" type="number" disabled={!editing} value={draft.model_width}
                               onChange={(e) => patch({ model_width: Number(e.target.value) })} />
                    </label>
                    <label className="field-group">
                        <span className="field-label">Height</span>
                        <input className="field-input" type="number" disabled={!editing} value={draft.model_height}
                               onChange={(e) => patch({ model_height: Number(e.target.value) })} />
                    </label>
                    <label className="field-group">
                        <span className="field-label">Confidence</span>
                        <input className="field-input" type="number" step="0.01" disabled={!editing} value={draft.thresholds.confidence}
                               onChange={(e) => patch({ thresholds: { ...draft.thresholds, confidence: Number(e.target.value) } })} />
                    </label>
                    <label className="field-group">
                        <span className="field-label">NMS</span>
                        <input className="field-input" type="number" step="0.01" disabled={!editing} value={draft.thresholds.nms}
                               onChange={(e) => patch({ thresholds: { ...draft.thresholds, nms: Number(e.target.value) } })} />
                    </label>
                </div>
            </div>

            <SuperclassPalette
                superclasses={draft.superclasses}
                editing={editing}
                onChange={patchSuper}
                onRenameKey={renameSuper}
                onAdd={addSuper}
                onRemove={removeSuper}
            />
            <ClassPalette
                classes={draft.classes}
                superclasses={draft.superclasses}
                editing={editing}
                onChange={patchClass}
                onAdd={addClass}
                onRemove={removeClass}
            />

            {err && <div className="error-box">{err}</div>}

            {editing && (
                <button className={`btn btn-save${dirty ? ' active' : ''}`} disabled={!dirty || saving} onClick={save}>
                    {saving ? 'сохранение…' : isNew ? '● создать конфигурацию' : dirty ? '● сохранить изменения' : 'нет изменений'}
                </button>
            )}
        </>
    );
}