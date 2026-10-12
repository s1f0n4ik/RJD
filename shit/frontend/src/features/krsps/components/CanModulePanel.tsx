import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../../../app/Icons';
import { Switch } from '../../../app/Modal';
import { Select } from '../../../app/Select';
import type {
  GwCanConfigPatch,
  GwCanMessage,
  GwCanPayload,
  GwCanPayloadDetection,
  GwCanSummary,
  GwDevices,
  GwModule,
  GwTaxonomy,
  GwTaxonomyDictItem,
} from '../types';
import { formatInt, formatClock } from '../utils/format';
import { blurOnEnter, DeviceSelect, Kpi, Pill, RecordRow } from './ModuleBits';
import CanMessageSpec, { SPECS } from './CanMessageSpec';
import { humanizeError } from '../utils/errors';
import { useCameraNames } from '../../neural/components/journal/useCameraNames';
import { journalApi } from '../../neural/api/journal';
import type { JournalDetection } from '../../neural/api/journal-types';
import { durationLabel, REASON_LABEL } from '../../neural/components/journal/format';
import { useDeviceClock } from '../../../app/useDeviceClock';

interface Props {
  module: GwModule;
  title: string;
  devices: GwDevices | null;
  taxonomy: GwTaxonomy | null;
  busy: boolean;
  onSave: (patch: GwCanConfigPatch) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenTaxonomy: () => void;
}

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

// Возраст обнаружения: секунды с десятой, дольше минуты — минуты
function detAge(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} с`;
  return `${Math.floor(ms / 60_000)} мин`;
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

const detWord = (n: number) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'обнаружение';
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'обнаружения';
  return 'обнаружений';
};

const dictTitle = (items: GwTaxonomyDictItem[] | undefined, id: number) => items?.find((i) => i.id === id)?.title ?? '—';

// Движение карточки: длительность и кривая входа из общего набора плавности
const MOVE_MS = 320;
const EASE_IN = 'cubic-bezier(.2,.8,.2,1)';

interface BusRow {
  d: GwCanPayloadDetection;
  age: number;
  active: boolean;
  leaving: boolean;
}

// Список шлюза между опросами: возраст тикает, срок жизни гаснет вовремя, удалённые доживают на выходе
function useBusRows(dets: GwCanPayloadDetection[], ttlMs: number | null): BusRow[] {
  const [, tick] = useState(0);
  const seen = useRef({ at: performance.now(), dets });
  const gone = useRef(new Map<number, { d: GwCanPayloadDetection; at: number; leftAt: number }>());

  if (seen.current.dets !== dets) {
    const at = performance.now();
    const ids = new Set(dets.map((d) => d.id));
    for (const d of seen.current.dets) {
      if (!ids.has(d.id)) gone.current.set(d.id, { d, at: seen.current.at, leftAt: at });
    }
    ids.forEach((id) => gone.current.delete(id));
    seen.current = { at, dets };
  }

  useEffect(() => {
    const t = window.setInterval(() => tick((v) => v + 1), 100);
    return () => window.clearInterval(t);
  }, []);

  const now = performance.now();
  gone.current.forEach((g, id) => {
    if (now - g.leftAt > MOVE_MS) gone.current.delete(id);
  });
  const rows = [
    ...dets.map((d) => ({ d, age: d.age_ms + now - seen.current.at, leaving: false })),
    ...[...gone.current.values()].map((g) => ({ d: g.d, age: g.d.age_ms + now - g.at, leaving: true })),
  ];
  // Срок жизни отсчитывается от «Подтверждён», как в шлюзе; погасшее шлюзом не оживает
  return rows
    .map((r) => ({ ...r, active: r.d.active && (ttlMs === null || r.age <= ttlMs) }))
    .sort((x, y) => x.age - y.age);
}

// Сколько назад ушло: секунды, минуты, часы
function agoLabel(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${Math.floor(s)} с`;
  if (s < 3600) return `${Math.floor(s / 60)} мин`;
  return `${Math.floor(s / 3600)} ч`;
}

