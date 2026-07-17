import React, { useEffect, useState } from 'react';
import { IconCheck, IconClose } from '../icons';
import type {
  GwCanConfigPatch,
  GwCanMessage,
  GwCanSummary,
  GwDevices,
  GwModule,
} from '../types';
import { formatInt, formatClock } from '../utils/format';
import { Pill, connState } from './ModuleBits';
import CanMessageSpec, { SPECS } from './CanMessageSpec';

interface Props {
  module: GwModule;
  devices: GwDevices | null;
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

function age(ms: number): string {
  if (ms < 0) return 'кадров не было';
  if (ms < 1000) return `${Math.round(ms)} мс назад`;
  return `${(ms / 1000).toFixed(1)} с назад`;
}

const Chevron: React.FC = () => (
  <svg className="krsps-chev" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5l8 7-8 7z" />
  </svg>
);

// ── Одно сообщение: свёрнутая строка + настройки адреса + схема кадра ──
interface MsgProps {
  msg: GwCanMessage;
  summary?: GwCanSummary;
  busy: boolean;
  onPatch: (patch: GwCanConfigPatch) => void;
  children?: React.ReactNode;
}

const MessageBlock: React.FC<MsgProps> = ({ msg, summary, busy, onPatch, children }) => {
  const [priority, setPriority] = useState('');
  const [pgn, setPgn] = useState('');
  const [addr, setAddr] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setPriority(String(msg.priority));
    setPgn(hex(msg.pgn, 4));
    setAddr(hex(msg.addr, 2));
  }, [msg.priority, msg.pgn, msg.addr]);

  const save = () => {
    const p = parseNum(priority);
    const g = parseNum(pgn);
    const a = parseNum(addr);
    if (p === null || g === null || a === null) {
      setError('Приоритет, PGN и адрес — числа, можно в 0x-формате');
      return;
    }
    setError('');
    onPatch({ [msg.key]: { priority: p, pgn: g, addr: a } } as GwCanConfigPatch);
  };

  const toggle = (e: React.MouseEvent) => {
    // Тумблер живёт в строке-заголовке: клик по нему не должен ещё и
    // разворачивать блок.
    e.preventDefault();
    e.stopPropagation();
    onPatch({ [msg.key]: { enabled: !msg.enabled } } as GwCanConfigPatch);
  };

  return (
    <details className="krsps-msg">
      <summary className="krsps-msg__head">
        <Chevron />
        <span className={`krsps-msg__dir krsps-msg__dir--${msg.dir}`}>{msg.dir.toUpperCase()}</span>
        <span className="krsps-msg__name">{msg.title}</span>
        <span className="krsps-msg__id">{msg.id}</span>
        <span className="krsps-msg__spacer" />
        {summary && (
          <span className="krsps-msg__hz">
            {formatInt(summary.count)} · {age(summary.age_ms)}
          </span>
        )}
        <button
          type="button"
          className={`krsps-switch krsps-switch--bare${msg.enabled ? ' krsps-switch--on' : ''}`}
          role="switch"
          aria-checked={msg.enabled}
          aria-label={msg.dir === 'rx' ? 'Разбирать сообщение' : 'Отправлять сообщение'}
          disabled={busy}
          onClick={toggle}
        >
          <span className="krsps-switch__track" />
        </button>
      </summary>

      <div className="krsps-msg__body">
        <div className="krsps-idrow">
          <div className="krsps-field krsps-field--xs">
            <label className="krsps-field__label">Приоритет</label>
            <input className="krsps-input krsps-input--sm" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </div>
          <div className="krsps-field krsps-field--xs">
            <label className="krsps-field__label">PGN</label>
            <input className="krsps-input krsps-input--sm" value={pgn} onChange={(e) => setPgn(e.target.value)} />
          </div>
          <div className="krsps-field krsps-field--xs">
            <label className="krsps-field__label">{msg.dir === 'tx' ? 'Наш адрес' : 'Адрес источника'}</label>
            <input className="krsps-input krsps-input--sm" value={addr} onChange={(e) => setAddr(e.target.value)} />
          </div>
          <button type="button" className="krsps-btn krsps-btn--primary" onClick={save} disabled={busy}>
            Применить
          </button>
          <div className="krsps-idcalc">
            <div className="krsps-idcalc__cap">Итоговый ID</div>
            <div className="krsps-idcalc__val">{msg.id}</div>
          </div>
        </div>
        {error && <div className="krsps-field__hint krsps-field__hint--error">{error}</div>}

        {children}

        <div className="krsps-sub">Схема кадра · 8 байт</div>
        <CanMessageSpec spec={SPECS[msg.key]} data={summary?.data} />
        <div className="krsps-note" style={{ marginTop: 12 }}>
          Состав полей задан протоколом и не редактируется. Меняются только приоритет, PGN и адрес —
          из них собирается идентификатор.
        </div>
      </div>
    </details>
  );
};

