import { useEffect, useRef, useState } from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

interface CustomSelectProps {
  options: SelectOption[];
  value: string | null;
  placeholder?: string;
  onChange: (value: string) => void;
}

/** Кастомный select в стиле страницы (нативный <select> не темизуется). */
export function CustomSelect({ options, value, placeholder = '—', onChange }: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div className={`custom-select${open ? ' open' : ''}`} ref={ref}>
      <button type="button" className="custom-select-trigger" onClick={() => setOpen((v) => !v)}>
        <span className={`custom-select-value${selected ? '' : ' placeholder'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <span className="custom-select-arrow">▾</span>
      </button>
      {open && (
        <div className="custom-select-dropdown">
          <div className="custom-select-list">
            {options.length === 0 && <div className="custom-select-empty">нет вариантов</div>}
            {options.map((o) => (
              <div
                key={o.value}
                className={`custom-select-item${o.value === value ? ' selected' : ''}`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.label}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
