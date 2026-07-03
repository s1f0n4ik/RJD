import { useState } from 'react';
import type { SuperclassDef } from '../../api/types';

interface SuperclassPaletteProps {
  superclasses: Record<string, SuperclassDef>;
  editing: boolean;
  onChange: (key: string, patch: Partial<SuperclassDef>) => void;
  onRenameKey: (oldKey: string, newKey: string) => void;
  onAdd: (key: string) => void;
  onRemove: (key: string) => void;
}

/** Палитра суперклассов: теги в просмотре, строки-редакторы в правке. */
export function SuperclassPalette({
  superclasses,
  editing,
  onChange,
  onRenameKey,
  onAdd,
  onRemove,
}: SuperclassPaletteProps) {
  const [newKey, setNewKey] = useState('');
  const keys = Object.keys(superclasses);

  function add() {
    const key = newKey.trim();
    if (!key || superclasses[key]) return;
    onAdd(key);
    setNewKey('');
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-icon">◆</span>
        <span className="panel-title">Суперклассы · {keys.length}</span>
      </div>

      {!editing ? (
        <div className="swatch-grid">
          {keys.length === 0 && <span className="hint">нет суперклассов</span>}
          {keys.map((key) => (
            <div className="class-tag" key={key}>
              <span className="row-tag">id: {key}</span>
              <span className="class-swatch" style={{ background: superclasses[key].color }} />
              <span className="class-name">{superclasses[key].name}</span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="row-list">
            {keys.map((key) => (
              <SuperRow
                key={key}
                k={key}
                def={superclasses[key]}
                exists={(candidate) => candidate !== key && candidate in superclasses}
                onColor={(color) => onChange(key, { color })}
                onName={(name) => onChange(key, { name })}
                onRename={(next) => onRenameKey(key, next)}
                onRemove={() => onRemove(key)}
              />
            ))}
          </div>
          <div className="add-row">
            <input
              className="row-input"
              placeholder="ключ (human, animal…)"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              style={{ maxWidth: 240 }}
            />
            <button className="btn btn-ghost btn-sm" onClick={add}>+ суперкласс</button>
          </div>
        </>
      )}
    </div>
  );
}

interface SuperRowProps {
  k: string;
  def: SuperclassDef;
  exists: (candidate: string) => boolean;
  onColor: (c: string) => void;
  onName: (n: string) => void;
  onRename: (next: string) => void;
  onRemove: () => void;
}

/** Строка суперкласса. Ключ редактируется с коммитом по blur/Enter, чтобы
 *  промежуточные значения не ломали ссылки в классах. */
function SuperRow({ k, def, exists, onColor, onName, onRename, onRemove }: SuperRowProps) {
  const [keyBuf, setKeyBuf] = useState(k);

  function commit() {
    const next = keyBuf.trim();
    if (!next || next === k || exists(next)) {
      setKeyBuf(k); // откат недопустимого
      return;
    }
    onRename(next);
  }

  return (
    <div className="row-item super">
      <span className="row-tag">id:</span>
      <input
        className="row-input key"
        title="id суперкласса"
        value={keyBuf}
        onChange={(e) => setKeyBuf(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setKeyBuf(k);
        }}
      />
      <label className="row-swatch" style={{ background: def.color }}>
        <input type="color" value={hex(def.color)} onChange={(e) => onColor(e.target.value)} />
      </label>
      <input className="row-input" placeholder="название" value={def.name} onChange={(e) => onName(e.target.value)} />
      <button className="row-del" title="Удалить" onClick={onRemove}>✕</button>
    </div>
  );
}

function hex(c: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#888888';
}