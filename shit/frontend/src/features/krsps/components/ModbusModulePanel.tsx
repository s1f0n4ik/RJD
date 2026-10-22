import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../app/Icons';
import { Switch, Seg } from '../../../app/Modal';
import { Select } from '../../../app/Select';
import type {
  GwDevices,
  GwModbusConfigPatch,
  GwModbusExchange,
  GwModbusModule,
  GwModbusRecent,
  GwModbusRecord,
  GwPacketField,
} from '../types';
import { formatInt } from '../utils/format';
import { humanizeError } from '../utils/errors';
import { blurOnEnter, connState, DeviceSelect, PILL_LABEL, PILL_TONE, Pill } from './ModuleBits';
import { fieldText, type Dictionaries } from '../utils/dictionaries';
import { FitText } from '../../../app/FitText';

interface Props {
  module: GwModbusModule;
  title: string;
  devices: GwDevices | null;
  // Пояс шлюза, минуты от UTC
  tzMin: number;
  // Словари мастера: code, zone, cameras
  dicts: Dictionaries;
  busy: boolean;
  onSave: (patch: GwModbusConfigPatch) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const PARITY: Array<['none' | 'even' | 'odd', string]> = [
  ['none', 'Нет'],
  ['even', 'Чёт'],
  ['odd', 'Нечёт'],
];

// Блок 0x1000–0x1006 протокола v2.3
const BLOCK_CAPS = ['идентификатор', 'версия', 'длина записи', 'регистров окна', 'регистров команд', 'регистров состояния', 'записей'];

const STATUS: Record<GwModbusRecent['status'], [string, string]> = {
  queued: ['ждёт чтения', 'is-acc'],
  hidden: ['скрыта', 'is-warn'],
  read: ['прочитана', 'is-ok'],
  dropped: ['выброшена', 'is-err'],
};

const KIND: Record<string, string> = {
  info: 'устройство',
  state: 'состояние',
  records: 'записи',
  write: 'запись регистров',
  time: 'время и GPS',
  mark: 'отметка',
  unsupported: 'функция',
};
const EXCEPTION: Record<number, string> = { 1: 'функция не поддерживается', 2: 'неверный адрес', 3: 'неверное значение' };

// Тон поля пакета по роду
const TONE: Record<string, string> = { number: 't-no', time: 't-time', geo: 't-geo', detection: 't-det', frame: 't-frame' };

type Filter = 'all' | 'records' | 'time' | 'errors';
const FILTERS: Array<[Filter, string]> = [
  ['all', 'Все'],
  ['records', 'Записи'],
  ['time', 'Время'],
  ['errors', 'Ошибки'],
];

// Тишина ведущего, после которой время считается устаревшим, как в шлюзе
const SILENCE_MS = 15_000;

const two = (n: number) => String(n).padStart(2, '0');
const hex = (n: number, w = 4) => n.toString(16).toUpperCase().padStart(w, '0');

// Часы и дата из ms, уже сдвинутых на пояс
function clock(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}
function day(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getUTCDate())}.${two(d.getUTCMonth() + 1)}`;
}

const sec = (ms: number) => `${ms > 0 ? '' : ms < 0 ? '−' : ''}${(Math.abs(ms) / 1000).toFixed(1).replace('.', ',')}`;

// Сколько прошло: до минуты секунды с десятой, дальше минуты и секунды
function ago(ms: number): string {
  if (ms < 60_000) return `${sec(ms)} с`;
  return `${Math.floor(ms / 60_000)} мин ${Math.floor((ms % 60_000) / 1000)} с`;
}

const coord = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(4)}° ${v < 0 ? neg : pos}`;

