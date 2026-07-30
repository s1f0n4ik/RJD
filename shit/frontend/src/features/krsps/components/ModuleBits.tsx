import React from 'react';
import { IconCheck, IconClose, IconHeart } from '../icons';
import type { GwMessageRecord, GwModule } from '../types';
import { formatBytes, formatClock } from '../utils/format';

// Общие элементы разделов модуля: их одинаково рисуют и WebSocket, и CAN.
// Лежат отдельно, чтобы состояние соединения и лента сообщений выглядели и
// вели себя одинаково во всех модулях.

export type PillState = 'ok' | 'wait' | 'err' | 'off';

// Состояние подключения по флагам соединения. Общий для WebSocket и CAN, чтобы
// оба модуля подсвечивались одинаково: зелёный — связь есть, жёлтый — первая
// попытка идёт, красный — попытка сорвалась (таймаут/ошибка) и канал
// переподключается, серый — модуль выключен.
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

export const Pill: React.FC<{ state: PillState }> = ({ state }) => (
  <span className={`krsps-pill krsps-pill--${state}`}>
    <span className="krsps-pill__dot" />
    {PILL_LABEL[state]}
  </span>
);

export const Kpi: React.FC<{ label: string; value: string; unit?: string }> = ({ label, value, unit }) => (
  <div className="krsps-kpi">
    <div className="krsps-kpi__label">{label}</div>
    <div className="krsps-kpi__value">
      {value}
      {unit && <span className="krsps-kpi__unit">{unit}</span>}
    </div>
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
  // Что означает успешная отправка для этого транспорта: БИУС принял кадр либо
  // нагрузка ушла на шину.
  sentNote: string;
  // Версию протокола показываем только там, где она есть (WebSocket).
  showVer?: boolean;
}

export const RecordRow: React.FC<RecordRowProps> = ({ r, sentNote, showVer = true }) => {
  const rejected = r.status === 'rejected';
  const heartbeat = r.kind === 'heartbeat';

  const kind = rejected ? 'err' : heartbeat ? 'hb' : 'ok';
  const icon = rejected ? <IconClose /> : heartbeat ? <IconHeart /> : <IconCheck />;

  const title = heartbeat
    ? 'heartbeat'
    : rejected
    ? `#${r.id} · отклонено`
    : `#${r.id} · ${r.detections} ${detWord(r.detections)}`;

  const ver = showVer ? ` · v${r.ver}` : '';
  const sub = rejected
    ? `${formatClock(r.ts)}${ver} · ${r.error ?? 'отклонено'}`
    : heartbeat
    ? `${formatClock(r.ts)}${ver} · служебное`
    : `${formatClock(r.ts)}${ver} · ${sentNote}`;

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