const CanModulePanel: React.FC<Props> = ({ module, devices, busy, onSave, onConnect, onDisconnect }) => {
  const conn = module.connection;
  const tx = module.tx;
  const messages = module.messages ?? [];
  const summaries = module.summaries ?? [];
  const log = module.log ?? [];

  // Список сообщений появился вместе с масками камер и лентой. Нет его — шлюз
  // собран до этих правок, и половина разделов ниже осталась бы пустой без
  // объяснения. Настройки подключения при этом рабочие, их и показываем.
  const stale = !module.messages;

  // Нагрузку добираем по полю: у старой сборки это `camera` (номер камеры),
  // а не маска, и обращение к маске уронило бы раздел.
  const raw = module.payload;
  const payload = raw
    ? {
        count: raw.count ?? 0,
        type: raw.type ?? 0,
        danger: raw.danger ?? 0,
        camera_mask: raw.camera_mask ?? 0,
        type_title: raw.type_title ?? '—',
        danger_title: raw.danger_title ?? '—',
        cameras: raw.cameras ?? [],
        unmapped_cameras: raw.unmapped_cameras ?? 0,
        passthrough_frames: raw.passthrough_frames ?? 0,
      }
    : null;

  const [mode, setMode] = useState<'socketcan' | 'slcan'>('socketcan');
  const [iface, setIface] = useState('can0');
  const [device, setDevice] = useState('/dev/ttyUSB0');
  const [bitrate, setBitrate] = useState('250000');
  const [enabled, setEnabled] = useState(true);

  const [period, setPeriod] = useState('');
  const [ttl, setTtl] = useState('');
  const [txError, setTxError] = useState('');
  const [filter, setFilter] = useState<'all' | 'tx' | 'rx'>('all');

  useEffect(() => {
    setMode(conn.mode ?? 'socketcan');
    setIface(conn.iface ?? 'can0');
    setDevice(conn.device ?? '/dev/ttyUSB0');
    setBitrate(String(conn.bitrate ?? 250000));
    setEnabled(conn.enabled);
  }, [conn.mode, conn.iface, conn.device, conn.bitrate, conn.enabled]);

  useEffect(() => {
    if (!tx) return;
    setPeriod(String(tx.period_ms));
    setTtl(String(tx.payload_ttl_ms));
  }, [tx]);

  const saveConnection = () =>
    onSave({ mode, iface, device, bitrate: parseNum(bitrate) ?? 250000, enabled });

  const saveTx = () => {
    const p = parseNum(period);
    const t = parseNum(ttl);
    if (p === null || t === null) {
      setTxError('Период и жизнь нагрузки — числа в миллисекундах');
      return;
    }
    setTxError('');
    onSave({ tx_period_ms: p, payload_ttl_ms: t });
  };

  const sumOf = (key: string) => summaries.find((s) => s.key === key);
  const rxMessages = messages.filter((m) => m.dir === 'rx');
  const txMessages = messages.filter((m) => m.dir === 'tx');
  const shown = log.filter((r) => filter === 'all' || r.dir === filter);

  // Найденные интерфейсы. Пусто — на машине их нет; вводить руками всё равно
  // разрешаем, устройство может появиться позже.
  const canList = devices?.can ?? [];
  const serialList = devices?.serial ?? [];

  return (
    <div>
      <div className="krsps-module__head">
        <div className="krsps-module__title">CAN → шина изделия</div>
        <div className="krsps-module__meta">J1939</div>
      </div>

      {/* ── Подключение: состояние и кнопки здесь, а не в заголовке ── */}
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Подключение к шине</div>
          <Pill state={connState(module)} />
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
                <div className="krsps-field krsps-field--mid">
                  <label className="krsps-field__label" htmlFor="krsps-can-iface">
                    Интерфейс
                  </label>
                  <input
                    id="krsps-can-iface"
                    className="krsps-input krsps-input--sm"
                    list="krsps-can-ifaces"
                    value={iface}
                    spellCheck={false}
                    onChange={(e) => setIface(e.target.value)}
                  />
                  <datalist id="krsps-can-ifaces">
                    {canList.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.up ? 'поднят' : 'не поднят'}
                      </option>
                    ))}
                  </datalist>
                  <div className="krsps-field__hint">
                    {canList.length
                      ? `Найдено: ${canList.map((c) => `${c.name} (${c.up ? 'поднят' : 'не поднят'})`).join(', ')}`
                      : 'Интерфейсов CAN на машине не видно'}
                  </div>
                </div>
              ) : (
                <>
                  <div className="krsps-field krsps-field--mid">
                    <label className="krsps-field__label" htmlFor="krsps-can-dev">
                      Serial port
                    </label>
                    <input
                      id="krsps-can-dev"
                      className="krsps-input krsps-input--sm"
                      list="krsps-can-devs"
                      value={device}
                      spellCheck={false}
                      onChange={(e) => setDevice(e.target.value)}
                    />
                    <datalist id="krsps-can-devs">
                      {serialList.map((s) => (
                        <option key={s.name} value={s.name} />
                      ))}
                    </datalist>
                    <div className="krsps-field__hint">
                      {serialList.length
                        ? `Найдено: ${serialList.map((s) => s.name).join(', ')}`
                        : 'Serial-адаптеров на машине не видно'}
                    </div>
                  </div>
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

              <div className="krsps-actions">
                <button type="button" className="krsps-btn krsps-btn--primary" onClick={saveConnection} disabled={busy}>
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

            {conn.error && <div className="krsps-alert">Шина: {conn.error}</div>}

            <div className="krsps-note">
              {mode === 'socketcan'
                ? 'Скорость шины для SocketCAN задаётся на хосте: ip link set can0 up type can bitrate 250000. Сервис её не выставляет.'
                : 'Скорость порта фиксирована (115200 8N1), скорость шины сервис выставляет сам командой адаптера. Внешний slcand не нужен.'}{' '}
              Если устройства нет, сервис продолжит переподключаться каждые 5 секунд.
            </div>
          </div>
        </div>
      </div>

      {stale && (
        <div className="krsps-card">
          <div className="krsps-panel__body">
            <div className="krsps-alert">
              Шлюз собран до появления списка сообщений и не отдаёт их состав. Разделы сообщений, камер и
              ленты шины будут доступны после пересборки message-gateway. Настройки подключения выше
              работают.
            </div>
          </div>
        </div>
      )}

      {!stale && (
        <>
      {/* ── Принимаемые сообщения ── */}
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Принимаемые сообщения</div>
          <div className="krsps-panel__meta">{rxMessages.length} · время и GPS для всех сервисов</div>
        </div>
        {rxMessages.map((m) => (
          <MessageBlock key={m.key} msg={m} summary={sumOf(m.key)} busy={busy} onPatch={onSave} />
        ))}
        {rxMessages.length === 0 && <div className="krsps-empty">Сообщений нет</div>}
      </div>

      {/* ── Отправляемые сообщения ── */}
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Отправляемые сообщения</div>
          <div className="krsps-panel__meta">
            {tx?.continuous ? `постоянно · раз в ${tx.period_ms} мс` : 'только на новые обнаружения'}
          </div>
        </div>
        {txMessages.map((m) => (
          <MessageBlock key={m.key} msg={m} summary={sumOf(m.key)} busy={busy} onPatch={onSave}>
            <div className="krsps-sub">Постоянная передача</div>
            <div className="krsps-form__row">
              <button
                type="button"
                className={`krsps-switch${tx?.continuous ? ' krsps-switch--on' : ''}`}
                role="switch"
                aria-checked={!!tx?.continuous}
                disabled={busy}
                onClick={() => onSave({ tx_continuous: !tx?.continuous })}
              >
                <span className="krsps-switch__track" />
                Слать постоянно
              </button>

              {/* Период и жизнь нагрузки имеют смысл только у постоянной выдачи:
                  без неё кадр уходит по приходу обнаружений. */}
              <div className="krsps-field krsps-field--xs">
                <label className="krsps-field__label">Период, мс</label>
                <input
                  className="krsps-input krsps-input--sm"
                  value={period}
                  disabled={!tx?.continuous}
                  onChange={(e) => setPeriod(e.target.value)}
                />
              </div>
              <div className="krsps-field krsps-field--sm">
                <label className="krsps-field__label">Жизнь нагрузки, мс</label>
                <input
                  className="krsps-input krsps-input--sm"
                  value={ttl}
                  disabled={!tx?.continuous}
                  onChange={(e) => setTtl(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="krsps-btn krsps-btn--primary"
                onClick={saveTx}
                disabled={busy || !tx?.continuous}
              >
                Применить
              </button>
            </div>
            {txError && <div className="krsps-field__hint krsps-field__hint--error">{txError}</div>}
            <div className="krsps-note" style={{ marginTop: 10 }}>
              {tx?.continuous
                ? 'Кадр уходит по таймеру независимо от нейросети — данные от media-center только обновляют нагрузку. Камера, замолчавшая дольше «жизни нагрузки», гасит свой бит.'
                : 'Кадр уходит только при новых обнаружениях. Период и жизнь нагрузки при этом не действуют.'}
            </div>
          </MessageBlock>
        ))}
        {txMessages.length === 0 && <div className="krsps-empty">Сообщений нет</div>}
      </div>

      {/* ── Нагрузка и камеры ── */}
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Камеры в кадре</div>
          <div className="krsps-panel__meta">
            байт 4 · маска {payload ? hex(payload.camera_mask, 2) : '—'}
          </div>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-bitline">
            {Array.from({ length: 8 }, (_, i) => {
              const bit = 8 - i;
              const on = !!payload && (payload.camera_mask & (1 << (bit - 1))) !== 0;
              const cam = payload?.cameras.find((c) => c.bit === bit);
              return (
                <div key={bit} className={`krsps-bitbox${on ? ' krsps-bitbox--on' : ''}`}>
                  <div className="krsps-bitbox__v">{on ? 1 : 0}</div>
                  <div className="krsps-bitbox__n">бит {bit}</div>
                  <div className="krsps-bitbox__c">{cam ? cam.key : '—'}</div>
                </div>
              );
            })}
          </div>

          {payload && payload.cameras.length > 0 ? (
            <div className="krsps-camlist">
              {payload.cameras.map((c) => (
                <div key={c.key} className="krsps-camrow">
                  <div className={`krsps-feed__ico krsps-feed__ico--${c.active ? 'ok' : 'hb'}`}>
                    {c.active ? <IconCheck /> : <IconClose />}
                  </div>
                  <div className="krsps-camrow__k">{c.key}</div>
                  <div className="krsps-camrow__b">{c.bit ? `бит ${c.bit}` : 'нет в таблице'}</div>
                  <div className="krsps-camrow__c">
                    {c.active ? `${c.count} обн.` : 'нет обнаружений'}
                  </div>
                  <div className="krsps-camrow__t">{age(c.age_ms)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="krsps-empty">Кадров от media-center ещё не было</div>
          )}

          {!!payload?.unmapped_cameras && (
            <div className="krsps-alert">
              Кадров с камерой не из таблицы: {formatInt(payload.unmapped_cameras)}. Бит поставить некуда —
              назначьте камере бит в разделе «Таблица соответствий».
            </div>
          )}
          {!!payload?.passthrough_frames && (
            <div className="krsps-note" style={{ marginTop: 12 }}>
              Кадров из конфигураций без таблицы: {formatInt(payload.passthrough_frames)}. Для них числа идут
              как есть из нейросети (тип = id класса), имена не переводятся.
            </div>
          )}
        </div>
      </div>

      {/* ── Состояние: сводка по сообщениям ── */}
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Состояние сообщений</div>
          <div className="krsps-panel__meta">последнее значение каждого типа</div>
        </div>
        <div className="krsps-panel__body">
          {summaries.map((s) => (
            <div key={s.key} className="krsps-sumrow">
              <div className={`krsps-msg__dir krsps-msg__dir--${s.dir}`}>{s.dir.toUpperCase()}</div>
              <div className="krsps-sumrow__id">{s.id}</div>
              <div className="krsps-sumrow__n">{s.title}</div>
              <div className="krsps-sumrow__d">{s.data || '—'}</div>
              <div className="krsps-sumrow__note">{s.note || (s.enabled ? '—' : 'выключено')}</div>
              <div className="krsps-sumrow__t">
                {formatInt(s.count)}
                {s.errors > 0 && <span className="krsps-sumrow__err"> · {formatInt(s.errors)} ош.</span>}
                <div className="krsps-sumrow__age">{age(s.age_ms)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Состояние: лента всех кадров ── */}
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Лента шины</div>
          <div className="krsps-tabs">
            {(['all', 'rx', 'tx'] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={`krsps-tab${filter === f ? ' krsps-tab--on' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'Все' : f === 'rx' ? 'Приём' : 'Передача'}
              </button>
            ))}
          </div>
          <div className="krsps-panel__meta">
            {shown.length} · чужих кадров {formatInt(module.rx_other ?? 0)}
          </div>
        </div>
        <div className="krsps-panel__body">
          {shown.length > 0 ? (
            <div className="krsps-canfeed">
              {shown.map((r) => (
                <div key={r.seq} className="krsps-canfeed__r">
                  <div className={`krsps-canfeed__ico krsps-canfeed__ico--${r.error ? 'err' : r.dir}`}>
                    {r.error ? '!' : r.dir.toUpperCase()}
                  </div>
                  <div className="krsps-canfeed__id">{r.id}</div>
                  <div className="krsps-canfeed__data">{r.data}</div>
                  <div className={`krsps-canfeed__note${r.error ? ' krsps-canfeed__note--err' : ''}`}>
                    {r.error || r.note}
                  </div>
                  <div className="krsps-canfeed__t">{formatClock(r.ts)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="krsps-empty">Кадров на шине пока не было</div>
          )}
        </div>
        <div className="krsps-note krsps-note--foot">
          Пишутся все кадры подряд, включая повторяющуюся нагрузку. Кольцо — последние 250 кадров,
          это около 18 секунд при штатных 10 кадрах в секунду на передачу и 4 на приём. Чужой трафик
          шины в ленту не попадает, только считается.
        </div>
      </div>
        </>
      )}
    </div>
  );
};

export default CanModulePanel;
