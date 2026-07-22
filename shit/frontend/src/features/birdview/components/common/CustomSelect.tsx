import { useEffect, useRef, useState } from 'react';

/**
 * Выпадающий список в теме страницы.
 *
 * Нативный <select> здесь не годится: список опций рисует ОС, и на тёмной
 * странице он выглядит инородно. Тот же вывод уже сделан в features/neural,
 * но переиспользовать тот компонент нельзя — он завязан на классы из
 * neural/theme.css, а темы фич намеренно изолированы друг от друга.
 */

export interface SelectOption {
    value: string;
    label: string;
    /** Вариант выбирается, но помечен как неподходящий — приглушённый. */
    muted?: boolean;
    /** Правая подпись в строке: разрешение, признак и подобное. */
    note?: string;
}

interface CustomSelectProps {
    options: SelectOption[];
    value: string | null;
    placeholder?: string;
    emptyText?: string;
    /** Вызывается при раскрытии списка — например, чтобы подгрузить варианты. */
    onOpen?: () => void;
    onChange: (value: string) => void;
}

export function CustomSelect({
    options,
    value,
    placeholder = '—',
    emptyText = 'Нет вариантов',
    onOpen,
    onChange,
}: CustomSelectProps) {
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

    const selected = options.find(o => o.value === value);

    return (
        <div className={`custom-select${open ? ' open' : ''}`} ref={ref}>
            <button
                type="button"
                className="custom-select-trigger"
                onClick={e => {
                    e.stopPropagation();
                    setOpen(v => {
                        if (!v) onOpen?.();
                        return !v;
                    });
                }}
            >
                <span className={`custom-select-label${selected ? ' selected' : ''}`}>
                    {selected ? selected.label : placeholder}
                </span>
                <span className="custom-select-arrow">›</span>
            </button>

            {open && (
                <div className="custom-select-dropdown">
                    {options.length === 0 ? (
                        <div className="custom-select-empty">{emptyText}</div>
                    ) : (
                        <div className="custom-select-list">
                            {options.map(o => (
                                <div
                                    key={o.value}
                                    className={
                                        'custom-select-item' +
                                        (o.value === value ? ' selected' : '') +
                                        (o.muted ? ' muted' : '')
                                    }
                                    onClick={e => {
                                        e.stopPropagation();
                                        onChange(o.value);
                                        setOpen(false);
                                    }}
                                >
                                    <span className="custom-select-item-name">{o.label}</span>
                                    {o.note && <span className="custom-select-item-note">{o.note}</span>}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
