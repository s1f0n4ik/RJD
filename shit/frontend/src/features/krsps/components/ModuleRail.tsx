import React from 'react';
import { IconSwap, IconPlug, IconClock } from '../icons';
import type { GwModule } from '../types';

export const TIME_SECTION = 'time';

interface Props {
  modules: GwModule[];
  selected: string;
  onSelect: (id: string) => void;
}

function moduleIcon(transport: string) {
  return transport === 'websocket' ? <IconSwap /> : <IconPlug />;
}

const ModuleRail: React.FC<Props> = ({ modules, selected, onSelect }) => (
  <nav className="krsps-rail">
    <div className="krsps-rail__label">Модули конфигурации</div>
    {modules.map((m) => (
      <button
        key={m.id}
        type="button"
        className={`krsps-rail__item${selected === m.id ? ' krsps-rail__item--active' : ''}`}
        onClick={() => onSelect(m.id)}
      >
        {moduleIcon(m.transport)}
        <span className="krsps-rail__grow">{m.title}</span>
        <span className={`krsps-rail__dot${m.connection.connected ? ' krsps-rail__dot--ok' : ''}`} />
      </button>
    ))}
    {modules.length === 0 && <div className="krsps-rail__empty">В конфигурации нет модулей</div>}

    <div className="krsps-rail__sep" />

    <div className="krsps-rail__label">Сервис</div>
    <button
      type="button"
      className={`krsps-rail__item${selected === TIME_SECTION ? ' krsps-rail__item--active' : ''}`}
      onClick={() => onSelect(TIME_SECTION)}
    >
      <IconClock />
      <span className="krsps-rail__grow">Время и GPS</span>
    </button>
  </nav>
);

export default ModuleRail;
