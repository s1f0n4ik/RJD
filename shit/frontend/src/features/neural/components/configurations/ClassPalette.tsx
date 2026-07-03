import { useMemo, useState } from 'react';
import type { ClassDef, SuperclassDef } from '../../api/types';

interface ClassPaletteProps {
    classes: Record<string, ClassDef>;
    superclasses: Record<string, SuperclassDef>;
    editing: boolean;
    onChange: (id: string, patch: Partial<ClassDef>) => void;
    onAdd: () => void;
    onRemove: (id: string) => void;
}

/** Палитра классов: фильтр по суперклассу; теги в просмотре, строки-редакторы в правке. */
export function ClassPalette({ classes, superclasses, editing, onChange, onAdd, onRemove }: ClassPaletteProps) {
    const [filter, setFilter] = useState<string>('all');

    const ids = useMemo(
        () => Object.keys(classes).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)),
        [classes],
    );
    const superKeys = Object.keys(superclasses);
    const visible = filter === 'all' ? ids : ids.filter((id) => classes[id].superclass === filter);

    return (
        <div className="panel">
            <div className="panel-header">
                <span className="panel-icon">◇</span>
                <span className="panel-title">Классы · {ids.length}</span>
                <div className="btn-row">
                    <button
                        className={`btn btn-sm ${filter === 'all' ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => setFilter('all')}
                    >
                        все
                    </button>
                    {superKeys.map((key) => (
                        <button
                            key={key}
                            className={`btn btn-sm ${filter === key ? 'btn-primary' : 'btn-ghost'}`}
                            onClick={() => setFilter(key)}
                        >
                            {key}
                        </button>
                    ))}
                </div>
            </div>

            {!editing ? (
                <div className="swatch-grid">
                    {visible.length === 0 && <span className="hint">пусто</span>}
                    {visible.map((id) => {
                        const c = classes[id];
                        const sup = c.superclass ? superclasses[c.superclass] : undefined;
                        return (
                            <div className="class-tag" key={id}>
                                <span className="row-tag">id: {id}</span>
                                <span className="class-swatch" style={{ background: c.color }} />
                                <span className="class-name">{c.name}</span>
                                {sup && (
                                    <span
                                        className="super-chip"
                                        style={{ color: sup.color, background: rgba(sup.color, 0.16), borderColor: rgba(sup.color, 0.45) }}
                                    >
                    {sup.name || c.superclass}
                  </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            ) : (
                <>
                    <div className="row-list">
                        {visible.map((id) => (
                            <div className="row-item cls" key={id}>
                                <span className="row-tag" title={`server_id: ${classes[id].server_id || '—'}`}>id: {id}</span>
                                <label className="row-swatch" style={{ background: classes[id].color }}>
                                    <input
                                        type="color"
                                        value={hex(classes[id].color)}
                                        onChange={(e) => onChange(id, { color: e.target.value })}
                                    />
                                </label>
                                <input
                                    className="row-input"
                                    value={classes[id].name}
                                    onChange={(e) => onChange(id, { name: e.target.value })}
                                />
                                <select
                                    className="row-select"
                                    value={classes[id].superclass}
                                    onChange={(e) => onChange(id, { superclass: e.target.value })}
                                >
                                    <option value="">— без категории —</option>
                                    {superKeys.map((key) => (
                                        <option key={key} value={key}>{superclasses[key].name || key}</option>
                                    ))}
                                </select>
                                <button className="row-del" title="Удалить" onClick={() => onRemove(id)}>✕</button>
                            </div>
                        ))}
                    </div>
                    <div className="add-row">
                        <button className="btn btn-ghost btn-sm" onClick={onAdd}>+ класс</button>
                    </div>
                </>
            )}
        </div>
    );
}

function hex(c: string): string {
    return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#888888';
}

/** hex → rgba с заданной прозрачностью (для цветных тегов суперкласса). */
function rgba(c: string, a: number): string {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(c);
    if (!m) return `rgba(136,136,136,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}