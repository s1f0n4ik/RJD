import { useEffect, useRef } from 'react';
import { Icon } from './Icons';

// Стек открытых модалок: Esc закрывает только верхнюю, а не все сразу
const modalStack: symbol[] = [];

// Открыта ли хоть одна модалка; нужно тем, кто тоже слушает Esc
export const isModalOpen = (): boolean => modalStack.length > 0;

interface ModalProps {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    footer?: React.ReactNode;
    /** Ширина: обычная 560, mid 720, wide 940 — как в макете */
    size?: 'default' | 'mid' | 'wide';
    /** Дополнительная строка в шапке рядом с заголовком */
    head?: React.ReactNode;
    /** Дополнительный класс окна — для нестандартных размеров */
    className?: string;
}

export function Modal({ title, onClose, children, footer, size = 'default', head, className }: ModalProps) {
    const idRef = useRef(Symbol('modal'));

    useEffect(() => {
        const id = idRef.current;
        modalStack.push(id);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && modalStack[modalStack.length - 1] === id) onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => {
            const i = modalStack.indexOf(id);
            if (i >= 0) modalStack.splice(i, 1);
            document.removeEventListener('keydown', onKey);
        };
    }, [onClose]);

    const sizeClass = size === 'wide' ? ' modal--wide' : size === 'mid' ? ' modal--mid' : '';

    return (
        <div
            className="overlay"
            onMouseDown={e => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className={`modal${sizeClass}${className ? ` ${className}` : ''}`} role="dialog" aria-label={title}>
                <div className="modal-h">
                    <h3>{title}</h3>
                    {head}
                    <button className="x" onClick={onClose} aria-label="Закрыть">
                        <Icon name="x" size={15} />
                    </button>
                </div>
                {children}
                {footer && <div className="modal-f">{footer}</div>}
            </div>
        </div>
    );
}

interface SwitchProps {
    on: boolean;
    onToggle: (next: boolean) => void;
    children: React.ReactNode;
    disabled?: boolean;
}

export function Switch({ on, onToggle, children, disabled }: SwitchProps) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            className={`sw${on ? ' is-on' : ''}`}
            style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
            onClick={() => !disabled && onToggle(!on)}
        >
            <i />
            {children}
        </button>
    );
}
