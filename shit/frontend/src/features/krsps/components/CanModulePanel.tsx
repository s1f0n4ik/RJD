import React, { useEffect, useState } from 'react';
import { Icon } from '../../../app/Icons';
import { Switch } from '../../../app/Modal';
import type {
  GwCanConfigPatch,
  GwCanMessage,
  GwCanSummary,
  GwDevices,
  GwModule,
} from '../types';
import { formatInt, formatClock } from '../utils/format';
import { Pill } from './ModuleBits';
import CanMessageSpec, { SPECS } from './CanMessageSpec';
import { humanizeError } from '../utils/errors';

interface Props {
  module: GwModule;
  title: string;
  devices: GwDevices | null;
  busy: boolean;
  onSave: (patch: GwCanConfigPatch) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

// Сохранённое значение остаётся в списке, даже если сейчас устройство не найдено
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
    <select id={id} className="sel" value={value} onChange={(e) => onChange(e.target.value)}>
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

// Адреса и PGN принимаем и шестнадцатеричными, и десятичными
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

// Enter завершает ввод так же, как уход с поля
const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter') e.currentTarget.blur();
};

// ── Одно сообщение: свёрнутая строка + заголовок J1939 + схема кадра ──
interface MsgProps {
  msg: GwCanMessage;
  summary?: GwCanSummary;
  busy: boolean;
  onPatch: (patch: GwCanConfigPatch) => void;
  children?: React.ReactNode;
}

