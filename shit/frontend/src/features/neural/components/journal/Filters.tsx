import { useState } from 'react';
import type { Verdict } from '../../api/journal-types';
import type { ClassOption } from './useClassResolver';
import { DateRangePicker } from './DateRangePicker';
import { fmtDate, fmtTime } from './format';

// Журнал почти всегда смотрят «за последнее время», поэтому основной способ —
// пресеты в один клик. Точный диапазон нужен реже и живёт за кнопкой «Период».
export type PresetKey = 'all' | 'today' | 'h24' | 'd7' | 'd30' | 'custom';

// По возрастанию охвата: журнал открывается на «Сегодня», а «Всё» — крайний
// случай, поэтому стоит последним.
const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'h24', label: '24 часа' },
  { key: 'd7', label: '7 дней' },
  { key: 'd30', label: '30 дней' },
  { key: 'all', label: 'Всё' },
];

/** Пресет, с которым открывается журнал. */
export const DEFAULT_PRESET: PresetKey = 'today';

const HOUR = 3600_000;

/** Диапазон по пресету. Пустые значения — фильтр по времени не применяется. */
export function presetRange(key: PresetKey): { from?: number; to?: number } {
  const now = Date.now();
  switch (key) {
    case 'today': {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return { from: d.getTime() };
    }
    case 'h24': return { from: now - 24 * HOUR };
    case 'd7': return { from: now - 7 * 24 * HOUR };
    case 'd30': return { from: now - 30 * 24 * HOUR };
    default: return {};
  }
}

const VERDICTS: { key: Verdict | 'all'; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'unverified', label: 'Непроверенные' },
  { key: 'true', label: 'Верно' },
  { key: 'false', label: 'Ложные' },
];

interface Props {
  preset: PresetKey;
  tFrom?: number;
  tTo?: number;
  verdict?: Verdict;
  selectedCids: number[];
  classOptions: ClassOption[];
  onPreset: (key: PresetKey) => void;
  onRange: (from?: number, to?: number) => void;
  onVerdict: (v?: Verdict) => void;
  onCids: (cids: number[]) => void;
}

export function Filters({
  preset,
  tFrom,
  tTo,
  verdict,
  selectedCids,
  classOptions,
  onPreset,
  onRange,
  onVerdict,
  onCids,
}: Props) {
  const [classOpen, setClassOpen] = useState(false);
  const [calOpen, setCalOpen] = useState(false);

  const toggleCid = (cid: number) => {
    const set = new Set(selectedCids);
    if (set.has(cid)) set.delete(cid);
    else set.add(cid);
    onCids([...set]);
  };

  const groups = new Map<string, ClassOption[]>();
  for (const c of classOptions) {
    const arr = groups.get(c.superName) ?? [];
    arr.push(c);
    groups.set(c.superName, arr);
  }

  const classLabel = selectedCids.length ? `Класс · ${selectedCids.length}` : 'Класс: все';

  const rangeLabel =
    preset === 'custom' && tFrom != null
      ? `${fmtDate(tFrom)} ${fmtTime(tFrom)} — ${tTo != null ? `${fmtDate(tTo)} ${fmtTime(tTo)}` : '…'}`
      : 'Период';

  return (
    <div className="jr-filters">
      <div className="jr-seg jr-seg-presets">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            className={preset === p.key ? 'on' : ''}
            onClick={() => onPreset(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="jr-class-wrap">
        <button
          className={`jr-fchip jr-click${preset === 'custom' ? ' act' : ''}`}
          onClick={() => setCalOpen((v) => !v)}
        >
          {rangeLabel}
        </button>
        {calOpen && (
          <>
            <div className="jr-class-backdrop" onClick={() => setCalOpen(false)} />
            <DateRangePicker
              from={tFrom}
              to={tTo}
              onApply={onRange}
              onClose={() => setCalOpen(false)}
            />
          </>
        )}
      </div>

      <div className="jr-class-wrap">
        <button
          className={`jr-fchip jr-click${selectedCids.length ? ' act' : ''}`}
          onClick={() => setClassOpen((v) => !v)}
        >
          {classLabel}
          <span className="jr-caret">▾</span>
        </button>
        {classOpen && (
          <>
            <div className="jr-class-backdrop" onClick={() => setClassOpen(false)} />
            <div className="jr-class-menu">
              {classOptions.length === 0 && <div className="jr-class-empty">нет классов</div>}
              {[...groups.entries()].map(([sup, items]) => (
                <div className="jr-class-group" key={sup}>
                  {sup && <div className="jr-class-sup">{sup}</div>}
                  {items.map((c) => (
                    <label className="jr-class-item" key={`${c.cid}:${c.name}`}>
                      <input
                        type="checkbox"
                        checked={selectedCids.includes(c.cid)}
                        onChange={() => toggleCid(c.cid)}
                      />
                      <span className="jr-cd" style={{ background: c.color }} />
                      {c.name}
                    </label>
                  ))}
                </div>
              ))}
              {selectedCids.length > 0 && (
                <button className="jr-class-clear" onClick={() => onCids([])}>
                  Сбросить
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <div className="jr-seg">
        {VERDICTS.map((v) => {
          const active = v.key === 'all' ? verdict == null : verdict === v.key;
          return (
            <button
              key={v.key}
              className={active ? 'on' : ''}
              onClick={() => onVerdict(v.key === 'all' ? undefined : (v.key as Verdict))}
            >
              {v.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
