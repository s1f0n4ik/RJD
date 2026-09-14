import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Select } from '../../app/Select';
import type { ClassDef, ModelFile, NeuralConfig, SuperclassDef, TrackerConfig, TrackerType } from '../../features/neural/api/types';

// Дефолт трекера при включении — совпадает с FIoUTrackerConfig на сервере
const DEFAULT_TRACKER: TrackerConfig = {
    type: 'iou',
    iou_threshold: 0.3,
    min_hits: 4,
    max_lost: 8,
    move_threshold: 0.05,
};

const NO_SUPER_COLOR = '#7b8698';
const NEW_COLOR = '#5b9dff';

interface ConfigEditorProps {
    value: NeuralConfig;
    onChange: (next: NeuralConfig) => void;
    /** Режим создания: id вводится, иначе только показывается */
    creating: boolean;
    id: string;
    onIdChange: (id: string) => void;
    idError: string | null;
    models: ModelFile[];
    onUploadModel: (file: File) => Promise<string | null>;
    trackerTypes: TrackerType[];
}

const fmtSize = (bytes: number) => bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} МБ` : `${Math.round(bytes / 1024)} КБ`;

export function ConfigEditor({ value, onChange, creating, id, onIdChange, idError, models, onUploadModel, trackerTypes }: ConfigEditorProps) {
    const fileRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadErr, setUploadErr] = useState<string | null>(null);

    const patch = (p: Partial<NeuralConfig>) => onChange({ ...value, ...p });

    const modelOptions = models.map(m => ({ value: m.path, label: m.filename, hint: fmtSize(m.size) }));
    // Путь из конфигурации может не совпадать ни с одним файлом списка
    if (value.model_path && !models.some(m => m.path === value.model_path)) {
        modelOptions.unshift({ value: value.model_path, label: value.model_path.split('/').pop() || value.model_path, hint: 'файла нет' });
    }

    const handleFile = async (file: File | undefined) => {
        if (!file) return;
        setUploadErr(null);
        if (!file.name.endsWith('.rknn')) { setUploadErr('Только файлы .rknn'); return; }
        setUploading(true);
        try {
            const path = await onUploadModel(file);
            if (path) patch({ model_path: path });
        } finally {
            setUploading(false);
            if (fileRef.current) fileRef.current.value = '';
        }
    };

    const tracker = value.tracker ?? null;
    const setTrackerType = (type: string) => {
        patch({ tracker: type ? { ...(tracker ?? DEFAULT_TRACKER), type } : null });
    };
    const patchTracker = (p: Partial<TrackerConfig>) => {
        if (tracker) patch({ tracker: { ...tracker, ...p } });
    };

    return (
        <div className="nv-stack">
            <div className="nv-blocks">
                <div className="nvb">
                    <div className="blk-h"><h3>Основное</h3></div>
                    <div className="blk-b">
                        <div className="tf-row">
                            <div className="tf id">
                                <span className="tf-cap">Идентификатор</span>
                                {creating
                                    ? <input className={`tf-in${idError ? ' is-err' : ''}`} value={id} onChange={e => onIdChange(e.target.value)} placeholder="railway_camera" />
                                    : <input className="tf-in is-ro" value={id} readOnly />}
                            </div>
                            <div className="tf">
                                <span className="tf-cap">Название</span>
                                <input className="tf-in" value={value.name} onChange={e => patch({ name: e.target.value })} placeholder="Название" />
                            </div>
                        </div>
                        <div className="tf-row ctl">
                            <div className="tf">
                                <span className="tf-cap">Модель</span>
                                <Select
                                    value={value.model_path}
                                    options={modelOptions}
                                    onChange={v => patch({ model_path: v })}
                                    placeholder="Не выбрана"
                                    emptyText="Файлов .rknn на устройстве нет"
                                />
                            </div>
                            <button className="icon-btn" data-tip="Загрузить файл .rknn" disabled={uploading} onClick={() => fileRef.current?.click()}>
                                <Icon name="down" size={14} />
                            </button>
                            <input ref={fileRef} type="file" accept=".rknn" style={{ display: 'none' }} onChange={e => handleFile(e.target.files?.[0])} />
                        </div>
                        {idError && <span className="hint is-err">{idError}</span>}
                        {uploadErr && <span className="hint is-err">{uploadErr}</span>}
                    </div>
                </div>

                <div className="two">
                    <div className="nvb">
                        <div className="blk-h"><h3>Пороги</h3></div>
                        <div className="blk-b">
                            <div className="tf-row">
                                <NumField label="Уверенность" value={value.thresholds.confidence} step={0.01} min={0} max={1} digits={2}
                                    onCommit={v => patch({ thresholds: { ...value.thresholds, confidence: v } })} />
                                <NumField label="NMS" value={value.thresholds.nms} step={0.01} min={0} max={1} digits={2}
                                    onCommit={v => patch({ thresholds: { ...value.thresholds, nms: v } })} />
                            </div>
                        </div>
                    </div>
                    <div className="nvb">
                        <div className="blk-h">
                            <h3>Трекер</h3>
                            <div className="seg spacer">
                                <button className={!tracker ? 'is-on' : ''} onClick={() => setTrackerType('')}>Выключен</button>
                                {trackerTypes.map(t => (
                                    <button key={t.type} className={tracker?.type === t.type ? 'is-on' : ''} onClick={() => setTrackerType(t.type)}>{t.name}</button>
                                ))}
                            </div>
                        </div>
                        <div className={`blk-b${tracker ? '' : ' is-dim'}`}>
                            <div className="tf-row">
                                <NumField label="Порог IoU" value={tracker?.iou_threshold ?? DEFAULT_TRACKER.iou_threshold} step={0.01} min={0} max={1} digits={2}
                                    onCommit={v => patchTracker({ iou_threshold: v })} disabled={!tracker} />
                                <NumField label="Порог сдвига" value={tracker?.move_threshold ?? DEFAULT_TRACKER.move_threshold} step={0.01} min={0} max={1} digits={2}
                                    onCommit={v => patchTracker({ move_threshold: v })} disabled={!tracker} />
                            </div>
                            <div className="tf-row">
                                <NumField label="Мин. совпадений" value={tracker?.min_hits ?? DEFAULT_TRACKER.min_hits} step={1} min={1} digits={0}
                                    onCommit={v => patchTracker({ min_hits: v })} disabled={!tracker} />
                                <NumField label="Макс. пропусков" value={tracker?.max_lost ?? DEFAULT_TRACKER.max_lost} step={1} min={0} digits={0}
                                    onCommit={v => patchTracker({ max_lost: v })} disabled={!tracker} />
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="nv-blocks">
                <Superclasses value={value} onChange={onChange} />
            </div>

            <div className="nv-blocks">
                <Classes value={value} onChange={onChange} />
            </div>
        </div>
    );
}

// ── Числовое поле с коммитом по blur/Enter: пока печатают, значение живёт строкой ──
interface NumFieldProps {
    label: string;
    value: number;
    step: number;
    min?: number;
    max?: number;
    digits: number;
    disabled?: boolean;
    onCommit: (v: number) => void;
}

function NumField({ label, value, step, min, max, digits, disabled, onCommit }: NumFieldProps) {
    const [text, setText] = useState(value.toFixed(digits));
    const [focused, setFocused] = useState(false);

    useEffect(() => {
        if (!focused) setText(value.toFixed(digits));
    }, [value, digits, focused]);

    const commit = () => {
        let n = Number(text.replace(',', '.'));
        if (!Number.isFinite(n)) { setText(value.toFixed(digits)); return; }
        if (min != null) n = Math.max(min, n);
        if (max != null) n = Math.min(max, n);
        n = Number(n.toFixed(digits));
        setText(n.toFixed(digits));
        if (n !== value) onCommit(n);
    };

    return (
        <div className="tf">
            <span className="tf-cap">{label}</span>
            <input
                className="tf-in"
                type="number"
                step={step}
                min={min}
                max={max}
                value={text}
                disabled={disabled}
                onChange={e => setText(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => { setFocused(false); commit(); }}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                onWheel={e => e.currentTarget.blur()}
            />
        </div>
    );
}

// ── Суперклассы ──
function Superclasses({ value, onChange }: { value: NeuralConfig; onChange: (next: NeuralConfig) => void }) {
    const keys = Object.keys(value.superclasses);

    const patchSuper = (key: string, p: Partial<SuperclassDef>) =>
        onChange({ ...value, superclasses: { ...value.superclasses, [key]: { ...value.superclasses[key], ...p } } });

    const renameSuper = (oldKey: string, rawKey: string) => {
        const newKey = rawKey.trim();
        if (!newKey || newKey === oldKey || newKey in value.superclasses || /\s/.test(newKey)) return;
        const superclasses: Record<string, SuperclassDef> = {};
        for (const [k, v] of Object.entries(value.superclasses)) superclasses[k === oldKey ? newKey : k] = v;
        const classes: Record<string, ClassDef> = {};
        for (const [id, c] of Object.entries(value.classes)) classes[id] = c.superclass === oldKey ? { ...c, superclass: newKey } : c;
        onChange({ ...value, superclasses, classes });
    };

    const addSuper = () => {
        let i = 1;
        let key = `super_${i}`;
        while (key in value.superclasses) key = `super_${++i}`;
        onChange({ ...value, superclasses: { ...value.superclasses, [key]: { name: '', color: NEW_COLOR } } });
    };

    const removeSuper = (key: string) => {
        const superclasses = { ...value.superclasses };
        delete superclasses[key];
        const classes: Record<string, ClassDef> = {};
        for (const [id, c] of Object.entries(value.classes)) classes[id] = c.superclass === key ? { ...c, superclass: '' } : c;
        onChange({ ...value, superclasses, classes });
    };

    return (
        <div className="nvb">
            <div className="blk-h">
                <h3>Суперклассы</h3>
                <span className="eyebrow">{keys.length}</span>
                <button className="icon-btn add spacer" data-tip="Добавить суперкласс" onClick={addSuper}><Icon name="plus" size={13} /></button>
            </div>
            <div className="blk-b" style={{ gap: 8 }}>
                {keys.length === 0 && <div className="empty"><b>Суперклассов нет</b></div>}
                {keys.map(key => {
                    const s = value.superclasses[key];
                    return (
                        <div className="scls" key={key}>
                            <ColorSwatch color={s.color} onChange={color => patchSuper(key, { color })} />
                            <input className="nm" value={s.name} placeholder="Название" onChange={e => patchSuper(key, { name: e.target.value })} />
                            <KeyField value={key} onCommit={k => renameSuper(key, k)} />
                            <button className="icon-btn" data-tip="Удалить" onClick={() => removeSuper(key)}><Icon name="trash" size={13} /></button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// Ключ суперкласса правится на месте, коммит по blur/Enter
function KeyField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
    const [text, setText] = useState(value);
    useEffect(() => setText(value), [value]);
    return (
        <input
            className="key"
            value={text}
            data-tip="Ключ"
            onChange={e => setText(e.target.value)}
            onBlur={() => { if (text !== value) onCommit(text); }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
    );
}

function ColorSwatch({ color, onChange, large }: { color: string; onChange: (c: string) => void; large?: boolean }) {
    return (
        <span className={`swatch${large ? ' lg' : ''}`} style={{ background: color }} data-tip="Цвет">
            <input type="color" value={/^#[0-9a-f]{6}$/i.test(color) ? color : NEW_COLOR} onChange={e => onChange(e.target.value)} />
        </span>
    );
}

// ── Классы по группам суперклассов; перетаскивание меняет суперкласс ──
function Classes({ value, onChange }: { value: NeuralConfig; onChange: (next: NeuralConfig) => void }) {
    const [selected, setSelected] = useState<string | null>(null);
    const [dragId, setDragId] = useState<string | null>(null);
    const [overGroup, setOverGroup] = useState<string | null>(null);

    const ids = Object.keys(value.classes).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    const superKeys = Object.keys(value.superclasses);
    // Ключ группы: реальный суперкласс либо '' для классов без него
    const groupOf = (id: string) => (value.superclasses[value.classes[id].superclass] ? value.classes[id].superclass : '');
    const groups = [...superKeys, ''].map(key => ({
        key,
        name: key ? value.superclasses[key].name || key : 'Без суперкласса',
        color: key ? value.superclasses[key].color : NO_SUPER_COLOR,
        ids: ids.filter(id => groupOf(id) === key),
    }));

    const patchClass = (id: string, p: Partial<ClassDef>) =>
        onChange({ ...value, classes: { ...value.classes, [id]: { ...value.classes[id], ...p } } });

    const addClass = (superclass: string) => {
        const nums = ids.map(Number).filter(n => !Number.isNaN(n));
        const nextId = String(nums.length ? Math.max(...nums) + 1 : 0);
        const color = superclass ? value.superclasses[superclass].color : NEW_COLOR;
        onChange({ ...value, classes: { ...value.classes, [nextId]: { name: '', server_id: '', superclass, color } } });
        setSelected(nextId);
    };

    const removeClass = (id: string) => {
        const classes = { ...value.classes };
        delete classes[id];
        onChange({ ...value, classes });
        if (selected === id) setSelected(null);
    };

    const drop = (key: string) => {
        if (dragId && groupOf(dragId) !== key) {
            const color = key ? value.superclasses[key].color : value.classes[dragId].color;
            patchClass(dragId, { superclass: key, color });
        }
        setDragId(null);
        setOverGroup(null);
    };

    return (
        <div className="nvb">
            <div className="blk-h">
                <h3>Классы модели</h3>
                <span className="eyebrow">{ids.length}</span>
                <span className="tag spacer"><Icon name="grip" size={12} />перетаскивание меняет суперкласс</span>
            </div>
            <div className="blk-b" style={{ gap: 16 }}>
                {groups.map(g => (
                    <div className="grp" key={g.key || '__none'}>
                        <div className="grp-h">
                            <span className="swatch" style={{ background: g.color }} />
                            <span className="eyebrow">{g.name}</span>
                            <span className="n">{g.ids.length}</span>
                            <button className="icon-btn" data-tip="Добавить класс" onClick={() => addClass(g.key)}><Icon name="plus" size={12} /></button>
                        </div>
                        <div
                            className={`drop${overGroup === g.key && dragId ? ' is-over' : ''}`}
                            onDragOver={e => { if (dragId) { e.preventDefault(); setOverGroup(g.key); } }}
                            onDragLeave={() => setOverGroup(cur => (cur === g.key ? null : cur))}
                            onDrop={e => { e.preventDefault(); drop(g.key); }}
                        >
                            {g.ids.length === 0 ? (
                                <div className="zero">Классов нет</div>
                            ) : (
                                <div className="cls-grid">
                                    {g.ids.map(id => {
                                        const c = value.classes[id];
                                        return (
                                            <ClassChip
                                                key={id}
                                                id={id}
                                                cls={c}
                                                selected={selected === id}
                                                dragging={dragId === id}
                                                onSelect={() => setSelected(sel => (sel === id ? null : id))}
                                                onDragStart={() => setDragId(id)}
                                                onDragEnd={() => { setDragId(null); setOverGroup(null); }}
                                                onPatch={p => patchClass(id, p)}
                                                onRemove={() => removeClass(id)}
                                            />
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

interface ClassChipProps {
    id: string;
    cls: ClassDef;
    selected: boolean;
    dragging: boolean;
    onSelect: () => void;
    onDragStart: () => void;
    onDragEnd: () => void;
    onPatch: (p: Partial<ClassDef>) => void;
    onRemove: () => void;
}

function ClassChip({ id, cls, selected, dragging, onSelect, onDragStart, onDragEnd, onPatch, onRemove }: ClassChipProps) {
    return (
        <>
            <button
                type="button"
                className={`cls${selected ? ' is-sel' : ''}${dragging ? ' is-drag' : ''}`}
                draggable
                onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
                onDragEnd={onDragEnd}
                onClick={onSelect}
            >
                <i className="sw-col" style={{ background: cls.color }} />
                <span className={`t${cls.name ? '' : ' is-empty'}`}>{cls.name || 'без названия'}</span>
                <span className="num">{id.padStart(2, '0')}</span>
            </button>
            {selected && (
                <div className="cls-edit">
                    <ColorSwatch large color={cls.color} onChange={color => onPatch({ color })} />
                    <div className="tf">
                        <span className="tf-cap">Название</span>
                        <input className="tf-in" value={cls.name} autoFocus onChange={e => onPatch({ name: e.target.value })} />
                    </div>
                    <div className="tf">
                        <span className="tf-cap">server_id</span>
                        <input className="tf-in" value={cls.server_id} onChange={e => onPatch({ server_id: e.target.value })} />
                    </div>
                    <div className="tf n">
                        <span className="tf-cap">id</span>
                        <input className="tf-in is-ro" value={id} readOnly />
                    </div>
                    <button className="icon-btn" data-tip="Удалить класс" onClick={onRemove}><Icon name="trash" size={14} /></button>
                </div>
            )}
        </>
    );
}
