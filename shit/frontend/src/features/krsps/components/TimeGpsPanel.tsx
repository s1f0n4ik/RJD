import React, { useEffect, useRef, useState } from 'react';
import { krspsApi } from '../api/client';
import type { GwTime } from '../types';
import { formatInt } from '../utils/format';

interface Props {
  time: GwTime | null;
  // Смещение серверного времени относительно локального (мс); таймер тикает от него
  offsetMs: number;
  synced: boolean;
  // Смена пояса отвечает свежим снимком — часы обновляются сразу
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

// Координаты приходят со знаком: показываем полушарие, а не приклеенные N/E
function coord(v: number, pos: string, neg: string): string {
  return `${Math.abs(v).toFixed(4)}° ${v < 0 ? neg : pos}`;
}

const SOURCE_NOTE: Record<string, string> = {
  can: 'шина CAN',
  server: 'часы сервиса, шина молчит',
  static: 'заглушка, шина молчит',
};

function sourceNote(kind?: string): string {
  return kind ? SOURCE_NOTE[kind] ?? kind : '—';
}

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
  const syncTone = !synced ? 'warn' : fromCan ? 'ok' : '';
  const syncLabel = !synced ? 'ожидание шлюза' : fromCan ? 'синхронизировано по шине CAN' : 'часы шлюза';

  return (
    <>
      <div className="mod-title">
        <h2>Время и GPS</h2>
        <span className={`pill ${syncTone}`}><span className="dot" />{syncLabel}</span>
        <div className="title-sel spacer">
          <span className="cap">Часовой пояс</span>
          <select
            className="sel"
            value={time?.tz_offset_min ?? 180}
            disabled={tzBusy || !synced}
            onChange={(e) => void handleTzChange(Number(e.target.value))}
          >
            {TZ_OPTIONS.map((o) => (
              <option key={o.minutes} value={o.minutes}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="mod-rows">
        <div className="card fit time">
          <div className="card-h">
            <h3>Единое время ({tzLabel(time?.tz_offset_min)})</h3>
            <span className="meta">источник · {sourceNote(time?.source.time)}</span>
          </div>
          <div className="card-b">
            <div className="clock-wrap">
              <div className="clock">
                {hh}:{mm}:{ss}<small>.{mmm}</small>
              </div>
              <span className="date">{dateStr} · unix {formatInt(unixS)}</span>
            </div>
          </div>
        </div>

        <div className="card gps" style={{ '--w': '420px' } as React.CSSProperties}>
          <div className="card-h">
            <h3>Координаты</h3>
            <span className="meta">источник · {sourceNote(time?.source.gps)}</span>
          </div>
          <div className="card-b">
            <div className="kvs">
              <div className="kv"><span className="k">Широта</span><span className="v">{gps ? coord(gps.lat, 'N', 'S') : '—'}</span></div>
              <div className="kv"><span className="k">Долгота</span><span className="v">{gps ? coord(gps.lon, 'E', 'W') : '—'}</span></div>
              <div className="kv"><span className="k">Скорость</span><span className="v">{gps ? `${gps.speed.toFixed(2)} м/с` : '—'}</span></div>
              <div className="kv">
                <span className="k">Данные</span>
                {!gps ? (
                  <span className="v">—</span>
                ) : time?.source.gps === 'static' ? (
                  <span className="v warn">заглушка</span>
                ) : (
                  <span className={`v${gps.valid ? ' ok' : ' err'}`}>{gps.valid ? 'актуальны' : 'устарели'}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default TimeGpsPanel;
