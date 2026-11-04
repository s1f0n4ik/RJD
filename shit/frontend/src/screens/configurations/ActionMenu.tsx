import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../../app/Icons';

export interface MenuItem {
    label: string;
    hint?: string;
    icon?: IconName;
    danger?: boolean;
    disabled?: boolean;
    onSelect: () => void;
}

interface Position {
    top: number;
    right: number;
}

// Меню «⋯»: попап в стиле выпадающих списков приложения, fixed от рамки кнопки
export function ActionMenu({ items, disabled, label }: { items: (MenuItem | null)[]; disabled?: boolean; label: string }) {
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState<Position | null>(null);
    const rootRef = useRef<HTMLSpanElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    useLayoutEffect(() => {
        const box = buttonRef.current?.getBoundingClientRect();
        if (open && box) setPosition({ top: box.bottom + 6, right: window.innerWidth - box.right });
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const close = () => setOpen(false);
        const onDown = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) close();
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                close();
                buttonRef.current?.focus();
            }
        };
        const onScroll = (event: Event) => {
            if (!rootRef.current?.contains(event.target as Node)) close();
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', close);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', close);
        };
    }, [open]);

    return (
        <span ref={rootRef} className="lb-menu">
            <button
                ref={buttonRef}
                type="button"
                className="lb-more"
                aria-label={label}
                aria-haspopup="menu"
                aria-expanded={open}
                disabled={disabled}
                onClick={() => setOpen((value) => !value)}
            >
                <Icon name="dots" size={18} />
            </button>
            {open && position && (
                <div className="uisel-pop lb-pop" role="menu" style={{ top: position.top, right: position.right }}>
                    {items.map((item, index) =>
                        item ? (
                            <button
                                key={item.label}
                                type="button"
                                role="menuitem"
                                className={`uisel-opt lb-menu-item${item.danger ? ' is-danger' : ''}${item.disabled ? ' is-disabled' : ''}`}
                                disabled={item.disabled}
                                onClick={() => {
                                    setOpen(false);
                                    item.onSelect();
                                }}
                            >
                                <span className="lbl">
                                    {item.icon && <Icon name={item.icon} size={16} />}
                                    <span className="lbl-t">{item.label}</span>
                                </span>
                                {item.hint && <span className="hint-t">{item.hint}</span>}
                            </button>
                        ) : (
                            <div key={`sep-${index}`} className="lb-pop-sep" role="separator" />
                        ),
                    )}
                </div>
            )}
        </span>
    );
}
