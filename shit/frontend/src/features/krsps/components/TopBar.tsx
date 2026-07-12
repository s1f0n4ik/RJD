import React from 'react';
import { IconTune, IconBack } from '../icons';

export type KrspsView = 'modules' | 'configs';

interface Props {
  configTitle: string;
  view: KrspsView;
  onOpenConfigs: () => void;
  onBackToModules: () => void;
}

const TopBar: React.FC<Props> = ({ configTitle, view, onOpenConfigs, onBackToModules }) => (
  <div className="krsps-topbar">
    <div className="krsps-brand">
      <div className="krsps-mark">КР</div>
      <div>
        <div className="krsps-brand__title">АС КРСПС</div>
        <div className="krsps-brand__sub">Шлюз сообщений</div>
      </div>
    </div>

    {/* Активная конфигурация — единственный красный акцент в хедере. */}
    <button type="button" className="krsps-config-chip" onClick={onOpenConfigs}>
      <span className="krsps-config-chip__dot" />
      <span className="krsps-config-chip__label">Конфигурация:</span>
      <span className="krsps-config-chip__value">{configTitle}</span>
    </button>

    <div className="krsps-topbar__spacer" />
    <div className="krsps-nav">
      {view === 'configs' ? (
        <button type="button" className="krsps-navlink" onClick={onBackToModules}>
          <IconBack />К модулям
        </button>
      ) : (
        <button type="button" className="krsps-navlink" onClick={onOpenConfigs}>
          <IconTune />Конфигурации
        </button>
      )}
      <button type="button" className="krsps-navlink" onClick={() => { window.location.href = '/app'; }}>
        На главную
      </button>
    </div>
  </div>
);

export default TopBar;
