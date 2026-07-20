import React, { useEffect, useState } from 'react';
import { IconRefresh } from '../icons';
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

// Выбор устройства из просканированных. Сохранённое значение остаётся в списке,
// даже если сейчас оно не найдено, — иначе select показал бы пустоту и настройку
// нельзя было бы увидеть. Пустой список говорит об этом прямо в самом select.
interface DeviceOption {
  value: string;
  label: string;
}
const DeviceSelect: React.FC<{
  id: string;
  value: string;
  options: DeviceOption[];
  emptyText: string;
  onChange: (v: string) => void;
}> = ({ id, value, options, emptyText, onChange }) => {
  const inList = options.some((o) => o.value === value);
  return (
    <select
      id={id}
      className="krsps-input krsps-input--sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.length === 0 && !value && (
        <option value="" disabled>
          {emptyText}
        </option>
      )}
      {value && !inList && <option value={value}>{value} — сейчас не найден</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
};

// Адреса и PGN на шине принято писать шестнадцатеричными, но руками удобнее
// вводить и так, и так: принимаем оба вида.
function parseNum(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = /^0x/i.test(s) ? parseInt(s.slice(2), 16) : parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
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
  // Система счисления для PGN и адреса. По ней и показываем, и разбираем поля —
  // 0x в текст вводить не нужно, основание задаётся переключателем.
  const [base, setBase] = useState<'hex' | 'dec'>('hex');
  const [priority, setPriority] = useState('');
  const [pgn, setPgn] = useState('');
  const [addr, setAddr] = useState('');
  const [error, setError] = useState('');

  const fmt = (n: number) => (base === 'hex' ? n.toString(16).toUpperCase() : String(n));

  useEffect(() => {
    setPriority(String(msg.priority));
    setPgn(fmt(msg.pgn));
    setAddr(fmt(msg.addr));
    // base намеренно не в зависимостях: смену основания обрабатывает switchBase,
    // сохраняя уже введённые правки, а не сбрасывая их к значению с шины.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg.priority, msg.pgn, msg.addr]);

  // Переключение основания переводит уже набранные цифры, а не обнуляет поля.
  const switchBase = (nb: 'hex' | 'dec') => {
    if (nb === base) return;
    const conv = (s: string) => {
      const n = parseInt(s, base === 'hex' ? 16 : 10);
      return Number.isFinite(n) ? (nb === 'hex' ? n.toString(16).toUpperCase() : String(n)) : '';
    };
    setPgn(conv(pgn));
    setAddr(conv(addr));
    setBase(nb);
  };

  // В поле пускаем только допустимые для основания цифры.
  const clean = (v: string) =>
    base === 'hex' ? v.replace(/[^0-9a-fA-F]/g, '').toUpperCase() : v.replace(/[^0-9]/g, '');

  const save = () => {
    const radix = base === 'hex' ? 16 : 10;
    const p = parseInt(priority, 10);
    const g = parseInt(pgn, radix);
    const a = parseInt(addr, radix);
    if (!Number.isFinite(p) || !Number.isFinite(g) || !Number.isFinite(a)) {
      setError('Приоритет, PGN и адрес — числа в выбранной системе счисления');
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
            <input
              className="krsps-input krsps-input--sm"
              value={priority}
              inputMode="numeric"
              onChange={(e) => setPriority(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>
          <div className="krsps-field">
            <label className="krsps-field__label">Система счисления</label>
            <div className="krsps-baseseg">
              <button
                type="button"
                className={`krsps-baseseg__btn${base === 'hex' ? ' krsps-baseseg__btn--on' : ''}`}
                onClick={() => switchBase('hex')}
              >
                16 · HEX
              </button>
              <button
                type="button"
                className={`krsps-baseseg__btn${base === 'dec' ? ' krsps-baseseg__btn--on' : ''}`}
                onClick={() => switchBase('dec')}
              >
                10 · DEC
              </button>
            </div>
          </div>
          <div className="krsps-field krsps-field--xs">
            <label className="krsps-field__label">PGN</label>
            <input className="krsps-input krsps-input--sm" value={pgn} spellCheck={false} onChange={(e) => setPgn(clean(e.target.value))} />
          </div>
          <div className="krsps-field krsps-field--xs">
            <label className="krsps-field__label">{msg.dir === 'tx' ? 'Наш адрес' : 'Адрес источника'}</label>
            <input className="krsps-input krsps-input--sm" value={addr} spellCheck={false} onChange={(e) => setAddr(clean(e.target.value))} />
          </div>
        </div>
        {error && <div className="krsps-field__hint krsps-field__hint--error" style={{ marginTop: 8 }}>{error}</div>}

        <div className="krsps-actionbar">
          <div className="krsps-idcalc" style={{ marginLeft: 0, textAlign: 'left' }}>
            <div className="krsps-idcalc__cap">Итоговый ID</div>
            <div className="krsps-idcalc__val">{msg.id}</div>
          </div>
          <button type="button" className="krsps-btn krsps-btn--primary krsps-actionbar__push" onClick={save} disabled={busy}>
            Применить
          </button>
        </div>

        {children}

        <div className="krsps-sub" style={{ marginTop: 30 }}>Схема кадра · 8 байт</div>
        <CanMessageSpec spec={SPECS[msg.key]} data={summary?.data} />
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

  const [mode, setMode] = useState<'socketcan' | 'slcan'>('socketcan');
  const [iface, setIface] = useState('can0');
  const [device, setDevice] = useState('/dev/ttyUSB0');
  const [bitrate, setBitrate] = useState('250000');
  const [enabled, setEnabled] = useState(true);

  const [period, setPeriod] = useState('');
  const [ttl, setTtl] = useState('');
  const [ttlOn, setTtlOn] = useState(true);
  const [txError, setTxError] = useState('');
  const [filter, setFilter] = useState<'all' | 'tx' | 'rx'>('all');

  useEffect(() => {
    setMode(conn.mode ?? 'socketcan');
    setIface(conn.iface ?? 'can0');
    setDevice(conn.device ?? '/dev/ttyUSB0');
    setBitrate(String(conn.bitrate ?? 250000));
    setEnabled(conn.enabled);
  }, [conn.mode, conn.iface, conn.device, conn.bitrate, conn.enabled]);

  // Зависимости — примитивные поля, а не объект tx: он новый на каждый опрос
  // статуса, и по [tx] эффект перетирал бы локальные правки (флаг, период) до
  // нажатия «Применить». Пересинхронизируемся только когда значение реально
  // изменилось на сервере.
  useEffect(() => {
    if (!tx) return;
    setPeriod(String(tx.period_ms));
    setTtl(String(tx.payload_ttl_ms));
    setTtlOn(tx.ttl_enabled ?? true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx?.period_ms, tx?.payload_ttl_ms, tx?.ttl_enabled]);

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
    onSave({ tx_period_ms: p, payload_ttl_enabled: ttlOn, payload_ttl_ms: t });
  };

  const sumOf = (key: string) => summaries.find((s) => s.key === key);
  const rxMessages = messages.filter((m) => m.dir === 'rx');
  const txMessages = messages.filter((m) => m.dir === 'tx');
  const shown = log.filter((r) => filter === 'all' || r.dir === filter);

  // Найденные устройства для выпадающих списков. Сохранённое значение остаётся
  // выбираемым даже когда его сейчас нет в списке (см. DeviceSelect).
  const canOptions = (devices?.can ?? []).map((c) => ({
    value: c.name,
    label: `${c.name} · ${c.up ? 'поднят' : 'не поднят'}`,
  }));
  const serialOptions = (devices?.serial ?? []).map((s) => ({ value: s.name, label: s.name }));

  return (
    <div>
      {/*
      <div className="krsps-module__head">
        <div className="krsps-module__title">CAN → шина изделия</div>
        <div className="krsps-module__meta">J1939</div>
      </div>
      */}

      {/* ── Подключение: состояние и кнопки здесь, а не в заголовке ── */}
      <div className="krsps-card">
        <div className="krsps-panel__head">
          <div className="krsps-panel__title">Подключение к шине</div>
          <Pill state={connState(module)} />
          <div className="krsps-panel__meta">J1939</div>
          <button
            type="button"
            className="krsps-icon-btn"
            title="Переподключить"
            aria-label="Переподключить"
            onClick={onConnect}
            disabled={busy}
          >
            <IconRefresh />
          </button>
        </div>
        <div className="krsps-panel__body">
          <div className="krsps-formgrid">
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

            {mode === 'socketcan' ? (
              <div className="krsps-field">
                <label className="krsps-field__label" htmlFor="krsps-can-iface">
                  Интерфейс CAN
                </label>
                <DeviceSelect
                  id="krsps-can-iface"
                  value={iface}
                  options={canOptions}
                  emptyText="CAN-интерфейсов не найдено"
                  onChange={setIface}
                />
                <div className="krsps-field__hint">
                  {canOptions.length ? `Найдено интерфейсов: ${canOptions.length}` : 'Интерфейсов CAN на машине не видно'}
                </div>
              </div>
            ) : (
              <>
                <div className="krsps-field">
                  <label className="krsps-field__label" htmlFor="krsps-can-dev">
                    Serial-порт
                  </label>
                  <DeviceSelect
                    id="krsps-can-dev"
                    value={device}
                    options={serialOptions}
                    emptyText="Serial-портов не найдено"
                    onChange={setDevice}
                  />
                  <div className="krsps-field__hint">
                    {serialOptions.length ? `Найдено портов: ${serialOptions.length}` : 'Serial-адаптеров на машине не видно'}
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
          </div>

          {conn.error && <div className="krsps-alert" style={{ marginTop: 16 }}>Шина: {conn.error}</div>}

        </div>

        {/* Серый футер действий: тумблер слева, кнопки справа, отделён от полей. */}
        <div className="krsps-formfoot">
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
            <button type="button" className="krsps-btn krsps-btn--text" onClick={onDisconnect} disabled={busy}>
              Отключить
            </button>
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
          <div className="krsps-panel__meta">{rxMessages.length}</div>
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

              {/* Период имеет смысл только у постоянной выдачи: без неё кадр
                  уходит по приходу обнаружений. */}
              <div className="krsps-field krsps-field--xs">
                <label className="krsps-field__label">Период, мс</label>
                <input
                  className="krsps-input krsps-input--sm"
                  value={period}
                  disabled={!tx?.continuous}
                  onChange={(e) => setPeriod(e.target.value)}
                />
              </div>

              {/* Жизнь нагрузки — один элемент: флаг ограничения по времени плюс
                  само значение. Выключен — нагрузка держится до нового кадра, вне
                  зависимости от прошедшего времени, поле при этом гаснет. */}
              <div className="krsps-field">
                <label className="krsps-field__label">Жизнь нагрузки</label>
                <div className="krsps-inlinectl">
                  <button
                    type="button"
                    className={`krsps-switch krsps-switch--bare${ttlOn ? ' krsps-switch--on' : ''}`}
                    role="switch"
                    aria-checked={ttlOn}
                    aria-label="Ограничивать жизнь нагрузки по времени"
                    disabled={busy}
                    onClick={() => setTtlOn((v) => !v)}
                  >
                    <span className="krsps-switch__track" />
                  </button>
                  <span className="krsps-inlinectl__sep" />
                  <span className={`krsps-inlinectl__val${ttlOn ? '' : ' krsps-inlinectl__val--off'}`}>
                    <input
                      className="krsps-input"
                      value={ttl}
                      inputMode="numeric"
                      disabled={busy || !ttlOn}
                      onChange={(e) => setTtl(e.target.value.replace(/[^\d]/g, ''))}
                    />
                    <span className="krsps-inlinectl__unit">{ttlOn ? 'мс' : 'без ограничения'}</span>
                  </span>
                </div>
              </div>

              <button
                type="button"
                className="krsps-btn krsps-btn--primary"
                onClick={saveTx}
                disabled={busy}
              >
                Применить
              </button>
            </div>

            {txError && <div className="krsps-field__hint krsps-field__hint--error">{txError}</div>}
            {/*<div className="krsps-note" style={{ marginTop: 10 }}>
              {tx?.continuous
                ? 'Кадр уходит по таймеру независимо от нейросети — данные от media-center только обновляют нагрузку. Камера, замолчавшая дольше «жизни нагрузки», гасит свой бит.'
                : 'Кадр уходит только при новых обнаружениях. Период и жизнь нагрузки при этом не действуют.'}
            </div>*/}
          </MessageBlock>
        ))}
        {txMessages.length === 0 && <div className="krsps-empty">Сообщений нет</div>}
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
      </div>
        </>
      )}
    </div>
  );
};

export default CanModulePanel;
