import { useState } from 'react';
import type { SuperclassDef } from '../../api/types';
import { ColorPicker } from '../common/ColorPicker';

interface SuperclassPaletteProps {
  superclasses: Record<string, SuperclassDef>;
  editing: boolean;
  onChange: (key: string, patch: Partial<SuperclassDef>) => void;
  onRenameKey: (oldKey: string, newKey: string) => void;
  onAdd: () => string;
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
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const keys = Object.keys(superclasses);

  // Добавление сразу создаёт строку с дефолтным ключом — правим её inline.
  function handleAdd() {
    setJustAdded(onAdd());
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
          <button className="pal-add" onClick={handleAdd}>+ добавить суперкласс</button>
          <div className="row-list">
            {keys.length === 0 && <span className="hint">суперклассов пока нет — добавьте первый</span>}
            {keys.map((key) => (
              <SuperRow
                key={key}
                k={key}
                def={superclasses[key]}
                autoFocus={key === justAdded}
                exists={(candidate) => candidate !== key && candidate in superclasses}
                onColor={(color) => onChange(key, { color })}
                onName={(name) => onChange(key, { name })}
                onRename={(next) => onRenameKey(key, next)}
                onRemove={() => onRemove(key)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface SuperRowProps {
  k: string;
  def: SuperclassDef;
  autoFocus?: boolean;
  exists: (candidate: string) => boolean;
  onColor: (c: string) => void;
  onName: (n: string) => void;
  onRename: (next: string) => void;
  onRemove: () => void;
}

/** Строка суперкласса. Ключ редактируется с коммитом по blur/Enter, чтобы
 *  промежуточные значения не ломали ссылки в классах. */
function SuperRow({ k, def, autoFocus, exists, onColor, onName, onRename, onRemove }: SuperRowProps) {
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
        autoFocus={autoFocus}
        onFocus={(e) => e.target.select()}
        value={keyBuf}
        onChange={(e) => setKeyBuf(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setKeyBuf(k);
        }}
      />
      <ColorPicker value={def.color} onChange={onColor} title={`Цвет суперкласса ${k}`} />
      <input className="row-input" placeholder="название" value={def.name} onChange={(e) => onName(e.target.value)} />
      <button className="row-del" title="Удалить" onClick={onRemove}>✕</button>
    </div>
  );
}