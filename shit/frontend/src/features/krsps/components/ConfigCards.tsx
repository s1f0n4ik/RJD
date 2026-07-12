import React from 'react';
import { IconCheckCircle } from '../icons';
import type { GwIntegrations, GwIntegrationItem } from '../types';

interface Props {
  integrations: GwIntegrations | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onOpenModules: () => void;
}

const ConfigCard: React.FC<{
  item: GwIntegrationItem;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onOpenModules: () => void;
}> = ({ item, active, busy, onSelect, onOpenModules }) => (
  <div className={`krsps-cfg-card${active ? ' krsps-cfg-card--active' : ''}`}>
    <div className="krsps-cfg__top">
      <div>
        <div className="krsps-cfg__name">{item.title}</div>
        <div className="krsps-cfg__code">{item.id}</div>
      </div>
      {active ? (
        <span className="krsps-badge krsps-badge--on">
          <IconCheckCircle />Активна
        </span>
      ) : (
        <span className="krsps-badge krsps-badge--off">Доступна</span>
      )}
    </div>

    <div className="krsps-cfg__desc">{item.description || 'Конфигурация интеграции с АС КРСПС.'}</div>

    <div className="krsps-chips">
      {item.modules.length > 0 ? (
        item.modules.map((m) => (
          <span key={m.id} className="krsps-chip">
            <span className="krsps-chip__dot" />
            {m.title}
          </span>
        ))
      ) : (
        <span className="krsps-chip">без модулей</span>
      )}
    </div>

    <div className="krsps-cfg__foot">
      {active ? (
        <button type="button" className="krsps-btn krsps-btn--ghost krsps-btn--block" onClick={onOpenModules}>
          Настроить модули
        </button>
      ) : (
        <button
          type="button"
          className="krsps-btn krsps-btn--primary krsps-btn--block"
          onClick={onSelect}
          disabled={busy}
        >
          Сделать активной
        </button>
      )}
    </div>
  </div>
);

const ConfigCards: React.FC<Props> = ({ integrations, busy, onSelect, onOpenModules }) => {
  const items = integrations?.items ?? [];
  const activeId = integrations?.active;

  return (
    <div>
      <div>
        <div className="krsps-section__title">Конфигурации</div>
        <div className="krsps-section__sub">
          Конфигурация задаёт набор модулей и их настройки по умолчанию. Активная конфигурация обрабатывает кадры
          от других сервисов.
        </div>
      </div>

      <div className="krsps-cfg-grid">
        {items.map((it) => (
          <ConfigCard
            key={it.id}
            item={it}
            active={it.id === activeId}
            busy={busy}
            onSelect={() => onSelect(it.id)}
            onOpenModules={onOpenModules}
          />
        ))}
        {items.length === 0 && <div className="krsps-empty">Нет доступных конфигураций</div>}
      </div>
    </div>
  );
};

export default ConfigCards;
