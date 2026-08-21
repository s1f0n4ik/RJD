import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icons';

export interface SelectOption {
    value: string;
    label: string;
    /** Пояснение мелким текстом справа от подписи */
    hint?: string;
    disabled?: boolean;
}

interface SelectProps {
    value: string;
    options: SelectOption[];
    onChange: (value: string) => void;
    disabled?: boolean;
    placeholder?: string;
}

interface PopupPos {
    left: number;
    width: number;
    top?: number;
    bottom?: number;
}

/**
 * Селект приложения: нативный выпадающий список браузера стилизации не
 * поддаётся, поэтому попап свой — на токенах и с мягким появлением.
 * Позиционируется fixed от рамки кнопки: так его не режут прокручиваемые
 * контейнеры (шторка, тело модалки), а у нижней кромки экрана он открывается вверх.
 */
export function Select({ value, options, onChange, disabled, placeholder }: SelectProps) {
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(-1);
    const [pos, setPos] = useState<PopupPos | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const btnRef = useRef<HTMLButtonElement>(null);

    const selected = options.find(o => o.value === value) ?? null;

    const place = () => {
        const rect = btnRef.current?.getBoundingClientRect();
        if (!rect) return;
        const spaceBelow = window.innerHeight - rect.bottom;
        const openUp = spaceBelow < 220 && rect.top > spaceBelow;
        setPos({
            left: rect.left,
            width: rect.width,
            ...(openUp
                ? { bottom: window.innerHeight - rect.top + 5 }
                : { top: rect.bottom + 5 }),
        });
    };

    const openPopup = () => {
        if (disabled) return;
        setActive(options.findIndex(o => o.value === value));
        setOpen(true);
    };

    useLayoutEffect(() => {
        if (open) place();
    }, [open]);

    // Снаружи попапа: клик закрывает; прокрутка и ресайз тоже — fixed-позиция устаревает
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
        };
        const close = () => setOpen(false);
        document.addEventListener('mousedown', onDown);
        window.addEventListener('resize', close);
        document.addEventListener('scroll', close, true);
        return () => {
            document.removeEventListener('mousedown', onDown);
            window.removeEventListener('resize', close);
            document.removeEventListener('scroll', close, true);
        };
    }, [open]);

    const pick = (option: SelectOption) => {
        if (option.disabled) return;
        onChange(option.value);
        setOpen(false);
        btnRef.current?.focus();
    };

    const move = (delta: number) => {
        if (options.length === 0) return;
        let next = active;
        for (let i = 0; i < options.length; i++) {
            next = (next + delta + options.length) % options.length;
            if (!options[next].disabled) break;
        }
        setActive(next);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) { openPopup(); return; }
            move(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!open) openPopup();
            else if (options[active]) pick(options[active]);
        } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
        }
    };

    return (
        <div ref={rootRef} className={`uisel${open ? ' is-open' : ''}`} onKeyDown={onKeyDown}>
            <button
                ref={btnRef}
                type="button"
                className="uisel-btn"
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => (open ? setOpen(false) : openPopup())}
            >
                <span className="uisel-val">
                    {selected ? selected.label : <span className="muted">{placeholder ?? '—'}</span>}
                </span>
                <Icon name="chev" size={12} className="uisel-car" />
            </button>

            {open && pos && (
                <div
                    className={`uisel-pop${pos.bottom !== undefined ? ' is-up' : ''}`}
                    role="listbox"
                    style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
                >
                    {options.map((option, index) => (
                        <div
                            key={option.value}
                            role="option"
                            aria-selected={option.value === value}
                            className={[
                                'uisel-opt',
                                option.value === value ? 'is-selected' : '',
                                index === active ? 'is-active' : '',
                                option.disabled ? 'is-disabled' : '',
                            ].filter(Boolean).join(' ')}
                            onMouseEnter={() => !option.disabled && setActive(index)}
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => pick(option)}
                        >
                            <span className="lbl">{option.label}</span>
                            {option.hint && <span className="hint-t">{option.hint}</span>}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
