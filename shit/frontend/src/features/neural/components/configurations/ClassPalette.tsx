import { useMemo, useState } from 'react';
import type { ClassDef, SuperclassDef } from '../../api/types';
import { ColorPicker } from '../common/ColorPicker';

interface ClassPaletteProps {
    classes: Record<string, ClassDef>;
    superclasses: Record<string, SuperclassDef>;
    editing: boolean;
    onChange: (id: string, patch: Partial<ClassDef>) => void;
    onAdd: (superclass: string) => string;
    onRemove: (id: string) => void;
}

interface Group {
    key: string;
    color: string;
    name: string;
    ids: string[];
}

/** Палитра классов: группировка по суперклассу. В просмотре — цветные карточки,
 *  в правке — строки внутри секций; категория задаётся принадлежностью к группе,
 *  сменить её можно перетаскиванием строки за ручку в другую группу. */
export function ClassPalette({ classes, superclasses, editing, onChange, onAdd, onRemove }: ClassPaletteProps) {
    const [filter, setFilter] = useState<string>('all');
    const [justAdded, setJustAdded] = useState<string | null>(null);
    const [dragId, setDragId] = useState<string | null>(null);
    const [overGroup, setOverGroup] = useState<string | null>(null);

    const ids = useMemo(
        () => Object.keys(classes).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)),
        [classes],
    );
    const superKeys = Object.keys(superclasses);
    const visible = filter === 'all' ? ids : ids.filter((id) => classes[id].superclass === filter);

    // Ключ группы класса: реальный суперкласс либо '' (без категории / удалённый).
    const groupOf = (id: string) => (superclasses[classes[id].superclass] ? classes[id].superclass : '');
    const meta = (key: string) => ({
        color: key && superclasses[key] ? superclasses[key].color : '#667089',
        name: key && superclasses[key] ? superclasses[key].name || key : 'Без категории',
    });

    // Просмотр: только непустые группы, '' — в конце.
    const viewGroups: Group[] = [...superKeys, '']
        .map((key) => ({ key, ...meta(key), ids: visible.filter((id) => groupOf(id) === key) }))
        .filter((g) => g.ids.length > 0);

    // Правка: все секции суперклассов (даже пустые) + «Без категории» всегда — чтобы
    // в любую можно было добавить класс и перетащить в неё существующий.
    const editGroups: Group[] = [...superKeys, ''].map((key) => ({
        key,
        ...meta(key),
        ids: ids.filter((id) => groupOf(id) === key),
    }));

    // В группе только что добавленный класс — первым, остальные по возрастанию id.
    const ordered = (arr: string[]) =>
        justAdded && arr.includes(justAdded) ? [justAdded, ...arr.filter((id) => id !== justAdded)] : arr;

    return (
        <div className="panel">
            <div className="panel-header">
                <span className="panel-icon">◇</span>
                <span className="panel-title">Классы · {ids.length}</span>
                {!editing && (
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
                )}
            </div>

            {!editing ? (
                <div className="cls-view">
                    {viewGroups.length === 0 && <span className="hint">пусто</span>}
                    {viewGroups.map((g) => (
                        <div className="cls-group" key={g.key || '_none'}>
                            <div className="cls-group-head">
                                <span className="cls-group-dot" style={{ background: g.color }} />
                                <span className="cls-group-name">{g.name}</span>
                                <span className="cls-group-count">{g.ids.length}</span>
                                <span className="cls-group-rule" />
                            </div>
                            <div className="cls-grid">
                                {g.ids.map((id) => {
                                    const c = classes[id];
                                    return (
                                        <div
                                            className="cls-card"
                                            key={id}
                                            style={{
                                                borderLeftColor: c.color,
                                                background: `linear-gradient(90deg, ${rgba(c.color, 0.14)}, ${rgba(c.color, 0.03)} 60%, transparent)`,
                                            }}
                                        >
                                            <span className="cls-card-sw" style={{ background: c.color }} />
                                            <span className="cls-card-name">{c.name}</span>
                                            <span className="row-tag">id {id}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="cls-edit">
                    {editGroups.map((g) => (
                        <div
                            className={`cls-edit-group${dragId && overGroup === g.key ? ' drop-over' : ''}`}
                            key={g.key || '_none'}
                            onDragOver={(e) => {
                                if (!dragId) return;
                                e.preventDefault();
                                e.dataTransfer.dropEffect = 'move';
                                if (overGroup !== g.key) setOverGroup(g.key);
                            }}
                            onDrop={(e) => {
                                e.preventDefault();
                                if (dragId && groupOf(dragId) !== g.key) onChange(dragId, { superclass: g.key });
                                setDragId(null);
                                setOverGroup(null);
                            }}
                        >
                            <div className="cls-group-head">
                                <span className="cls-group-dot" style={{ background: g.color }} />
                                <span className="cls-group-name">{g.name}</span>
                                <span className="cls-group-count">{g.ids.length}</span>
                                <span className="cls-group-rule" />
                            </div>

                            <div className="cls-edit-rows">
                                {ordered(g.ids).map((id) => (
                                    <div className="row-item cls-d" key={id}>
                                        <span
                                            className="row-grip"
                                            draggable
                                            title="Перетащите в другую категорию"
                                            onDragStart={(e) => {
                                                const row = (e.currentTarget as HTMLElement).closest('.row-item');
                                                if (row) e.dataTransfer.setDragImage(row, 20, 18);
                                                e.dataTransfer.effectAllowed = 'move';
                                                e.dataTransfer.setData('text/plain', id);
                                                setDragId(id);
                                            }}
                                            onDragEnd={() => {
                                                setDragId(null);
                                                setOverGroup(null);
                                            }}
                                        >
                                            ⠿
                                        </span>
                                        <span className="row-tag" title={`server_id: ${classes[id].server_id || '—'}`}>id: {id}</span>
                                        <ColorPicker
                                            value={classes[id].color}
                                            onChange={(color) => onChange(id, { color })}
                                            title={`Цвет класса ${id}`}
                                        />
                                        <input
                                            className="row-input"
                                            placeholder="название класса"
                                            autoFocus={id === justAdded}
                                            onFocus={(e) => e.target.select()}
                                            value={classes[id].name}
                                            onChange={(e) => onChange(id, { name: e.target.value })}
                                        />
                                        <button className="row-del" title="Удалить" onClick={() => onRemove(id)}>✕</button>
                                    </div>
                                ))}
                            </div>

                            <button className="cls-add-group" onClick={() => setJustAdded(onAdd(g.key))}>
                                {g.key ? `+ класс в «${g.name}»` : '+ класс без категории'}
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/** hex → rgba с заданной прозрачностью. */
function rgba(c: string, a: number): string {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(c);
    if (!m) return `rgba(136,136,136,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
