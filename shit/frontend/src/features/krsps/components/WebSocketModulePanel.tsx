import React, { useEffect, useState } from 'react';
import { Icon } from '../../../app/Icons';
import { Switch } from '../../../app/Modal';
import type { GwModule, GwWsConfigPatch } from '../types';
import { formatInt, formatBytes } from '../utils/format';
import { Kpi, Pill, RecordRow } from './ModuleBits';
import { humanizeError } from '../utils/errors';

interface Props {
  module: GwModule;
  title: string;
  busy: boolean;
  onSave: (patch: GwWsConfigPatch) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

// Разбор адреса вида ws://host:port/target (схема и target опциональны)
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

// Тумблеры и период уходят запросом сразу; адрес — только кнопкой, он переподключает канал
const WebSocketModulePanel: React.FC<Props> = ({ module, title, busy, onSave, onConnect, onDisconnect }) => {
  const savedUrl = module.connection.url;
  // Начальные значения из статуса: иначе первый кадр считает адрес изменённым
  const [url, setUrl] = useState(savedUrl);
  const [heartbeat, setHeartbeat] = useState(String(module.heartbeat_sec));
  const [urlError, setUrlError] = useState('');

  const heartbeatOn = module.heartbeat_enabled ?? true;
  const enabled = module.connection.enabled;

  useEffect(() => {
    setUrl(savedUrl);
    setUrlError('');
  }, [savedUrl]);

  useEffect(() => {
    setHeartbeat(String(module.heartbeat_sec));
  }, [module.heartbeat_sec]);

  const dirty = url.trim() !== savedUrl;

  const applyUrl = () => {
    const parsed = parseWsUrl(url);
    if (!parsed) {
      setUrlError('Ожидается адрес вида ws://host:port/target');
      return;
    }
    setUrlError('');
    onSave({ host: parsed.host, port: parsed.port, target: parsed.target });
  };

  const commitHeartbeat = () => {
    const hb = parseInt(heartbeat, 10);
    if (!Number.isFinite(hb)) {
      setHeartbeat(String(module.heartbeat_sec));
      return;
    }
    if (hb !== module.heartbeat_sec) onSave({ heartbeat_sec: hb });
  };

  const stats = module.stats;
  const bytes = formatBytes(stats.bytes);
  const versions = module.protocol_versions?.length ? module.protocol_versions.map((v) => `v${v}`).join(', ') : '';

  return (
    <>
      <div className="mod-title">
        <h2>{title}</h2>
        <Pill module={module} />
        <span className="pill">{module.transport}{versions ? ` · ${versions}` : ''}</span>
        <button type="button" className="btn btn--ghost spacer" onClick={onDisconnect} disabled={busy}>Отключить</button>
        <button type="button" className="btn" onClick={onConnect} disabled={busy}>
          <Icon name="refresh" size={16} />Переподключить
        </button>
      </div>

      <div className="mod-rows">
        <div className="card">
          <div className="card-b">
            <div className="g-addr">
              <label className="cap" htmlFor="krsps-ws-url">Адрес WebSocket (БИУС)</label>
              <div className="line">
                <input
                  id="krsps-ws-url"
                  className={`inp inp--text${urlError ? ' is-err' : dirty ? ' is-dirty' : ''}`}
                  value={url}
                  spellCheck={false}
                  placeholder="ws://192.168.1.50:8080/ws/frames"
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && dirty) applyUrl();
                  }}
                />
                <button
                  type="button"
                  className={`icon-btn${dirty ? ' is-acc' : ''}`}
                  title="Подключиться по этому адресу"
                  aria-label="Подключиться по этому адресу"
                  disabled={busy || !dirty}
                  onClick={applyUrl}
                >
                  <Icon name="swap" size={18} />
                </button>
              </div>
              {urlError && <p className="hint is-err">{urlError}</p>}
            </div>
            <div className="g-row">
              <div className="fc">
                <span className="cap">Сообщение heartbeat</span>
                <div className="g-hb">
                  <Switch on={heartbeatOn} disabled={busy} onToggle={(v) => onSave({ heartbeat_enabled: v })}>{''}</Switch>
                  <span className="sep" />
                  <span className={heartbeatOn ? '' : 'off'}>каждые</span>
                  <input
                    id="krsps-ws-hb"
                    className="inp"
                    value={heartbeat}
                    inputMode="numeric"
                    disabled={!heartbeatOn || busy}
                    onChange={(e) => setHeartbeat(e.target.value.replace(/[^\d]/g, ''))}
                    onBlur={commitHeartbeat}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                  />
                  <span className={`unit${heartbeatOn ? '' : ' off'}`}>с при простое</span>
                </div>
              </div>
              <span className="vsep" />
              <div className="fc">
                <span className="cap">Передача обнаружений</span>
                <div className="g-hb">
                  <Switch on={enabled} disabled={busy} onToggle={(v) => onSave({ enabled: v })}>{enabled ? 'включена' : 'выключена'}</Switch>
                </div>
              </div>
            </div>
            {module.connection.error && (
              <div className="banner is-err" style={{ marginTop: 14 }}>
                <Icon name="warn" size={15} />
                Связь: {humanizeError(module.connection.error)}{module.connection.retrying ? ' · переподключение идёт' : ''}
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>Состояние</h3>
            <span className="meta">за сеанс · отклонено {formatInt(stats.rejected)} · heartbeat {formatInt(stats.heartbeats)}</span>
          </div>
          <div className="card-b">
            <div className="kpis">
              <Kpi label="Отдано" value={formatInt(stats.messages)} />
              <Kpi label="Обнаружений" value={formatInt(stats.detections)} />
              <Kpi label="Изображений" value={formatInt(stats.images)} />
              <Kpi label="Передано" value={bytes.value} unit={bytes.unit} />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>Последние сообщения</h3>
            <span className="meta">{stats.recent.length}</span>
          </div>
          <div className="card-b" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {stats.recent.length > 0 ? (
              stats.recent.map((r) => <RecordRow key={r.seq} r={r} sentNote="БИУС принял" />)
            ) : (
              <div className="empty"><b>Сообщений пока не было</b></div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default WebSocketModulePanel;