function exchangeNote(e: GwModbusExchange): string[] {
  const d = e.detail;
  if (d.error) return [humanizeError(d.error)];
  if (e.exception) return [`исключение ${hex(e.exception, 2)}`, EXCEPTION[e.exception] ?? ''];
  switch (e.kind) {
    case 'state':
      return [`записей ${d.count}`, d.queued != null && d.queued !== d.count ? `в очереди ${d.queued}` : '', `состояние ${d.state}`];
    case 'records':
      return [d.records?.length ? d.records.join(', ') : 'окно пустое'];
    case 'mark':
      return [`${d.first}–${d.last}`, d.ok ? `снято ${d.removed}` : `отклонена, первая ${d.head ?? '—'}`];
    case 'time': {
      const out: string[] = [];
      if (d.time_ok !== undefined) out.push(d.time_ok ? `${clock((d.unix_s ?? 0) * 1000)} UTC` : 'время вне 2025–2050');
      if (d.gps_ok !== undefined) out.push(d.gps_ok ? `${coord(d.lat ?? 0, 'N', 'S')} ${coord(d.lon ?? 0, 'E', 'W')}` : 'координаты не разобраны');
      return out;
    }
    default:
      return [];
  }
}

function passes(f: Filter, e: GwModbusExchange): boolean {
  if (f === 'records') return e.kind === 'records' || e.kind === 'mark';
  if (f === 'time') return e.kind === 'time';
  if (f === 'errors') return !!(e.exception || e.detail.error);
  return true;
}

const Seps: React.FC<{ parts: React.ReactNode[] }> = ({ parts }) => (
  <span className="seps">
    {parts.filter(Boolean).map((p, i) => (
      <span key={i}>{p}</span>
    ))}
  </span>
);

// Возраст из статуса шлюза дотикивает от момента ответа
const Since: React.FC<{ ms: number; at: number; children: (ms: number) => string }> = ({ ms, at, children }) => {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((v) => v + 1), 100);
    return () => window.clearInterval(t);
  }, []);
  return <>{children(ms + performance.now() - at)}</>;
};

// Регистры поля шестнадцатерично; ряд одинаковых — одним значением с кратностью
function fieldHex(regs: number[], f: GwPacketField): string {
  const part = regs.slice(f.reg, f.reg + f.count);
  if (part.length > 3 && part.every((v) => v === part[0])) return `${hex(part[0])} × ${part.length}`;
  return part.map((v) => hex(v)).join(' ');
}

// ── Запись в начале окна: ряды по 16 регистров, поля по описанию кодека ──
const Packet: React.FC<{ r: GwModbusRecord }> = ({ r }) => (
  <div className="mb-pkt">
    {Array.from({ length: Math.ceil(r.regs.length / 16) }, (_, row) => (
      <React.Fragment key={row}>
        <div className="mb-ruler">
          {Array.from({ length: 16 }, (_, i) => (
            <span key={i}>{hex(0x2000 + row * 16 + i)}</span>
          ))}
        </div>
        <div className="mb-row">
          {r.fields
            .filter((f) => Math.floor(f.reg / 16) === row)
            .map((f) => (
              <div
                key={f.reg}
                className={f.kind === 'reserved' ? 'mb-f off' : `mb-f mb-t ${TONE[f.kind] ?? ''}`}
                style={{ gridColumn: `${(f.reg % 16) + 1} / span ${Math.min(f.count, 16 - (f.reg % 16))}` }}
                data-tip={f.text}
              >
                <span className="c">{f.label}</span>
                <span className="v">
                  {f.value}
                  {f.note && <> <small>{f.note}</small></>}
                </span>
                <span className="h">{fieldHex(r.regs, f)}</span>
              </div>
            ))}
        </div>
      </React.Fragment>
    ))}
  </div>
);

// Пустое окно на невидимом каркасе пакета той же длины — высота как у заполненного
const EmptyWindow: React.FC<{ regs: number; hidden: number }> = ({ regs, hidden }) => (
  <div className="mb-win">
    <div className="mb-pkt" style={{ visibility: 'hidden' }}>
      {Array.from({ length: Math.ceil(regs / 16) }, (_, row) => (
        <React.Fragment key={row}>
          <div className="mb-ruler"><span>0</span></div>
          <div className="mb-row">
            <div className="mb-f off"><span className="c">0</span><span className="v">0</span><span className="h">0</span></div>
          </div>
        </React.Fragment>
      ))}
    </div>
    <div className="mb-pkt-empty">
      <Icon name="lock" size={18} />
      <b>Окно пустое</b>
      {hidden > 0 && <span>скрыто {formatInt(hidden)}</span>}
    </div>
  </div>
);

