import React, { useEffect, useRef, useState } from 'react';
import type { GwMessageRecord, GwModule } from '../types';
import { formatBytes, formatClock } from '../utils/format';
import { humanizeError } from '../utils/errors';

// Общие элементы разделов модуля: их одинаково рисуют и WebSocket, и CAN.

export type PillState = 'ok' | 'wait' | 'err' | 'off';

// Состояние подключения по флагам соединения: зелёный — связь есть, жёлтый —
// идёт попытка, красный — попытка сорвалась и канал переподключается, серый —
// модуль выключен.
export function connState(m: GwModule): PillState {
  if (m.connection.connected) return 'ok';
  if (!m.connection.enabled) return 'off';
  if (m.connection.error) return 'err';
  return 'wait';
}

const PILL_LABEL: Record<PillState, string> = {
  ok: 'Соединено',
  wait: 'Подключение',
  err: 'Нет связи',
  off: 'Выключено',
};

const PILL_TONE: Record<PillState, string> = { ok: 'ok', wait: 'warn', err: 'err', off: '' };

// Пилюля состояния: точка мягко пульсирует, пока связи нет; ожидание красное, попытка жёлтая.
// Сама попытка длится миллисекунды и в опрос раз в 2 с не попадает, поэтому жёлтый держится
// 2 с после каждого прироста номера попытки.
const FLASH_MS = 2200;

export const Pill: React.FC<{ module: GwModule }> = ({ module }) => {
  const c = module.connection;
  const state = connState(module);
  const [flash, setFlash] = useState(false);
  const prevAttempt = useRef<number | undefined>(undefined);

  useEffect(() => {
    const a = c.attempt;
    const bumped = a !== undefined && prevAttempt.current !== undefined && a !== prevAttempt.current && !c.connected;
    prevAttempt.current = a;
    if (!bumped) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), FLASH_MS);
    return () => clearTimeout(t);
  }, [c.attempt, c.connected]);

  if (state === 'ok' || state === 'off') {
    return (
      <span className={`pill ${PILL_TONE[state]}`}>
        <span className="dot" />
        {PILL_LABEL[state]}
      </span>
    );
  }

  const connecting = c.phase ? c.phase === 'connecting' || flash : state === 'wait';
  return (
    <span className={`pill ${connecting ? 'warn' : 'err'}`}>
      <span className="dot is-pulse" />
      {connecting ? 'Переподключение' : 'Нет связи'}
    </span>
  );
};

export const Kpi: React.FC<{ label: string; value: string; unit?: string }> = ({ label, value, unit }) => (
  <div className="kpi">
    <span>{label}</span>
    <b>
      {value}
      {unit && <small>{unit}</small>}
    </b>
  </div>
);

export function detWord(n: number): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'обнаружений';
  if (b > 1 && b < 5) return 'обнаружения';
  if (b === 1) return 'обнаружение';
  return 'обнаружений';
}

export function bytesShort(n: number): string {
  const { value, unit } = formatBytes(n);
  return `${value} ${unit}`;
}

interface RecordRowProps {
  r: GwMessageRecord;
  // Что означает успешная отправка для этого транспорта
  sentNote: string;
  // Версию протокола показываем только там, где она есть (WebSocket)
  showVer?: boolean;
}

export const RecordRow: React.FC<RecordRowProps> = ({ r, sentNote, showVer = true }) => {
  const rejected = r.status === 'rejected';
  const undelivered = r.status === 'undelivered';
  const heartbeat = r.kind === 'heartbeat';
  // Склеенные подряд идущие кадры с одной причиной: показываем кратность.
  const repeats = (r.count ?? 1) > 1 ? [`×${r.count}`] : [];

  const kind = rejected ? 'err' : undelivered ? 'wrn' : heartbeat ? 'hb' : 'ok';
  const glyph = rejected ? '✕' : undelivered ? '!' : heartbeat ? '♥' : '✓';

  const title = heartbeat
    ? ['heartbeat']
    : rejected
    ? [`#${r.id}`, 'отклонено']
    : [`#${r.id}`, `${r.detections} ${detWord(r.detections)}`, ...repeats];

  const note = heartbeat
    ? ['служебное']
    : rejected
    ? [r.error ? humanizeError(r.error) : 'отклонено']
    : undelivered
    ? ['не доставлено', humanizeError(r.error) || 'причина не указана']
    : [sentNote];
  const sub = [formatClock(r.ts), ...(showVer ? [`v${r.ver}`] : []), ...note];

  return (
    <div className="rec">
      <span className={`ic ${kind}`}>{glyph}</span>
      <div className="t">
        <b>
          <span className="seps">
            {title.map((p, i) => (
              <span key={i}>{p}</span>
            ))}
          </span>
        </b>
        <span>
          <span className="seps">
            {sub.map((p, i) => (
              <span key={i}>{p}</span>
            ))}
          </span>
        </span>
      </div>
      <span className="sz">{rejected || undelivered ? '—' : bytesShort(r.wire_size)}</span>
    </div>
  );
};
