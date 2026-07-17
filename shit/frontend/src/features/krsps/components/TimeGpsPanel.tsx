import React, { useEffect, useRef, useState } from 'react';
import { IconClock, IconPin } from '../icons';
import type { GwTime } from '../types';
import { formatInt } from '../utils/format';

interface Props {
  time: GwTime | null;
  // Смещение серверного времени относительно локального (мс). Обновляется после
  // каждого ответа ручки /time; таймер тикает локально от этого смещения.
  offsetMs: number;
  synced: boolean;
}

function two(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

// Координаты приходят с шины со знаком: южная широта и западная долгота
// отрицательные. Показываем полушарие, а не приклеенные N/E.
function coord(v: number, pos: string, neg: string): string {
  return `${Math.abs(v).toFixed(4)}° ${v < 0 ? neg : pos}`;
}

const SOURCE_NOTE: Record<string, string> = {
  can: 'стороннее устройство на шине CAN',
  server: 'часы сервиса (шина молчит)',
  static: 'фиксированные координаты (шина молчит)',
};

function sourceNote(kind?: string): string {
  return kind ? SOURCE_NOTE[kind] ?? kind : '—';
}

const Kv: React.FC<{ k: string; v: React.ReactNode }> = ({ k, v }) => (
  <div className="krsps-kv">
    <span className="krsps-kv__k">{k}</span>
    <span className="krsps-kv__v">{v}</span>
  </div>
);

const TimeGpsPanel: React.FC<Props> = ({ time, offsetMs, synced }) => {
  const [nowMs, setNowMs] = useState(() => Date.now() + offsetMs);
  const offsetRef = useRef(offsetMs);
  offsetRef.current = offsetMs;

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now() + offsetRef.current), 100);
    return () => clearInterval(t);
  }, []);

  const d = new Date(nowMs);
  const hh = two(d.getUTCHours());
  const mm = two(d.getUTCMinutes());
  const ss = two(d.getUTCSeconds());
  const mmm = String(d.getUTCMilliseconds()).padStart(3, '0');
  const dateStr = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
  const unixS = Math.floor(nowMs / 1000);

  const gps = time?.gps;
  const fromCan = time?.source.time === 'can';

  return (
    <div>
      <div className="krsps-module__head">
        <div className="krsps-module__title">Время и GPS</div>
        <div className="krsps-module__meta">точка входа для всех сервисов</div>
      </div>

      <div className="krsps-card">
        <div className="krsps-panel__head">
          <IconClock />
          <div className="krsps-panel__title">Единое время (UTC)</div>
          <div className={`krsps-panel__meta krsps-clock__sync${synced ? ' krsps-clock__sync--ok' : ''}`}>
            <span className="krsps-clock__sync-dot" />
            {!synced ? 'ожидание шлюза' : fromCan ? 'синхронизировано по шине CAN' : 'часы шлюза'}
          </div>
        </div>

        <div className="krsps-clock-grid">
          <div className="krsps-clock__left">
            <div className="krsps-clock__cap">Текущее время</div>
            <div className="krsps-clock__time">
              {hh}:{mm}:{ss}
              <span className="krsps-clock__ms">.{mmm}</span>
            </div>
            <div className="krsps-clock__date">
              {dateStr} · unix {formatInt(unixS)}
            </div>
          </div>

          <div className="krsps-clock__right">
            <div className="krsps-clock__right-cap">
              <IconPin />
              <span>Координаты</span>
            </div>
            <Kv k="Широта" v={gps ? coord(gps.lat, 'N', 'S') : '—'} />
            <Kv k="Долгота" v={gps ? coord(gps.lon, 'E', 'W') : '—'} />
            <Kv k="Скорость" v={gps ? `${gps.speed.toFixed(2)} м/с` : '—'} />
            <Kv
              k="Данные"
              v={gps ? (gps.valid ? 'актуальны' : 'устарели') : '—'}
            />
          </div>
        </div>

        <div className="krsps-clock__note">
          Источник: время — {sourceNote(time?.source.time)}, координаты — {sourceNote(time?.source.gps)}.
          {fromCan
            ? ' Время идёт от последнего сообщения по шине и тикает дальше внутри сервиса, поэтому остаётся точным между сообщениями.'
            : ' Пока по шине ничего не пришло, отдаются часы сервиса и заглушка координат.'}{' '}
          Таймер на странице идёт локально и синхронизируется по ручке /time.
        </div>
      </div>
    </div>
  );
};

export default TimeGpsPanel;