const MessageBlock: React.FC<MsgProps> = ({ msg, summary, busy, onPatch, children }) => {
  // Основание задаётся переключателем: по нему и показываем, и разбираем поля
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
    // base не в зависимостях: смену основания ведёт switchBase, сохраняя правки
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg.priority, msg.pgn, msg.addr]);

  // Переключение основания переводит набранные цифры, а не обнуляет поля
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

  const clean = (v: string) =>
    base === 'hex' ? v.replace(/[^0-9a-fA-F]/g, '').toUpperCase() : v.replace(/[^0-9]/g, '');

  // Поля шлют запрос по уходу с поля; без изменений запроса нет
  const commit = () => {
    const radix = base === 'hex' ? 16 : 10;
    const p = parseInt(priority, 10);
    const g = parseInt(pgn, radix);
    const a = parseInt(addr, radix);
    if (!Number.isFinite(p) || !Number.isFinite(g) || !Number.isFinite(a)) {
      setError('Приоритет, PGN и адрес — числа в выбранной системе счисления');
      return;
    }
    setError('');
    if (p === msg.priority && g === msg.pgn && a === msg.addr) return;
    onPatch({ [msg.key]: { priority: p, pgn: g, addr: a } } as GwCanConfigPatch);
  };

  const toggle = (e: React.MouseEvent) => {
    // Тумблер живёт в строке-заголовке: клик не должен разворачивать блок
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    onPatch({ [msg.key]: { enabled: !msg.enabled } } as GwCanConfigPatch);
  };

  return (
    <details className="msg">
      <summary>
        <Icon name="chev" size={12} />
        <span className={`dir ${msg.dir}`}>{msg.dir.toUpperCase()}</span>
        {msg.title}
        <span className="id">{msg.id}</span>
        {summary && (
          <span className="cnt-s">
            {formatInt(summary.count)} · {age(summary.age_ms)}
          </span>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={msg.enabled}
          aria-label={msg.dir === 'rx' ? 'Разбирать сообщение' : 'Отправлять сообщение'}
          className={`sw${msg.enabled ? ' is-on' : ''}`}
          style={summary ? undefined : { marginLeft: 'auto' }}
          onClick={toggle}
        >
          <i />
        </button>
      </summary>

      <div className="msg-b">
        <div>
          <span className="sub-h">Заголовок J1939</span>
          <div className="hf">
            <div className="fc">
              <span className="cap">Приоритет</span>
              <input
                className="inp"
                value={priority}
                inputMode="numeric"
                onChange={(e) => setPriority(e.target.value.replace(/[^0-9]/g, ''))}
                onBlur={commit}
                onKeyDown={blurOnEnter}
              />
            </div>
            <div className="fc auto">
              <span className="cap">Система счисления</span>
              <div className="seg">
                <button type="button" className={base === 'hex' ? 'is-on' : ''} onClick={() => switchBase('hex')}>16 · HEX</button>
                <button type="button" className={base === 'dec' ? 'is-on' : ''} onClick={() => switchBase('dec')}>10 · DEC</button>
              </div>
            </div>
            <div className="fc">
              <span className="cap">PGN</span>
              <input className="inp" value={pgn} spellCheck={false} onChange={(e) => setPgn(clean(e.target.value))} onBlur={commit} onKeyDown={blurOnEnter} />
            </div>
            <div className="fc">
              <span className="cap">{msg.dir === 'tx' ? 'Наш адрес' : 'Адрес источника'}</span>
              <input className="inp" value={addr} spellCheck={false} onChange={(e) => setAddr(clean(e.target.value))} onBlur={commit} onKeyDown={blurOnEnter} />
            </div>
          </div>
          {error && <p className="hint is-err">{error}</p>}
        </div>

        <div className="idbar">
          <span className="cap">Итоговый ID</span>
          <span className="val">{msg.id}</span>
        </div>

        {children}

        <div>
          <span className="sub-h">Схема кадра · 8 байт</span>
          <CanMessageSpec spec={SPECS[msg.key]} data={summary?.data} />
        </div>
      </div>
    </details>
  );
};

const CanModulePanel: React.FC<Props> = ({ module, title, devices, busy, onSave, onConnect, onDisconnect }) => {
  const conn = module.connection;
  const tx = module.tx;
  const messages = module.messages ?? [];
  const summaries = module.summaries ?? [];
  const log = module.log ?? [];

  // Нет списка сообщений — шлюз собран до этих правок, показываем только подключение
  const stale = !module.messages;

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

  // Зависимости — примитивы, а не объект tx: он новый на каждый опрос статуса
  useEffect(() => {
    if (!tx) return;
    setPeriod(String(tx.period_ms));
    setTtl(String(tx.payload_ttl_ms));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx?.period_ms, tx?.payload_ttl_ms]);

  const saveConnection = () =>
    onSave({ mode, iface, device, bitrate: parseNum(bitrate) ?? 250000, enabled });

  // Период и жизнь нагрузки уходят по уходу с поля, тумблеры — сразу
  const commitPeriod = () => {
    const p = parseNum(period);
    if (p === null) {
      setTxError('Период — число в миллисекундах');
      return;
    }
    setTxError('');
    if (tx && p !== tx.period_ms) onSave({ tx_period_ms: p });
  };
  const commitTtl = () => {
    const t = parseNum(ttl);
    if (t === null) {
      setTxError('Жизнь нагрузки — число в миллисекундах');
      return;
    }
    setTxError('');
    if (tx && t !== tx.payload_ttl_ms) onSave({ payload_ttl_enabled: tx.ttl_enabled ?? true, payload_ttl_ms: t });
  };

  const sumOf = (key: string) => summaries.find((s) => s.key === key);
  const rxMessages = messages.filter((m) => m.dir === 'rx');
  const txMessages = messages.filter((m) => m.dir === 'tx');
  const shown = log.filter((r) => filter === 'all' || r.dir === filter);

  const canOptions = (devices?.can ?? []).map((c) => ({
    value: c.name,
    label: `${c.name} · ${c.up ? 'поднят' : 'не поднят'}`,
  }));
  const serialOptions = (devices?.serial ?? []).map((s) => ({ value: s.name, label: s.name }));

  const ttlOn = tx?.ttl_enabled ?? true;

  return (
    <>
      <div className="mod-title">
        <h2>{title}</h2>
        <Pill module={module} />
        <span className="pill">J1939 · {conn.mode ?? 'socketcan'} · {conn.mode === 'slcan' ? conn.device ?? '—' : conn.iface ?? '—'}</span>
        <button type="button" className="btn btn--ghost spacer" onClick={onDisconnect} disabled={busy}>Отключить</button>
        <button type="button" className="btn" onClick={onConnect} disabled={busy}>
          <Icon name="refresh" size={16} />Переподключить
        </button>
        <button type="button" className="btn btn--acc" onClick={saveConnection} disabled={busy}>Применить</button>
      </div>

      <div className="mod-rows">
        <div className="card">
          <div className="card-b">
            <div className="form">
              <div className="fc">
                <span className="cap">Режим</span>
                <div className="seg">
                  <button type="button" className={mode === 'socketcan' ? 'is-on' : ''} onClick={() => setMode('socketcan')}>SocketCAN</button>
                  <button type="button" className={mode === 'slcan' ? 'is-on' : ''} onClick={() => setMode('slcan')}>slcan (serial)</button>
                </div>
              </div>
              {mode === 'socketcan' ? (
                <div className="fc" style={{ flex: '0 1 220px' }}>
                  <label className="cap" htmlFor="krsps-can-iface">Интерфейс CAN</label>
                  <DeviceSelect
                    id="krsps-can-iface"
                    value={iface}
                    options={canOptions}
                    emptyText="CAN-интерфейсов не найдено"
                    onChange={setIface}
                  />
                </div>
              ) : (
                <>
                  <div className="fc" style={{ flex: '0 1 220px' }}>
                    <label className="cap" htmlFor="krsps-can-dev">Serial-порт</label>
                    <DeviceSelect
                      id="krsps-can-dev"
                      value={device}
                      options={serialOptions}
                      emptyText="Serial-портов не найдено"
                      onChange={setDevice}
                    />
                  </div>
                  <div className="fc" style={{ flex: '0 1 180px' }}>
                    <label className="cap" htmlFor="krsps-can-bitrate">Скорость шины</label>
                    <select id="krsps-can-bitrate" className="sel" value={bitrate} onChange={(e) => setBitrate(e.target.value)}>
                      {BITRATES.map((b) => (
                        <option key={b} value={b}>
                          {formatInt(b)} бит/с
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}
              <span className="vsep" />
              <div className="fc">
                <span className="cap">Обмен по шине</span>
                <div className="row">
                  <Switch on={enabled} onToggle={setEnabled}>{enabled ? 'включён' : 'выключен'}</Switch>
                </div>
              </div>
            </div>
            {conn.error && (
              <div className="banner is-err" style={{ marginTop: 14 }}>
                <Icon name="warn" size={15} />
                Шина: {humanizeError(conn.error)}
              </div>
            )}
          </div>
        </div>

        {stale && (
          <div className="card">
            <div className="card-b">
              <div className="banner">
                <Icon name="warn" size={15} />
                Шлюз собран до появления списка сообщений: состав сообщений, камеры и лента шины появятся после пересборки message-gateway.
              </div>
            </div>
          </div>
        )}

        {!stale && (
          <>
            <div className="card">
              <div className="card-h">
                <h3>Состояние сообщений</h3>
                <span className="meta">последнее значение каждого типа</span>
              </div>
              <div className="card-b" style={{ padding: '0 6px' }}>
                {summaries.length > 0 ? (
                  <table className="tab-msgs">
                    <tbody>
                      {summaries.map((s) => (
                        <tr key={s.key}>
                          <td style={{ width: 40 }}><span className={`dir ${s.dir}`}>{s.dir.toUpperCase()}</span></td>
                          <td className="m" style={{ width: 100 }}>{s.id}</td>
                          <td className="nm">{s.title}</td>
                          <td className="m" style={{ color: 'var(--fg-2)' }}>{s.data || '—'}</td>
                          <td className="dim">{s.note || (s.enabled ? '—' : 'выключено')}</td>
                          <td className="m r">
                            {formatInt(s.count)}
                            {s.errors > 0 && <span style={{ color: 'var(--err)' }}> · {formatInt(s.errors)} ош.</span>}
                          </td>
                          <td className="n r">{age(s.age_ms)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="empty"><b>Сообщений нет</b></div>
                )}
              </div>
            </div>

            <div className="card">
              <div className="card-h">
                <h3>Сообщения шины</h3>
                <span className="meta">{txMessages.length} отпр. · {rxMessages.length} прин.</span>
              </div>
              <div className="card-b">
                {txMessages.map((m) => (
                  <MessageBlock key={m.key} msg={m} summary={sumOf(m.key)} busy={busy} onPatch={onSave}>
                    <div>
                      <span className="sub-h">Постоянная передача</span>
                      <div className="hf">
                        <div className="fc">
                          <span className="cap">Слать постоянно</span>
                          <div className="row">
                            <Switch
                              on={!!tx?.continuous}
                              disabled={busy}
                              onToggle={(v) => onSave({ tx_continuous: v })}
                            >
                              {tx?.continuous ? 'включено' : 'выключено'}
                            </Switch>
                          </div>
                        </div>
                        {/* Период имеет смысл только у постоянной выдачи */}
                        <div className="fc">
                          <span className="cap">Период, мс</span>
                          <input
                            className="inp"
                            value={period}
                            inputMode="numeric"
                            disabled={!tx?.continuous}
                            onChange={(e) => setPeriod(e.target.value.replace(/[^\d]/g, ''))}
                            onBlur={commitPeriod}
                            onKeyDown={blurOnEnter}
                          />
                        </div>
                        {/* Флаг ограничения по времени и само значение — один элемент */}
                        <div className="fc">
                          <span className="cap">{ttlOn ? 'Жизнь нагрузки, мс' : 'Жизнь нагрузки'}</span>
                          <div className="row">
                            <Switch
                              on={ttlOn}
                              disabled={busy}
                              onToggle={(v) => onSave({ payload_ttl_enabled: v, payload_ttl_ms: parseNum(ttl) ?? tx?.payload_ttl_ms })}
                            >
                              {''}
                            </Switch>
                            <input
                              className="inp"
                              value={ttl}
                              inputMode="numeric"
                              disabled={busy || !ttlOn}
                              onChange={(e) => setTtl(e.target.value.replace(/[^\d]/g, ''))}
                              onBlur={commitTtl}
                              onKeyDown={blurOnEnter}
                            />
                          </div>
                        </div>
                      </div>
                      {txError && <p className="hint is-err">{txError}</p>}
                    </div>
                  </MessageBlock>
                ))}
                {rxMessages.map((m) => (
                  <MessageBlock key={m.key} msg={m} summary={sumOf(m.key)} busy={busy} onPatch={onSave} />
                ))}
                {messages.length === 0 && <div className="empty"><b>Сообщений нет</b></div>}
              </div>
            </div>

            <div className="card">
              <div className="card-h">
                <h3>Лента шины</h3>
                <div className="seg seg--xs">
                  {(['all', 'rx', 'tx'] as const).map((f) => (
                    <button key={f} type="button" className={filter === f ? 'is-on' : ''} onClick={() => setFilter(f)}>
                      {f === 'all' ? 'Все' : f === 'rx' ? 'Приём' : 'Передача'}
                    </button>
                  ))}
                </div>
                <span className="meta">
                  {shown.length} · чужих кадров {formatInt(module.rx_other ?? 0)}
                </span>
              </div>
              <div className="card-b">
                {shown.length > 0 ? (
                  <div className="feed">
                    {shown.map((r) => (
                      <div key={r.seq}>
                        <span className="t">{formatClock(r.ts)}</span>{' '}
                        <span className={`dir ${r.dir}`}>{r.error ? '!' : r.dir.toUpperCase()}</span>{' '}
                        <span className="id">{r.id}</span> {r.data}{' '}
                        <span className={`n${r.error ? ' is-err' : ''}`}>{r.error ? humanizeError(r.error) : r.note}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty"><b>Кадров на шине пока не было</b></div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
};

export default CanModulePanel;
