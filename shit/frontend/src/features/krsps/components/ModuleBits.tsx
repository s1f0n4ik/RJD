import React, { useEffect, useState } from 'react';
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

// Отсчёт до следующей попытки идёт локально между опросами статуса
function useCountdown(retryInMs: number | undefined): number {
  const [tick, setTick] = useState(0);
  const [base] = useState(() => ({ at: 0, ms: 0 }));
  if (retryInMs !== undefined && retryInMs !== base.ms) {
    base.ms = retryInMs;
    base.at = Date.now();
  }
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  void tick;
  return Math.max(0, base.ms - (Date.now() - base.at));
}

// Пилюля состояния: соединено, попытка идёт, ожидание следующей попытки с отсчётом
export const Pill: React.FC<{ module: GwModule }> = ({ module }) => {
  const c = module.connection;
  const state = connState(module);
  const left = useCountdown(c.retry_in_ms);

  if (state === 'ok' || state === 'off' || !c.phase) {
    const active = state === 'wait' || (state === 'err' && !!c.retrying);
    return (
      <span className={`pill ${PILL_TONE[state]}`}>
        {active ? <span className="spin sm" /> : <span className="dot" />}
        {state === 'err' && c.retrying ? 'Нет связи · переподключение' : PILL_LABEL[state]}
      </span>
    );
  }

  const n = c.attempt && c.attempt > 0 ? c.attempt : 1;
  if (c.phase === 'connecting') {
    return (
      <span className={`pill ${PILL_TONE[state]}`}>
        <span className="spin sm" />
        {`Попытка ${n} · подключение`}
      </span>
    );
  }
  const sec = Math.ceil(left / 1000);
  return (
    <span className={`pill ${PILL_TONE[state]}`}>
      <span className="dot" />
      {sec > 0 ? `Нет связи · попытка ${n + 1} через ${sec} с` : `Нет связи · попытка ${n + 1}`}
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
  const heartbeat = r.kind === 'heartbeat';

  const kind = rejected ? 'err' : heartbeat ? 'hb' : 'ok';
  const glyph = rejected ? '✕' : heartbeat ? '♥' : '✓';

  const title = heartbeat
    ? 'heartbeat'
    : rejected
    ? `#${r.id} · отклонено`
    : `#${r.id} · ${r.detections} ${detWord(r.detections)}`;

  const ver = showVer ? ` · v${r.ver}` : '';
  const sub = rejected
    ? `${formatClock(r.ts)}${ver} · ${r.error ? humanizeError(r.error) : 'отклонено'}`
    : heartbeat
    ? `${formatClock(r.ts)}${ver} · служебное`
    : `${formatClock(r.ts)}${ver} · ${sentNote}`;

  return (
    <div className="rec">
      <span className={`ic ${kind}`}>{glyph}</span>
      <div className="t">
        <b>{title}</b>
        <span>{sub}</span>
      </div>
      <span className="sz">{rejected ? '—' : bytesShort(r.wire_size)}</span>
    </div>
  );
};
