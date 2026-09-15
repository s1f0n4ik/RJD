import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { elementAnchor, usePopover } from '../../../../app/popover';
import type { SelectOption } from '../../../../app/Select';
import type { Verdict } from '../../api/journal-types';
import type { ClassOption } from './useClassResolver';
import { wallNow } from './format';

// Журнал почти всегда смотрят «за последнее время», поэтому основной способ —
// пресеты в один клик. Точный диапазон нужен реже и живёт в календаре.
export type PresetKey = 'all' | 'today' | 'h24' | 'd7' | 'd30' | 'custom';

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'h24', label: '24 ч' },
  { key: 'd7', label: '7 дней' },
  { key: 'd30', label: '30 дней' },
  { key: 'all', label: 'Всё' },
];

/** Пресет, с которым открывается журнал. */
export const DEFAULT_PRESET: PresetKey = 'today';

const HOUR = 3600_000;

/** Диапазон по пресету. Пустые значения — фильтр по времени не применяется.
 *  Границы считаются в настенном времени (ts журнала — время шлюза). */
export function presetRange(key: PresetKey): { from?: number; to?: number } {
  const now = wallNow();
  switch (key) {
    case 'today': {
      const d = new Date();
      return { from: Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) };
    }
    case 'h24': return { from: now - 24 * HOUR };
    case 'd7': return { from: now - 7 * 24 * HOUR };
    case 'd30': return { from: now - 30 * 24 * HOUR };
    default: return {};
  }
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  unverified: 'не проверено',
  true: 'подтверждено',
  false: 'ложное',
};

// Модификатор .vd и точка .dot по вердикту
export const VERDICT_CLASS: Record<Verdict, { vd: string; dot: string }> = {
  unverified: { vd: 'u', dot: '' },
  true: { vd: 't', dot: 'ok' },
  false: { vd: 'f', dot: 'err' },
};

// Пустое значение — «все»
export const VERDICT_OPTIONS: SelectOption[] = [
  { value: '', label: 'все' },
  { value: 'unverified', label: VERDICT_LABEL.unverified },
  { value: 'true', label: VERDICT_LABEL.true, dot: 'ok' },
  { value: 'false', label: VERDICT_LABEL.false, dot: 'err' },
];

interface PresetSegProps {
  preset: PresetKey;
  onPreset: (key: PresetKey) => void;
}

export function PresetSeg({ preset, onPreset }: PresetSegProps) {
  return (
    <div className="seg">
      {PRESETS.map((p) => (
        <button
          key={p.key}
          type="button"
          className={preset === p.key ? 'is-on' : ''}
          onClick={() => onPreset(p.key)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

interface PopoverProps {
  anchor: HTMLElement;
  onClose: () => void;
  // Поверх модалки: z-index выше .overlay
  over?: boolean;
  className?: string;
  children: ReactNode;
}

// Поповер под якорем: координаты ставит usePopover после отрисовки
export function Popover({ anchor, onClose, over, className, children }: PopoverProps) {
  const box = useMemo(() => elementAnchor(anchor), [anchor]);
  const ref = usePopover<HTMLDivElement>(box, { side: 'bottom', align: 'start', gap: 6 });

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchor.contains(t) || ref.current?.contains(t)) return;
      onClose();
    };
    // Esc перехватывается в фазе захвата: модалка под поповером не должна закрыться той же клавишей
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    const close = () => onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
    };
  }, [anchor, onClose, ref]);

  return createPortal(
    <div ref={ref} className={`j-pop${over ? ' is-over' : ''}${className ? ' ' + className : ''}`}>
      {children}
    </div>,
    document.body,
  );
}

interface ClassPickerProps {
  anchor: HTMLElement;
  options: ClassOption[];
  selected: number[];
  onChange: (cids: number[]) => void;
  onClose: () => void;
  over?: boolean;
}

// Список классов по суперклассам с чекбоксами
export function ClassPicker({ anchor, options, selected, onChange, onClose, over }: ClassPickerProps) {
  const groups = useMemo(() => {
    const map = new Map<string, ClassOption[]>();
    for (const c of options) {
      const arr = map.get(c.superName) ?? [];
      arr.push(c);
      map.set(c.superName, arr);
    }
    return [...map.entries()];
  }, [options]);

  const toggle = (cid: number) => {
    const set = new Set(selected);
    if (set.has(cid)) set.delete(cid);
    else set.add(cid);
    onChange([...set]);
  };

  return (
    <Popover anchor={anchor} onClose={onClose} over={over} className="j-cls">
      {options.length === 0 && <div className="j-cls-empty">Классов нет</div>}
      {groups.map(([sup, items]) => (
        <div className="j-cls-grp" key={sup}>
          {sup && <span className="eyebrow">{sup}</span>}
          {items.map((c) => (
            <label className="j-cls-item" key={`${c.cid}:${c.name}`}>
              <input type="checkbox" checked={selected.includes(c.cid)} onChange={() => toggle(c.cid)} />
              <i className="sw-col" style={{ background: c.color }} />
              {c.name}
            </label>
          ))}
        </div>
      ))}
      {selected.length > 0 && (
        <div className="j-cls-foot">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange([])}>
            Сбросить
          </button>
        </div>
      )}
    </Popover>
  );
}
