import React, { useEffect, useState } from 'react';
import { IconCheck, IconClose, IconHeart } from '../icons';
import type { GwModule, GwMessageRecord, GwWsConfigPatch } from '../types';
import { formatInt, formatBytes, formatClock } from '../utils/format';

interface Props {
  module: GwModule;
  busy: boolean;
  onSave: (patch: GwWsConfigPatch) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

type PillState = 'ok' | 'wait' | 'off';

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

function connState(m: GwModule): PillState {
  if (m.connection.connected) return 'ok';
  if (m.connection.enabled) return 'wait';
  return 'off';
}

const PILL_LABEL: Record<PillState, string> = { ok: 'Соединено', wait: 'Подключение', off: 'Нет связи' };

const Pill: React.FC<{ state: PillState }> = ({ state }) => (
  <span className={`krsps-pill krsps-pill--${state}`}>
    <span className="krsps-pill__dot" />
    {PILL_LABEL[state]}
  </span>
);

const Kpi: React.FC<{ label: string; value: string; unit?: string }> = ({ label, value, unit }) => (
  <div className="krsps-kpi">
    <div className="krsps-kpi__label">{label}</div>
    <div className="krsps-kpi__value">
      {value}
      {unit && <span className="krsps-kpi__unit">{unit}</span>}
    </div>
  </div>
);

function detWord(n: number): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'обнаружений';
  if (b > 1 && b < 5) return 'обнаружения';
  if (b === 1) return 'обнаружение';
  return 'обнаружений';
}

function bytesShort(n: number): string {
  const { value, unit } = formatBytes(n);
  return `${value} ${unit}`;
}

const RecordRow: React.FC<{ r: GwMessageRecord }> = ({ r }) => {
  const rejected = r.status === 'rejected';
  const heartbeat = r.kind === 'heartbeat';

  const kind = rejected ? 'err' : heartbeat ? 'hb' : 'ok';
  const icon = rejected ? <IconClose /> : heartbeat ? <IconHeart /> : <IconCheck />;

  const title = heartbeat
    ? 'heartbeat'
    : rejected
    ? `#${r.id} · отклонено`
    : `#${r.id} · ${r.detections} ${detWord(r.detections)}`;

  const sub = rejected
    ? `${formatClock(r.ts)} · v${r.ver} · ${r.error ?? 'отклонено'}`
    : heartbeat
    ? `${formatClock(r.ts)} · v${r.ver} · служебное`
    : `${formatClock(r.ts)} · v${r.ver} · КАУС принял`;

  return (
    <div className="krsps-feed__row">
      <div className={`krsps-feed__ico krsps-feed__ico--${kind}`}>{icon}</div>
      <div className="krsps-feed__main">
        <div className="krsps-feed__title">{title}</div>
        <div className="krsps-feed__sub">{sub}</div>
      </div>
      <div className="krsps-feed__size">{rejected ? '—' : bytesShort(r.wire_size)}</div>
    </div>
  );
};

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
      <div className="krsps-module__head">
        <div className="krsps-module__title">WebSocket → КАУС</div>
        <Pill state={connState(module)} />
        <div className="krsps-module__meta">
          протокол {module.protocol_versions.map((v) => `v${v}`).join(', ') || '—'}
        </div>
      </div>

      {/* Настройки — целой строкой. */}
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Настройки передачи</div>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-form">
            <div className="krsps-field krsps-field--grow">
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

            <div className="krsps-form__row">
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
                <button type="button" className="krsps-btn krsps-btn--ghost" onClick={onConnect} disabled={busy}>
                  Переподключить
                </button>
                <button type="button" className="krsps-btn krsps-btn--text" onClick={onDisconnect} disabled={busy}>
                  Отключить
                </button>
              </div>
            </div>
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
                <RecordRow key={r.seq} r={r} />
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
