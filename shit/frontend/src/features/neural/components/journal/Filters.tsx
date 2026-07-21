import { useState } from 'react';
import type { Verdict } from '../../api/journal-types';
import type { ClassOption } from './useClassResolver';
import { localInputToMs } from './format';

function msToLocalInput(ms?: number): string {
  if (ms == null) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const VERDICTS: { key: Verdict | 'all'; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'unverified', label: 'Непроверенные' },
  { key: 'true', label: 'Верно' },
  { key: 'false', label: 'Ложные' },
];

interface Props {
  tFrom?: number;
  tTo?: number;
  verdict?: Verdict;
  selectedCids: number[];
  classOptions: ClassOption[];
  onTime: (from?: number, to?: number) => void;
  onVerdict: (v?: Verdict) => void;
  onCids: (cids: number[]) => void;
}

/** Панель фильтров журнала: диапазон времени, класс/суперкласс, статус вердикта. */
export function Filters({
  tFrom,
  tTo,
  verdict,
  selectedCids,
  classOptions,
  onTime,
  onVerdict,
  onCids,
}: Props) {
  const [classOpen, setClassOpen] = useState(false);

  const toggleCid = (cid: number) => {
    const set = new Set(selectedCids);
    if (set.has(cid)) set.delete(cid);
    else set.add(cid);
    onCids([...set]);
  };

  // Группировка классов по суперклассу для выпадающего списка.
  const groups = new Map<string, ClassOption[]>();
  for (const c of classOptions) {
    const arr = groups.get(c.superName) ?? [];
    arr.push(c);
    groups.set(c.superName, arr);
  }

  const classLabel = selectedCids.length ? `Класс · ${selectedCids.length}` : 'Класс: все';

  return (
    <div className="jr-filters">
      <label className="jr-fchip">
        <span className="jr-k">от</span>
        <input
          type="datetime-local"
          value={msToLocalInput(tFrom)}
          onChange={(e) => onTime(localInputToMs(e.target.value), tTo)}
        />
      </label>
      <label className="jr-fchip">
        <span className="jr-k">до</span>
        <input
          type="datetime-local"
          value={msToLocalInput(tTo)}
          onChange={(e) => onTime(tFrom, localInputToMs(e.target.value))}
        />
      </label>

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
