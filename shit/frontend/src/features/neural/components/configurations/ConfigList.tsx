import type { ConfigSummary } from '../../api/types';

interface ConfigListProps {
  items: ConfigSummary[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
}

/** Левая колонка — список доступных конфигураций (GET /neural/configurations). */
export function ConfigList({ items, selectedId, loading, onSelect }: ConfigListProps) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-icon">▤</span>
        <span className="panel-title">Конфигурации · {items.length}</span>
      </div>
      {loading ? (
        <div className="spinner">загрузка…</div>
      ) : (
        <div className="config-list">
          {items.length === 0 && <span className="hint">список пуст</span>}
          {items.map((c) => (
            <button
              key={c.id}
              className={`config-list-item${c.id === selectedId ? ' active' : ''}`}
              onClick={() => onSelect(c.id)}
            >
              <div className="config-item-name">{c.name}</div>
              <div className="config-item-sub">{c.id}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