// Столбцы таблицы записей: поля с пометкой brief; столбец с расшифровкой хоть у одной записи — широкий, число с названием слева, остальные — число справа
const briefOf = (r: GwModbusRecord) => r.fields.filter((f) => f.brief);
const wideOf = (records: GwModbusRecord[]) =>
  new Set(records.flatMap((r) => briefOf(r).filter((f) => f.text).map((f) => f.reg)));
const columnsOf = (brief: GwPacketField[], wide: Set<number>) =>
  ['62px', '104px', '104px', ...brief.map((f) => (wide.has(f.reg) ? 'minmax(0,1.4fr)' : '76px'))].join(' ');

const RecordLine: React.FC<{ e: GwModbusRecent; win: boolean; tzMs: number; wide: Set<number> }> = ({ e, win, tzMs, wide }) => {
  const [label, tone] = STATUS[e.status];
  const done = e.status === 'read' || e.status === 'dropped';
  const hidden = e.status === 'hidden';
  return (
    <div className={`mb-rec${win ? ' is-win' : ''}${done ? ' is-read' : ''}`}>
      <span className="no">
        {e.number}
        {win && <small>0x2000</small>}
      </span>
      <span className="st">
        <span className={`tag ${tone}`}>{label}</span>
      </span>
      <span className={`tm${hidden ? ' is-board' : ''}`}>
        {clock(e.ts + tzMs)}
        <small>{hidden ? 'часы платы' : day(e.ts + tzMs)}</small>
      </span>
      {briefOf(e).map((f) =>
        wide.has(f.reg) ? (
          <span key={f.reg} className="cd">
            <i>{f.value}</i>
            <FitText text={f.text ?? ''} />
          </span>
        ) : (
          <span key={f.reg} className={f.kind === 'frame' ? 'fr' : 'ct'}>
            {f.value}
          </span>
        ),
      )}
    </div>
  );
};

