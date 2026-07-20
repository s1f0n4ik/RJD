import React, { useEffect, useState } from 'react';
import type { GwModule, GwWsConfigPatch } from '../types';
import { formatInt, formatBytes } from '../utils/format';
import { IconRefresh } from '../icons';
import { Kpi, Pill, RecordRow, connState } from './ModuleBits';

interface Props {
  module: GwModule;
  busy: boolean;
  onSave: (patch: GwWsConfigPatch) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

// Разбор адреса вида ws://host:port/target (схема и target опциональны).
function parseWsUrl(raw: string): { host: string; port: string; target: string } | null {
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^wss?:\/\//i, '');
  const slash = s.indexOf('/');
  const target = slash >= 0 ? s.slice(slash) : '/ws/frames';
  const hostPort = slash >= 0 ? s.slice(0, slash) : s;
  const colon = hostPort.lastIndexOf(':');
  if (colon < 0) return null;
  const host = hostPort.slice(0, colon);
  const port = hostPort.slice(colon + 1);
  if (!host || !/^\d+$/.test(port)) return null;
  return { host, port, target };
}

const WebSocketModulePanel: React.FC<Props> = ({ module, busy, onSave, onConnect, onDisconnect }) => {
  const [url, setUrl] = useState('');
  const [heartbeat, setHeartbeat] = useState('5');
  const [enabled, setEnabled] = useState(true);
  const [urlError, setUrlError] = useState('');

  useEffect(() => {
    setUrl(module.connection.url);
    setHeartbeat(String(module.heartbeat_sec));
    setEnabled(module.connection.enabled);
  }, [module.connection.url, module.heartbeat_sec, module.connection.enabled]);

  const handleSave = () => {
    const parsed = parseWsUrl(url);
    if (!parsed) {
      setUrlError('Ожидается адрес вида ws://host:port/target');
      return;
    }
    setUrlError('');
    const hb = parseInt(heartbeat, 10);
    onSave({
      host: parsed.host,
      port: parsed.port,
      target: parsed.target,
      enabled,
      heartbeat_sec: Number.isFinite(hb) ? hb : undefined,
    });
  };

  const stats = module.stats;
  const bytes = formatBytes(stats.bytes);

  return (
    <div>
      {/*<div className="krsps-module__head">
        <div className="krsps-module__title">WebSocket → КАУС</div>
        <Pill state={connState(module)} />
        <div className="krsps-module__meta">
          протокол {module.protocol_versions.map((v) => `v${v}`).join(', ') || '—'}
        </div>
      </div>*/}

      {/* Настройки: поля в гриде + серый футер действий — как в разделе CAN. */}
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Настройки передачи</div>
          <div className="krsps-panel__meta">{module.connection.url || '—'}</div>
          <button
            type="button"
            className="krsps-icon-btn"
            title="Переподключить"
            aria-label="Переподключить"
            onClick={onConnect}
            disabled={busy}
          >
            <IconRefresh />
          </button>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-formgrid">
            <div className="krsps-field krsps-formgrid__wide">
              <label className="krsps-field__label" htmlFor="krsps-ws-url">
                Адрес WebSocket (КАУС)
              </label>
              <input
                id="krsps-ws-url"
                className={`krsps-input${urlError ? ' krsps-input--error' : ''}`}
                value={url}
                spellCheck={false}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="ws://192.168.1.50:8080/ws/frames"
              />
              <div className={`krsps-field__hint${urlError ? ' krsps-field__hint--error' : ''}`}>
                {urlError || 'Можно менять как угодно'}
              </div>
            </div>

            <div className="krsps-field">
              <label className="krsps-field__label" htmlFor="krsps-ws-hb">
                Сообщение heartbeat, с
              </label>
              <input
                id="krsps-ws-hb"
                className="krsps-input krsps-input--sm"
                value={heartbeat}
                inputMode="numeric"
                onChange={(e) => setHeartbeat(e.target.value.replace(/[^\d]/g, ''))}
              />
            </div>
          </div>
        </div>

        <div className="krsps-formfoot">
          <button
            type="button"
            className={`krsps-switch${enabled ? ' krsps-switch--on' : ''}`}
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled((v) => !v)}
          >
            <span className="krsps-switch__track" />
            Передача обнаружений включена
          </button>

          <div className="krsps-actions">
            <button type="button" className="krsps-btn krsps-btn--primary" onClick={handleSave} disabled={busy}>
              Сохранить
            </button>
            <button type="button" className="krsps-btn krsps-btn--text" onClick={onDisconnect} disabled={busy}>
              Отключить
            </button>
          </div>
        </div>
      </div>

      {/* Состояние — единым блоком: счётчики + лента сообщений. */}
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Состояние</div>
          <div className="krsps-panel__meta">
            отклонено {formatInt(stats.rejected)} · heartbeat {formatInt(stats.heartbeats)}
          </div>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-kpis">
            <Kpi label="Отдано" value={formatInt(stats.messages)} />
            <Kpi label="Обнаружений" value={formatInt(stats.detections)} />
            <Kpi label="Изображений" value={formatInt(stats.images)} />
            <Kpi label="Передано" value={bytes.value} unit={bytes.unit} />
          </div>

          <div className="krsps-feed__label">Последние сообщения · {stats.recent.length}</div>
          {stats.recent.length > 0 ? (
            <div className="krsps-feed">
              {stats.recent.map((r) => (
                <RecordRow key={r.seq} r={r} sentNote="КАУС принял" />
              ))}
            </div>
          ) : (
            <div className="krsps-empty">Сообщений пока не было</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default WebSocketModulePanel;
