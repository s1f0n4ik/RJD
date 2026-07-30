import React, { useEffect, useRef, useState } from 'react';
import { IconClock, IconPin } from '../icons';
import { krspsApi } from '../api/client';
import type { GwTime } from '../types';
import { formatInt } from '../utils/format';

interface Props {
  time: GwTime | null;
  // Смещение серверного времени относительно локального (мс). Обновляется после
  // каждого ответа ручки /time; таймер тикает локально от этого смещения.
  offsetMs: number;
  synced: boolean;
  // Смена пояса отвечает свежим снимком — приложение обновляет часы сразу
  onTimeUpdate: (t: GwTime) => void;
}

// Пояса РФ: от калининградского до камчатского
const TZ_OPTIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((h) => ({
  minutes: h * 60,
  label: `UTC+${h}${h === 3 ? ' (МСК)' : ''}`,
}));

function tzLabel(min?: number): string {
  if (min == null) return 'UTC';
  const sign = min < 0 ? '−' : '+';
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
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

const TimeGpsPanel: React.FC<Props> = ({ time, offsetMs, synced, onTimeUpdate }) => {
  const [nowMs, setNowMs] = useState(() => Date.now() + offsetMs);
  const offsetRef = useRef(offsetMs);
  offsetRef.current = offsetMs;

  const [tzBusy, setTzBusy] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now() + offsetRef.current), 100);
    return () => clearInterval(t);
  }, []);

  const handleTzChange = async (minutes: number) => {
    setTzBusy(true);
    try {
      onTimeUpdate(await krspsApi.setTimeZone(minutes));
    } catch {
      /* пояс не применился — селект вернётся к значению из /time */
    } finally {
      setTzBusy(false);
    }
  };

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
      {/*
      <div className="krsps-module__head">
        <div className="krsps-module__title">Время и GPS</div>
      </div>
      */}

      <div className="krsps-card">
        <div className="krsps-panel__head">
          <IconClock />
          <div className="krsps-panel__title">Единое время ({tzLabel(time?.tz_offset_min)})</div>
          <div className={`krsps-panel__meta krsps-clock__sync${synced ? ' krsps-clock__sync--ok' : ''}`}>
            <span className="krsps-clock__sync-dot" />
            {!synced ? 'ожидание шлюза' : fromCan ? 'синхронизировано по шине CAN' : 'часы шлюза'}
          </div>
        </div>

        <div className="krsps-clock__tz">
          <span className="krsps-clock__tz-lbl">Часовой пояс</span>
          <select
            className="krsps-input krsps-input--sm"
            value={time?.tz_offset_min ?? 180}
            disabled={tzBusy || !synced}
            onChange={(e) => void handleTzChange(Number(e.target.value))}
          >
            {TZ_OPTIONS.map((o) => (
              <option key={o.minutes} value={o.minutes}>{o.label}</option>
            ))}
          </select>
          <span className="krsps-clock__tz-note">
            По шине время идёт в UTC; шлюз раздаёт и показывает его в этом поясе.
          </span>
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
          Источник: время - {sourceNote(time?.source.time)}, координаты - {sourceNote(time?.source.gps)}.
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
