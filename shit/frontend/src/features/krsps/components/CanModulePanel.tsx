import React, { useEffect, useState } from 'react';
import type { GwCanConfigPatch, GwModule } from '../types';
import { formatInt, formatBytes } from '../utils/format';
import { Kpi, Pill, RecordRow, connState } from './ModuleBits';

interface Props {
  module: GwModule;
  busy: boolean;
  onSave: (patch: GwCanConfigPatch) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

// Адреса и PGN на шине принято писать шестнадцатеричными, но руками удобнее
// вводить и так, и так: принимаем оба вида.
function parseNum(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = /^0x/i.test(s) ? parseInt(s.slice(2), 16) : parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function hex(n: number, width: number): string {
  return '0x' + n.toString(16).toUpperCase().padStart(width, '0');
}

const BITRATES = [10000, 20000, 50000, 100000, 125000, 250000, 500000, 800000, 1000000];

// Одна ячейка полезной нагрузки: байт и что он означает.
const Byte: React.FC<{ n: number; value: number; label: string; note: string }> = ({
  n,
  value,
  label,
  note,
}) => (
  <div className="krsps-byte">
    <div className="krsps-byte__idx">байт {n}</div>
    <div className="krsps-byte__val">{hex(value, 2)}</div>
    <div className="krsps-byte__label">{label}</div>
    <div className="krsps-byte__note">{note}</div>
  </div>
);

const Field: React.FC<{
  id: string;
  label: string;
  value: string;
  hint?: string;
  onChange: (v: string) => void;
}> = ({ id, label, value, hint, onChange }) => (
  <div className="krsps-field">
    <label className="krsps-field__label" htmlFor={id}>
      {label}
    </label>
    <input
      id={id}
      className="krsps-input krsps-input--sm"
      value={value}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
    {hint && <div className="krsps-field__hint">{hint}</div>}
  </div>
);

const CanModulePanel: React.FC<Props> = ({ module, busy, onSave, onConnect, onDisconnect }) => {
  const conn = module.connection;
  const addr = module.addressing;
  const payload = module.payload;
  const rx = module.rx;

  const [mode, setMode] = useState<'socketcan' | 'slcan'>('socketcan');
  const [iface, setIface] = useState('can0');
  const [device, setDevice] = useState('/dev/ttyUSB0');
  const [bitrate, setBitrate] = useState('250000');
  const [enabled, setEnabled] = useState(true);

  const [srcAddr, setSrcAddr] = useState('');
  const [peerAddr, setPeerAddr] = useState('');
  const [txPgn, setTxPgn] = useState('');
  const [txPrio, setTxPrio] = useState('');
  const [txPeriod, setTxPeriod] = useState('');
  const [ttl, setTtl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setMode(conn.mode ?? 'socketcan');
    setIface(conn.iface ?? 'can0');
    setDevice(conn.device ?? '/dev/ttyUSB0');
    setBitrate(String(conn.bitrate ?? 250000));
    setEnabled(conn.enabled);
  }, [conn.mode, conn.iface, conn.device, conn.bitrate, conn.enabled]);

  useEffect(() => {
    if (!addr) return;
    setSrcAddr(hex(addr.src_addr, 2));
    setPeerAddr(hex(addr.peer_addr, 2));
    setTxPgn(hex(addr.tx_pgn, 4));
    setTxPrio(String(addr.tx_priority));
    setTxPeriod(String(addr.tx_period_ms));
    setTtl(String(addr.payload_ttl_ms));
  }, [addr]);

  const handleSave = () => {
    const nums: Array<[string, string, number | null]> = [
      ['Адрес нашего сервиса', srcAddr, parseNum(srcAddr)],
      ['Адрес стороннего устройства', peerAddr, parseNum(peerAddr)],
      ['PGN передачи', txPgn, parseNum(txPgn)],
      ['Приоритет', txPrio, parseNum(txPrio)],
      ['Период выдачи', txPeriod, parseNum(txPeriod)],
      ['Время жизни нагрузки', ttl, parseNum(ttl)],
    ];
    const bad = nums.find(([, , v]) => v === null);
    if (bad) {
      setError(`${bad[0]}: ожидается число (можно 0x-формат)`);
      return;
    }
    setError('');

    onSave({
      mode,
      iface,
      device,
      bitrate: parseNum(bitrate) ?? 250000,
      enabled,
      src_addr: nums[0][2]!,
      peer_addr: nums[1][2]!,
      tx_pgn: nums[2][2]!,
      tx_priority: nums[3][2]!,
      tx_period_ms: nums[4][2]!,
      payload_ttl_ms: nums[5][2]!,
    });
  };

  const stats = module.stats;
  const bytes = formatBytes(stats.bytes);
  const hz = addr ? (1000 / addr.tx_period_ms).toFixed(0) : '—';
  // -1 — кадров от media-center ещё не приходило вовсе.
  const stale = payload ? payload.age_ms < 0 : true;

  return (
    <div>
      <div className="krsps-module__head">
        <div className="krsps-module__title">CAN → шина изделия</div>
        <Pill state={connState(module)} />
        <div className="krsps-module__meta">
          {addr ? `${addr.tx_id} · ${hz} Гц · J1939` : 'J1939'}
        </div>
      </div>

      {conn.error && <div className="krsps-alert">Шина: {conn.error}</div>}

      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Подключение к шине</div>
          <div className="krsps-panel__meta">{conn.url || '—'}</div>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-form">
            <div className="krsps-seg">
              <button
                type="button"
                className={`krsps-seg__btn${mode === 'socketcan' ? ' krsps-seg__btn--on' : ''}`}
                onClick={() => setMode('socketcan')}
              >
                SocketCAN
              </button>
              <button
                type="button"
                className={`krsps-seg__btn${mode === 'slcan' ? ' krsps-seg__btn--on' : ''}`}
                onClick={() => setMode('slcan')}
              >
                slcan (serial)
              </button>
            </div>

            <div className="krsps-form__row">
              {mode === 'socketcan' ? (
                <Field
                  id="krsps-can-iface"
                  label="Сетевой интерфейс"
                  value={iface}
                  hint="Скорость шины задаётся снаружи: ip link set can0 up type can bitrate 250000"
                  onChange={setIface}
                />
              ) : (
                <>
                  <Field
                    id="krsps-can-dev"
                    label="Serial port"
                    value={device}
                    hint="USB-адаптер с ASCII-протоколом Lawicel"
                    onChange={setDevice}
                  />
                  <div className="krsps-field">
                    <label className="krsps-field__label" htmlFor="krsps-can-bitrate">
                      Скорость шины
                    </label>
                    <select
                      id="krsps-can-bitrate"
                      className="krsps-input krsps-input--sm"
                      value={bitrate}
                      onChange={(e) => setBitrate(e.target.value)}
                    >
                      {BITRATES.map((b) => (
                        <option key={b} value={b}>
                          {formatInt(b)} бит/с
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              <button
                type="button"
                className={`krsps-switch${enabled ? ' krsps-switch--on' : ''}`}
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled((v) => !v)}
              >
                <span className="krsps-switch__track" />
                Обмен по шине включён
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Адресация J1939</div>
          <div className="krsps-panel__meta">
            {addr ? `приём: ${addr.gps_id} (GPS) · ${addr.time_id} (время)` : '—'}
          </div>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-form">
            <div className="krsps-form__row">
              <Field
                id="krsps-can-src"
                label="Наш адрес (SA)"
                value={srcAddr}
                hint="техническое зрение"
                onChange={setSrcAddr}
              />
              <Field
                id="krsps-can-peer"
                label="Адрес источника времени и GPS"
                value={peerAddr}
                hint="стороннее устройство"
                onChange={setPeerAddr}
              />
              <Field id="krsps-can-pgn" label="PGN передачи" value={txPgn} onChange={setTxPgn} />
              <Field id="krsps-can-prio" label="Приоритет" value={txPrio} hint="0..7" onChange={setTxPrio} />
            </div>
            <div className="krsps-form__row">
              <Field
                id="krsps-can-period"
                label="Период выдачи, мс"
                value={txPeriod}
                hint="кадр уходит на шину строго по таймеру"
                onChange={setTxPeriod}
              />
              <Field
                id="krsps-can-ttl"
                label="Жизнь нагрузки, мс"
                value={ttl}
                hint="без новых обнаружений дальше уходят нули"
                onChange={setTtl}
              />

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
            {error && <div className="krsps-field__hint krsps-field__hint--error">{error}</div>}
          </div>
        </div>
      </div>

      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Что уходит на шину сейчас</div>
          <div className="krsps-panel__meta">
            {stale
              ? 'обнаружений нет'
              : `обновлено ${payload ? Math.round(payload.age_ms) : 0} мс назад`}
          </div>
        </div>
        <div className="krsps-panel__body">
          <div className={`krsps-bytes${stale ? ' krsps-bytes--idle' : ''}`}>
            <Byte
              n={1}
              value={payload?.count ?? 0}
              label="Количество"
              note={`${payload?.count ?? 0} обнаружений`}
            />
            <Byte n={2} value={payload?.type ?? 0} label="Тип" note={payload?.type_title ?? '—'} />
            <Byte n={3} value={payload?.danger ?? 0} label="Опасность" note={payload?.danger_title ?? '—'} />
            <Byte
              n={4}
              value={payload?.camera ?? 0}
              label="Камера"
              note={payload?.camera ? `камера ${payload.camera}` : '—'}
            />
          </div>
          <div className="krsps-clock__note">
            Кадр уходит на шину каждые {addr?.tx_period_ms ?? '—'} мс независимо от нейросети; данные от
            media-center только обновляют эту нагрузку. Тип берётся у обнаружения с самым высоким классом
            опасности. Соответствия задаются в разделе «Таблица соответствий».
          </div>
        </div>
      </div>

      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Приём с шины</div>
          <div className="krsps-panel__meta">
            {addr ? `от ${addr.peer_addr_hex}` : '—'} · время и GPS для всех сервисов
          </div>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-kpis">
            <Kpi label="Координаты" value={formatInt(rx?.gps ?? 0)} />
            <Kpi label="Время" value={formatInt(rx?.time ?? 0)} />
            <Kpi label="Ошибки разбора" value={formatInt(rx?.errors ?? 0)} />
            <Kpi label="Чужие кадры" value={formatInt(rx?.other ?? 0)} />
          </div>
          {rx?.last_error && <div className="krsps-alert">Последняя ошибка разбора: {rx.last_error}</div>}
        </div>
      </div>

      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Состояние</div>
          <div className="krsps-panel__meta">
            отклонено {formatInt(stats.rejected)} · повторов {formatInt(stats.repeats)}
          </div>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-kpis">
            <Kpi label="Кадров на шину" value={formatInt(stats.messages)} />
            <Kpi label="Обнаружений" value={formatInt(stats.detections)} />
            <Kpi label="Передано" value={bytes.value} unit={bytes.unit} />
            <Kpi label="Длина кадра" value={String(addr?.tx_dlc ?? 8)} unit="байт" />
          </div>

          <div className="krsps-feed__label">Последние обнаружения · {stats.recent.length}</div>
          {stats.recent.length > 0 ? (
            <div className="krsps-feed">
              {stats.recent.map((r) => (
                <RecordRow key={r.seq} r={r} sentNote="ушло на шину" showVer={false} />
              ))}
            </div>
          ) : (
            <div className="krsps-empty">Обнаружений пока не было</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CanModulePanel;