// Поле числа: уходит по уходу с поля, вне диапазона возвращается к сохранённому
const NumField: React.FC<{
  cap: string;
  value: number;
  min: number;
  max: number;
  width: number;
  disabled: boolean;
  onCommit: (v: number) => void;
  onError: (msg: string) => void;
}> = ({ cap, value, min, max, width, disabled, onCommit, onError }) => {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = parseInt(text, 10);
    if (!Number.isFinite(n) || n < min || n > max) {
      onError(`${cap} — от ${min} до ${max}`);
      setText(String(value));
      return;
    }
    onError('');
    if (n !== value) onCommit(n);
  };
  return (
    <div className="fc" style={{ flex: `0 0 ${width}px` }}>
      <span className="cap">{cap}</span>
      <input
        className="inp"
        value={text}
        inputMode="numeric"
        disabled={disabled}
        onChange={(e) => setText(e.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={blurOnEnter}
      />
    </div>
  );
};

// Ограничение 0x1006: тумблер и число в одной рамке; trim — ограничение сейчас срезает очередь
const LimitField: React.FC<{
  on: boolean;
  value: number;
  trim: boolean;
  disabled: boolean;
  onSave: (patch: GwModbusConfigPatch) => void;
}> = ({ on, value, trim, disabled, onSave }) => {
  const [local, setLocal] = useState(on);
  const [text, setText] = useState(String(value));
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const focusNext = useRef(false);
  useEffect(() => setLocal(on), [on]);
  useEffect(() => setText(String(value)), [value]);
  // Фокус в число после включения, когда поле снова доступно
  useEffect(() => {
    if (focusNext.current && local && !disabled) {
      focusNext.current = false;
      input.current?.focus();
      input.current?.select();
    }
  }, [local, disabled]);

  const toggle = () => {
    const next = !local;
    setLocal(next);
    if (next) {
      focusNext.current = true;
    } else {
      setText(String(value));
      setError('');
    }
    onSave({ limit_records: next });
  };
  const commit = () => {
    const n = parseInt(text, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535) {
      setError('Не больше записей — от 1 до 65 535');
      setShake(false);
      requestAnimationFrame(() => setShake(true));
      return;
    }
    setError('');
    if (n !== value) onSave({ max_records: n });
  };

  const cls = ['mb-lim', !local && 'is-off', local && trim && 'is-trim', error && 'is-err', shake && 'is-shake'].filter(Boolean).join(' ');
  return (
    <div className="fc mb-lim-fc" style={{ flex: '0 0 150px' }}>
      <span className="cap">Не больше записей</span>
      <div className={cls} onAnimationEnd={() => setShake(false)}>
        <button type="button" role="switch" aria-checked={local} aria-label="Ограничивать 0x1006" className={`sw${local ? ' is-on' : ''}`} disabled={disabled} onClick={toggle}>
          <i />
        </button>
        <span className="mb-lim-sep" />
        <input
          ref={input}
          className="mb-lim-in"
          value={text}
          inputMode="numeric"
          aria-label="Не больше записей"
          disabled={!local}
          onChange={(e) => setText(e.target.value.replace(/\D/g, '').slice(0, 5))}
          onBlur={commit}
          onKeyDown={blurOnEnter}
        />
      </div>
      <p className="mb-lim-hint">{error}</p>
    </div>
  );
};

function SegPick<T extends string | number>({ value, options, disabled, onPick }: {
  value: T;
  options: Array<[T, string]>;
  disabled: boolean;
  onPick: (v: T) => void;
}) {
  return (
    <Seg>
      {options.map(([v, label]) => (
        <button key={v} type="button" className={v === value ? 'is-on' : ''} disabled={disabled} onClick={() => v !== value && onPick(v)}>
          {label}
        </button>
      ))}
    </Seg>
  );
}

// Поля с ключом словаря получают расшифровку по словарям мастера
function decoded<T extends GwModbusRecord>(r: T, dicts: Dictionaries): T {
  return { ...r, fields: r.fields.map((f) => (f.dict ? { ...f, text: fieldText(dicts, f.dict, f.value) } : f)) };
}

const ModbusModulePanel: React.FC<Props> = ({ module, title, devices, tzMin, dicts, busy, onSave, onConnect, onDisconnect }) => {
  const [filter, setFilter] = useState<Filter>('all');
  const [formError, setFormError] = useState('');
  const seen = useRef({ module, at: performance.now() });
  if (seen.current.module !== module) seen.current = { module, at: performance.now() };
  const at = seen.current.at;

  const { connection: c, slave, master, time, gps, state, counters, log } = module;
  const queue = {
    ...module.queue,
    head: module.queue.head && decoded(module.queue.head, dicts),
    recent: module.queue.recent.map((r) => decoded(r, dicts)),
  };
  const tzMs = tzMin * 60_000;
  const st = connState(module);
  const portErr = humanizeError(c.error);

  const device = c.device ?? '/dev/ttyUSB0';
  const baud = c.baud ?? 115200;
  const parity = c.parity ?? 'none';
  const dataBits = c.data_bits ?? 8;
  const stopBits = c.stop_bits ?? 1;
  const line = `${baud} ${dataBits}${parity === 'even' ? 'E' : parity === 'odd' ? 'O' : 'N'}${stopBits}`;
  const summary = ['RS-485', device, line, `адрес ${slave.address}`];

  const hasTime = time.age_ms >= 0;
  const hasGps = gps.age_ms >= 0;

  const head = queue.head;
  const headNo = head?.number;
  // Очередь по порядку чтения, за ней прочитанные и выброшенные от свежих
  const waiting = queue.recent.filter((e) => e.status === 'queued' || e.status === 'hidden').reverse();
  const done = queue.recent.filter((e) => e.status === 'read' || e.status === 'dropped');
  const earlier = queue.visible - queue.recent.filter((e) => e.status === 'queued').length;
  const mark = queue.last_mark;

  const wide = wideOf(queue.recent);
  const columns = queue.recent.length ? columnsOf(briefOf(queue.recent[0]), wide) : '';
  const packetKinds = [...new Set([...(head ? [head] : []), ...queue.recent].map((r) => r.packet))];
  const serialOptions = (devices?.serial ?? []).map((s) => ({ value: s.name, label: s.name }));
  const shown = log.filter((e) => passes(filter, e));

  return (
    <>
      <div className="mod-title">
        <h2>{title}</h2>
        <Pill module={module} />
        <span className="pill">
          <Seps parts={summary} />
        </span>
        <button type="button" className="btn btn--ghost spacer" onClick={onDisconnect} disabled={busy}>Отключить</button>
        <button type="button" className="btn" onClick={onConnect} disabled={busy}>
          <Icon name="refresh" size={16} />Переподключить
        </button>
      </div>

      <div className="mod-rows">
        <div className="mb-tiles">
          <div className={`mb-tile${st === 'ok' ? ' is-ok' : st === 'err' ? ' is-err' : st === 'wait' ? ' is-warn' : ''}`}>
            <span className="c"><span className={`dot ${PILL_TONE[st]}`} />Порт</span>
            <b>{PILL_LABEL[st]}</b>
            <span className="s">
              {st === 'ok' || st === 'off' ? (
                <Seps parts={[device, line]} />
              ) : (
                <Seps parts={[portErr.split(': ').pop() || device, !!c.attempt && `попытка ${c.attempt}`]} />
              )}
            </span>
          </div>

          <div className={`mb-tile${master.online ? ' is-ok' : master.age_ms >= 0 ? ' is-err' : ''}`}>
            <span className="c"><span className={`dot ${master.online ? 'ok' : master.age_ms >= 0 ? 'err' : ''}`} />АС КРСПС</span>
            <b>{master.online ? 'На связи' : master.age_ms >= 0 ? 'Молчит' : 'Не опрашивала'}</b>
            <span className="s">
              {master.age_ms >= 0 && (
                <Since ms={master.age_ms} at={at}>{(v) => (master.online ? `запрос ${ago(v)} назад` : ago(v))}</Since>
              )}
            </span>
          </div>

          <div className={`mb-tile${hasTime ? '' : ' is-warn'}`}>
            <span className="c"><span className={`dot ${hasTime && time.age_ms <= SILENCE_MS ? 'ok' : 'warn'}`} />Время АС КРСПС</span>
            <b>{hasTime ? clock(time.unix_s * 1000 + tzMs) : 'Не приходило'}</b>
            <span className="s">
              {hasTime ? (
                <Since ms={time.age_ms} at={at}>{(v) => `${ago(v)} назад`}</Since>
              ) : (
                <Seps parts={[`скрыто ${formatInt(queue.hidden)}`]} />
              )}
            </span>
          </div>

          <div className={`mb-tile${hasGps ? '' : ' is-warn'}`}>
            <span className="c"><span className={`dot ${gps.valid ? 'ok' : 'warn'}`} />Координаты АС КРСПС</span>
            <b>{hasGps ? `${coord(gps.lat, 'N', 'S')} ${coord(gps.lon, 'E', 'W')}` : 'Не приходили'}</b>
            <span className="s">
              {hasGps && <Since ms={gps.age_ms} at={at}>{(v) => `${ago(v)} назад`}</Since>}
            </span>
          </div>
        </div>

        <details className="msg mb-fold">
          <summary>
            <Icon name="chev" size={12} />
            Подключение и регистры устройства
            <Seps parts={[...summary, slave.limit_records && `0x1006 ≤ ${slave.max_records}`]} />
          </summary>
          <div className="msg-b">
            <div>
              <div className="form">
                <div className="fc" style={{ flex: '0 1 210px' }}>
                  <span className="cap">Порт</span>
                  <DeviceSelect value={device} options={serialOptions} emptyText="Serial-портов не найдено" onChange={(v) => onSave({ device: v })} />
                </div>
                <div className="fc" style={{ flex: '0 1 150px' }}>
                  <span className="cap">Скорость</span>
                  <Select
                    value={String(baud)}
                    disabled={busy}
                    options={BAUDS.map((b) => ({ value: String(b), label: `${formatInt(b)} бит/с` }))}
                    onChange={(v) => onSave({ baud: Number(v) })}
                  />
                </div>
                <div className="fc">
                  <span className="cap">Чётность</span>
                  <SegPick value={parity} options={PARITY} disabled={busy} onPick={(v) => onSave({ parity: v })} />
                </div>
                <div className="fc">
                  <span className="cap">Биты данных</span>
                  <SegPick value={dataBits} options={[[7, '7'], [8, '8']]} disabled={busy} onPick={(v) => onSave({ data_bits: v })} />
                </div>
                <div className="fc">
                  <span className="cap">Стоп-биты</span>
                  <SegPick value={stopBits} options={[[1, '1'], [2, '2']]} disabled={busy} onPick={(v) => onSave({ stop_bits: v })} />
                </div>
                <span className="vsep" />
                <div className="fc">
                  <span className="cap">Обмен</span>
                  <div className="row">
                    <Switch on={c.enabled} disabled={busy} onToggle={(v) => onSave({ enabled: v })}>{c.enabled ? 'включён' : 'выключен'}</Switch>
                  </div>
                </div>
              </div>
              <div className="form mb-lim-row" style={{ marginTop: 14 }}>
                <NumField cap="Адрес" value={slave.address} min={1} max={247} width={76} disabled={busy} onCommit={(v) => onSave({ slave: v })} onError={setFormError} />
                <NumField cap="Идентификатор" value={slave.device_id} min={0} max={65535} width={108} disabled={busy} onCommit={(v) => onSave({ device_id: v })} onError={setFormError} />
                <NumField cap="Версия" value={slave.version} min={0} max={65535} width={76} disabled={busy} onCommit={(v) => onSave({ version: v })} onError={setFormError} />
                {slave.max_records != null && (
                  <>
                    <span className="vsep" />
                    <LimitField
                      on={!!slave.limit_records}
                      value={slave.max_records}
                      trim={queue.visible > slave.max_records}
                      disabled={busy}
                      onSave={onSave}
                    />
                  </>
                )}
              </div>
              {formError && <p className="hint is-err">{formError}</p>}
              {c.error && (
                <div className="banner is-err" style={{ marginTop: 14 }}>
                  <Icon name="warn" size={15} />
                  Порт: {portErr}
                  <span className="mb-retry">
                    <Seps
                      parts={[
                        !!c.attempt && `попытка ${c.attempt}`,
                        !!c.retry_in_ms && (
                          <Since ms={-c.retry_in_ms} at={at}>{(v) => `следующая через ${Math.max(0, Math.ceil(-v / 1000))} с`}</Since>
                        ),
                      ]}
                    />
                  </span>
                </div>
              )}
            </div>
            <div className="mb-regs">
              {module.block.map((v, i) => (
                <div key={i} className={`mb-reg${i === 6 ? ' is-live' : ''}`}>
                  <span className="a">0x{hex(0x1000 + i)}</span>
                  <span className="v">{v}</span>
                  <span className="c">{BLOCK_CAPS[i]}</span>
                  {i === 6 && queue.visible > v && <span className="mb-q">в очереди {formatInt(queue.visible)}</span>}
                </div>
              ))}
              {state.registers.map((r) => (
                <div key={r.addr} className={`mb-reg ${r.ok ? 'is-ok' : 'is-err'}`}>
                  <span className="a">0x{hex(r.addr)}</span>
                  <span className="v">{r.value}</span>
                  <span className="c">{r.label}</span>
                </div>
              ))}
            </div>
          </div>
        </details>

        <div className="card">
          <div className="card-h">
            <h3>Записи для АС КРСПС</h3>
            <span className="meta">
              <Seps parts={[packetKinds.length > 0 && `пакет ${packetKinds.join(', ')}`, `следующий № ${queue.next_number}`]} />
            </span>
          </div>
          <div className="card-b">
            <div className="kpis">
              <div className={`kpi${queue.visible && !master.online ? ' is-warn' : ''}`}>
                <span>Ждут чтения</span>
                <b>{formatInt(queue.visible)}</b>
              </div>
              <div className={`kpi${queue.hidden ? ' is-warn' : ''}`}>
                <span>Скрыто</span>
                <b>{formatInt(queue.hidden)}</b>
              </div>
              <div className={`kpi${queue.dropped ? ' is-err' : ''}`}>
                <span>Выброшено</span>
                <b>{formatInt(queue.dropped)}</b>
              </div>
              <div className={`kpi${!mark ? ' is-none' : mark.ok ? '' : ' is-warn'}`}>
                <span>Отправка</span>
                <b>
                  {mark ? (
                    <>
                      <Since ms={mark.age_ms} at={at}>{ago}</Since>
                      <small>{mark.ok ? 'назад' : 'назад, отклонена'}</small>
                    </>
                  ) : (
                    '—'
                  )}
                </b>
              </div>
            </div>
          </div>
          <div className="card-b" style={{ paddingTop: 0 }}>
            <span className="sub-h">
              <Seps parts={['Окно 0x2000', headNo !== undefined && `запись № ${headNo}`]} />
            </span>
            {head ? (
              <Packet r={head} />
            ) : (
              <EmptyWindow regs={queue.recent[0]?.regs.length || module.block[2] || 32} hidden={queue.hidden} />
            )}
          </div>
          <div className="card-b" style={{ paddingTop: 0 }}>
            <span className="sub-h">Последние записи</span>
            {queue.recent.length > 0 ? (
              <div className="mb-recs" style={{ '--cols': columns } as React.CSSProperties}>
                <div className="mb-rec is-head">
                  <span>№</span>
                  <span>Статус</span>
                  <span>Время</span>
                  {briefOf(queue.recent[0]).map((f) => (
                    <span key={f.reg} className={wide.has(f.reg) ? undefined : 'r'}>
                      {f.label}
                    </span>
                  ))}
                </div>
                {earlier > 0 && <div className="mb-more">ещё {formatInt(earlier)} ждут чтения</div>}
                {[...waiting, ...done].map((e) => (
                  <RecordLine key={`${e.number}-${e.status}-${e.ts}`} e={e} tzMs={tzMs} wide={wide} win={e.status === 'queued' && e.number === headNo} />
                ))}
              </div>
            ) : (
              <div className="empty"><b>Записей пока не было</b></div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>Обмен с АС КРСПС</h3>
            <Seg className="seg--xs">
              {FILTERS.map(([f, label]) => (
                <button key={f} type="button" className={filter === f ? 'is-on' : ''} onClick={() => setFilter(f)}>
                  {label}
                </button>
              ))}
            </Seg>
            <span className="meta">последние {log.length}</span>
          </div>
          <div className="card-b">
            <div className="mb-cnts">
              <div className="mb-cnt">
                <span>Запросов</span>
                <b>
                  {formatInt(counters.requests)}
                  {counters.broadcasts > 0 && <small>всем {formatInt(counters.broadcasts)}</small>}
                </b>
              </div>
              <div className={`mb-cnt${counters.crc_errors ? ' is-warn' : ''}`}>
                <span>Ошибок CRC</span>
                <b>{formatInt(counters.crc_errors)}</b>
              </div>
              <div className="mb-cnt">
                <span>Мусор</span>
                <b>
                  {formatInt(counters.garbage_bytes)}
                  <small>байт</small>
                </b>
              </div>
              <div className="mb-cnt">
                <span>Чужой адрес</span>
                <b>
                  {formatInt(counters.foreign)}
                  {counters.foreign > 0 && <small>№ {counters.foreign_last}</small>}
                </b>
              </div>
              <div className={`mb-cnt${counters.exceptions ? ' is-warn' : ''}`}>
                <span>Исключений</span>
                <b>{formatInt(counters.exceptions)}</b>
              </div>
            </div>
            {shown.length > 0 ? (
              <div className="feed mb-feed">
                {shown.map((e) => {
                  const bad = !!(e.exception || e.detail.error);
                  return (
                    <div key={e.seq}>
                      <span className="t">
                        {clock(e.ts + tzMs)}.{String(e.ts % 1000).padStart(3, '0')}
                      </span>
                      <span className={`mb-fc ${bad ? 'ex' : e.function === 4 ? 'rd' : 'wr'}`}>{hex(e.function, 2)}</span>
                      <span className="rg">{e.count > 1 ? `${hex(e.reg)}–${hex(e.reg + e.count - 1)}` : e.count ? hex(e.reg) : '—'}</span>
                      <span className="k">{KIND[e.kind] ?? '—'}</span>
                      <span className={`n${bad ? ' is-err' : ''}`}>
                        <Seps parts={[e.address === 0 && 'всем', ...exchangeNote(e)]} />
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="empty"><b>Обмена пока не было</b></div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default ModbusModulePanel;