// Последние закрытые в журнале мастера; перечитываются раз в 5 с и при смене списка на шине
function useRecentClosed(key: string): JournalDetection[] {
  const [list, setList] = useState<JournalDetection[]>([]);
  useEffect(() => {
    let stop = false;
    const load = () =>
      journalApi
        .list({}, { limit: 20 })
        .then((r) => {
          if (!stop) setList(r.detections.filter((d) => d.ended_at != null));
        })
        .catch(() => {
          /* мастер недоступен — свободные строки останутся пустыми */
        });
    load();
    const t = window.setInterval(load, 5000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [key]);
  return list;
}

// Строки с data-k переезжают плавно: скачок положения после отрисовки гасится сдвигом
function useFlip(box: React.RefObject<HTMLElement>) {
  const pos = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) {
      pos.current.clear();
      return;
    }
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<string, number>();
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const k = child.dataset.k;
      if (!k) continue;
      const top = child.offsetTop;
      const was = pos.current.get(k);
      if (!still && was !== undefined && was !== top) {
        child.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }], { duration: MOVE_MS, easing: EASE_IN });
      }
      next.set(k, top);
    }
    pos.current = next;
  });
}

// ── Нагрузка на шине и список обнаружений шлюза, из которого она собрана ──
const BusNowCard: React.FC<{
  payload: GwCanPayload;
  dlc: number;
  ttlMs: number | null;
  taxonomy: GwTaxonomy | null;
  onOpenTaxonomy: () => void;
}> = ({ payload, dlc, ttlMs, taxonomy, onOpenTaxonomy }) => {
  const navigate = useNavigate();
  const { cameraName } = useCameraNames();
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useBusRows(payload.detections ?? [], ttlMs);
  useFlip(listRef);

  const present = rows.filter((r) => !r.leaving);
  const live = present.filter((r) => r.active);
  // Пока на шине одно-два обнаружения, свободные строки занимают недавно ушедшие из журнала
  const presentIds = new Set(present.map((r) => r.d.id));
  const closed = useRecentClosed([...presentIds].join(','));
  const { unixMs: deviceNow } = useDeviceClock();
  const slots = present.length > 0 ? Math.max(0, 3 - present.length) : 0;
  const past = closed
    .filter((j) => !presentIds.has(j.id))
    .sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0))
    .slice(0, slots);
  // Кадр собирается как в шлюзе: число живых, байты 2–4 — у самого опасного, при равной опасности у раннего
  const top = live.reduce<BusRow | null>(
    (b, r) => (!b || r.d.danger > b.d.danger || (r.d.danger === b.d.danger && r.age > b.age) ? r : b),
    null,
  );
  const count = live.length;
  const type = top?.d.type ?? 0;
  const danger = top?.d.danger ?? 0;
  const cameraNo = top?.d.camera_no ?? 0;
  const offCount = present.length - count;
  const firstOff = rows.findIndex((r) => !r.active && !r.leaving);

  // Плашка сворачивается со своим последним текстом, а не с нулём
  const gaps = present.filter((r) => !r.d.camera_no || r.d.passthrough).length;
  const lastGaps = useRef(gaps);
  if (gaps) lastGaps.current = gaps;
  const shownGaps = lastGaps.current;

  const session = payload.session
    ? new Date(payload.session).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '')
    : '';

  const rowEl = (r: BusRow) => {
    const { d } = r;
    const isTop = r === top;
    return (
      <div key={d.id} data-k={d.id} className={`cb-row${isTop ? ' is-top' : ''}${r.active ? '' : ' is-off'}${r.leaving ? ' is-leaving' : ''}`}>
        <span className="cb-id">
          {d.id}
          {isTop && <small>В КАДРЕ</small>}
        </span>
        <span className="cb-cam cb-t f3">
          <b>{cameraName(d.camera)}</b>
          <span className={d.camera_no ? undefined : 'is-warn'}>
            {d.camera} · {d.camera_no ? `№ ${d.camera_no}` : 'нет номера'}
          </span>
        </span>
        <span className="cb-val cb-t f2">
          <span className="n">{d.type}</span>
          <span className="t">{dictTitle(taxonomy?.types, d.type)}</span>
          {d.passthrough && <span className="cb-flag">без таблицы</span>}
        </span>
        <span className="cb-val cb-t f4">
          <span className="n">{d.danger}</span>
          <span className="t">{dictTitle(taxonomy?.dangers, d.danger)}</span>
        </span>
        <span className="cb-age">{detAge(r.age)}</span>
        <button
          type="button"
          className="btn btn--sm cb-go"
          tabIndex={r.leaving ? -1 : undefined}
          onClick={() => navigate('/neural/journal', { state: { open: d.id } })}
        >
          <Icon name="list" size={14} />В журнал
        </button>
      </div>
    );
  };

  const pastEl = (j: JournalDetection) => {
    const no = taxonomy?.cameras?.find((c) => c.key === j.camera_id)?.bit ?? 0;
    return (
      <div key={`p${j.id}`} data-k={`p${j.id}`} className="cb-row is-past">
        <span className="cb-id">
          {j.id}
          <small>УШЛО</small>
        </span>
        <span className="cb-cam">
          <b>{cameraName(j.camera_id)}</b>
          <span>
            {j.camera_id} · {no ? `№ ${no}` : 'нет номера'}
          </span>
        </span>
        <span className="cb-val">
          <span className="t">{j.class_name ?? '—'}</span>
          {j.closed_reason && <span className="cb-why">{REASON_LABEL[j.closed_reason] ?? j.closed_reason}</span>}
        </span>
        <span className="cb-val">
          <span className="t">длилось {durationLabel(j)}</span>
        </span>
        {/* Время журнала — настенное шлюза, как и часы изделия */}
        <span className="cb-age">{deviceNow != null && j.ended_at != null ? agoLabel(deviceNow - j.ended_at) : '—'}</span>
        <button type="button" className="btn btn--sm cb-go" onClick={() => navigate('/neural/journal', { state: { open: j.id } })}>
          <Icon name="list" size={14} />В журнал
        </button>
      </div>
    );
  };

  const items: React.ReactNode[] = [];
  rows.forEach((r, i) => {
    if (i === firstOff) items.push(<div key="sub" data-k="sub" className="cb-sub">Погасли по сроку · ждут удаления от мастера</div>);
    items.push(rowEl(r));
  });
  past.forEach((j) => items.push(pastEl(j)));

  return (
    <div className="card cb-card">
      <div className="card-h">
        <h3>На шине сейчас</h3>
        <span className="meta">
          <span className="seps">
            <span className="live">на шине {count}</span>
            {offCount > 0 && <span>погасло {offCount}</span>}
            {session ? <span>мастер с {session}</span> : <span className="is-warn">мастер не на связи</span>}
          </span>
        </span>
      </div>
      <div className="card-b">
        <div className={`cb-frame${dlc > 4 ? '' : ' no-tail'}`}>
          <div className="cb-byte cb-t f1">
            <span className="cap">Байт 1 · количество</span>
            <span className="w" key={`c${count}`}>{count} {detWord(count)}</span>
            <span className="h" key={`ch${count}`}>{hex2(count)}</span>
          </div>
          <div className={`cb-byte cb-t${count ? ' f2' : ''}`}>
            <span className="cap">Байт 2 · тип</span>
            <span className="w" key={`t${type}`}>{type ? dictTitle(taxonomy?.types, type) : <small>не задан</small>}</span>
            <span className="h" key={`th${type}`}>{hex2(type)}</span>
          </div>
          <div className={`cb-byte cb-t${count ? ' f4' : ''}`}>
            <span className="cap">Байт 3 · опасность</span>
            <span className="w" key={`d${danger}`}>{danger ? dictTitle(taxonomy?.dangers, danger) : <small>не задана</small>}</span>
            <span className="h" key={`dh${danger}`}>{hex2(danger)}</span>
          </div>
          <div className={`cb-byte cb-t${count ? ' f3' : ''}`}>
            <span className="cap">Байт 4 · камера</span>
            <span className="w" key={`k${count ? top?.d.camera : ''}${cameraNo}`}>
              {!count ? (
                <small>не задана</small>
              ) : cameraNo ? (
                <>
                  № {cameraNo} <small>{top ? cameraName(top.d.camera) : ''}</small>
                </>
              ) : (
                <small>без номера</small>
              )}
            </span>
            <span className="h" key={`kh${cameraNo}`}>{hex2(cameraNo)}</span>
          </div>
          {dlc > 4 && (
            <div className="cb-tail">
              <span className="cap">Байты 5–{dlc}</span>
              <span className="h">{Array(dlc - 4).fill('FF').join(' ')}</span>
            </div>
          )}
        </div>

        <div className="cb-scroll">
          {rows.length === 0 ? (
            <div className="cb-empty" key={session ? 'none' : 'nomaster'}>
              <Icon name="empty" size={28} />
              {session ? (
                <>
                  <b>Обнаружений нет</b>
                  <span>Новое появится здесь в момент «Подтверждён» от мастера обнаружений.</span>
                </>
              ) : (
                <>
                  <b>Мастер обнаружений не присылал сообщений</b>
                  <span>С запуска шлюза от мастера ничего не приходило. Проверьте, что detection-service запущен и видит шлюз.</span>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="cb-row is-head">
                <span>ID</span>
                <span>Камера</span>
                <span>Тип</span>
                <span>Опасность</span>
                <span className="r">Возраст</span>
                <span className="go" />
              </div>
              <div className="cb-list" ref={listRef}>
                {items}
              </div>
            </>
          )}
        </div>

        <div className={`cb-warn${gaps ? ' is-on' : ''}`} aria-hidden={!gaps}>
          <Icon name="warn" size={15} />
          У {shownGaps === 1 ? 'одного обнаружения' : `${shownGaps} обнаружений`} нет номера камеры или таблицы их конфигурации: в байт 4 уходит 0, тип берётся по id класса.
          <button type="button" tabIndex={gaps ? undefined : -1} onClick={onOpenTaxonomy}>Таблица соответствий</button>
        </div>
      </div>
    </div>
  );
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
          <span className="cnt-s seps">
            <span>{formatInt(summary.count)}</span>
            <span>{age(summary.age_ms)}</span>
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
                <button type="button" className={`seps${base === 'hex' ? ' is-on' : ''}`} onClick={() => switchBase('hex')}>
                  <span>16</span>
                  <span>HEX</span>
                </button>
                <button type="button" className={`seps${base === 'dec' ? ' is-on' : ''}`} onClick={() => switchBase('dec')}>
                  <span>10</span>
                  <span>DEC</span>
                </button>
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
          <span className="sub-h">
            <span className="seps">
              <span>Схема кадра</span>
              <span>8 байт</span>
            </span>
          </span>
          <CanMessageSpec spec={SPECS[msg.key]} data={summary?.data} />
        </div>
      </div>
    </details>
  );
};

const CanModulePanel: React.FC<Props> = ({ module, title, devices, taxonomy, busy, onSave, onConnect, onDisconnect, onOpenTaxonomy }) => {
  const conn = module.connection;
  const tx = module.tx;
  const messages = module.messages ?? [];
  const summaries = module.summaries ?? [];
  const log = module.log ?? [];
  const stats = module.stats;

  // Нет списка сообщений — шлюз собран до этих правок, показываем только подключение
  const stale = !module.messages;

  const mode = conn.mode ?? 'socketcan';
  const iface = conn.iface ?? 'can0';
  const device = conn.device ?? '/dev/ttyUSB0';
  const bitrate = String(conn.bitrate ?? 250000);
  const enabled = conn.enabled;

  const [period, setPeriod] = useState('');
  const [ttl, setTtl] = useState('');
  const [txError, setTxError] = useState('');
  const [filter, setFilter] = useState<'all' | 'tx' | 'rx'>('all');

  // Зависимости — примитивы, а не объект tx: он новый на каждый опрос статуса
  useEffect(() => {
    if (!tx) return;
    setPeriod(String(tx.period_ms));
    setTtl(String(tx.payload_ttl_ms));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx?.period_ms, tx?.payload_ttl_ms]);

  // Подключение целиком: смена любого поля пересоздаёт шину, поэтому уходит сразу
  const patchConnection = (part: Partial<GwCanConfigPatch>) =>
    onSave({ mode, iface, device, bitrate: parseNum(bitrate) ?? 250000, enabled, ...part });

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
        <span className="pill">
          <span className="seps">
            <span>J1939</span>
            <span>{conn.mode ?? 'socketcan'}</span>
            <span>{conn.mode === 'slcan' ? conn.device ?? '—' : conn.iface ?? '—'}</span>
          </span>
        </span>
        <button type="button" className="btn btn--ghost spacer" onClick={onDisconnect} disabled={busy}>Отключить</button>
        <button type="button" className="btn" onClick={onConnect} disabled={busy}>
          <Icon name="refresh" size={16} />Переподключить
        </button>
      </div>

      <div className="mod-rows">
        <div className="card">
          <div className="card-b">
            <div className="form">
              <div className="fc">
                <span className="cap">Режим</span>
                <div className="seg">
                  <button type="button" className={mode === 'socketcan' ? 'is-on' : ''} disabled={busy} onClick={() => mode !== 'socketcan' && patchConnection({ mode: 'socketcan' })}>SocketCAN</button>
                  <button type="button" className={mode === 'slcan' ? 'is-on' : ''} disabled={busy} onClick={() => mode !== 'slcan' && patchConnection({ mode: 'slcan' })}>slcan (serial)</button>
                </div>
              </div>
              {mode === 'socketcan' ? (
                <div className="fc" style={{ flex: '0 1 220px' }}>
                  <span className="cap">Интерфейс CAN</span>
                  <DeviceSelect
                    value={iface}
                    options={canOptions}
                    emptyText="CAN-интерфейсов не найдено"
                    onChange={(v) => patchConnection({ iface: v })}
                  />
                </div>
              ) : (
                <>
                  <div className="fc" style={{ flex: '0 1 220px' }}>
                    <span className="cap">Serial-порт</span>
                    <DeviceSelect
                      value={device}
                      options={serialOptions}
                      emptyText="Serial-портов не найдено"
                      onChange={(v) => patchConnection({ device: v })}
                    />
                  </div>
                  <div className="fc" style={{ flex: '0 1 180px' }}>
                    <span className="cap">Скорость шины</span>
                    <Select
                      value={bitrate}
                      options={BITRATES.map((b) => ({ value: String(b), label: `${formatInt(b)} бит/с` }))}
                      onChange={(v) => patchConnection({ bitrate: parseNum(v) ?? 250000 })}
                    />
                  </div>
                </>
              )}
              <span className="vsep" />
              <div className="fc">
                <span className="cap">Обмен по шине</span>
                <div className="row">
                  <Switch on={enabled} disabled={busy} onToggle={(v) => patchConnection({ enabled: v })}>{enabled ? 'включён' : 'выключен'}</Switch>
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
                Шлюз собран до появления списка сообщений: состав сообщений, нагрузка и лента шины появятся после пересборки message-gateway.
              </div>
            </div>
          </div>
        )}

        {!stale && (
          <>
            {module.payload && (
              <BusNowCard
                payload={module.payload}
                dlc={tx?.dlc ?? 8}
                ttlMs={tx && tx.ttl_enabled !== false ? tx.payload_ttl_ms : null}
                taxonomy={taxonomy}
                onOpenTaxonomy={onOpenTaxonomy}
              />
            )}

            <div className="card">
              <div className="card-h">
                <h3>Кадры от ядра</h3>
                <span className="meta">за сеанс</span>
              </div>
              <div className="card-b">
                <div className="kpis">
                  <Kpi label="Принято" value={formatInt(stats.accepted ?? 0)} />
                  <Kpi label="Обнаружений" value={formatInt(stats.detections)} />
                  <Kpi label="Не доставлено" value={formatInt(stats.undelivered ?? 0)} />
                </div>
              </div>
              <div className="card-b" style={{ paddingTop: 4, paddingBottom: 4 }}>
                {stats.recent.length > 0 ? (
                  stats.recent.map((r) => (
                    <RecordRow key={r.seq} r={r} sentNote="учтено в нагрузке шины" showVer={false} />
                  ))
                ) : (
                  <div className="empty"><b>Кадров пока не было</b></div>
                )}
              </div>
            </div>

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
                            <span className="seps">
                              <span>{formatInt(s.count)}</span>
                              {s.errors > 0 && <span style={{ color: 'var(--err)' }}>{formatInt(s.errors)} ош.</span>}
                            </span>
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
                <span className="meta">
                  <span className="seps">
                    <span>{txMessages.length} отпр.</span>
                    <span>{rxMessages.length} прин.</span>
                  </span>
                </span>
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
                  <span className="seps">
                    <span>{shown.length}</span>
                    <span>чужих кадров {formatInt(module.rx_other ?? 0)}</span>
                  </span>
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
