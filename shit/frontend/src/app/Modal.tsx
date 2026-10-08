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

// Подсказки [data-tip]: один слой на body, под элементом или над ним, в пределах окна
export function TipLayer() {
    useEffect(() => {
        const tip = document.createElement('div');
        tip.className = 'tip-layer';
        tip.hidden = true;
        document.body.appendChild(tip);
        let anchor: HTMLElement | null = null;
        const gap = 8;

        const hide = () => {
            anchor = null;
            tip.hidden = true;
        };
        const show = (el: HTMLElement) => {
            anchor = el;
            tip.textContent = el.dataset.tip ?? '';
            tip.hidden = false;
            const r = el.getBoundingClientRect();
            const left = Math.min(Math.max(r.left + r.width / 2 - tip.offsetWidth / 2, gap), window.innerWidth - tip.offsetWidth - gap);
            const below = r.bottom + gap;
            const top = below + tip.offsetHeight > window.innerHeight - gap ? r.top - gap - tip.offsetHeight : below;
            tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
        };
        const tipOf = (target: EventTarget | null) =>
            target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;

        const onOver = (e: PointerEvent) => {
            const el = tipOf(e.target);
            if (el === anchor) return;
            if (el?.dataset.tip) show(el);
            else hide();
        };
        const onOut = (e: PointerEvent) => {
            if (!e.relatedTarget) hide();
        };
        const onFocus = (e: FocusEvent) => {
            const el = tipOf(e.target);
            if (el?.dataset.tip && (e.target as Element).matches(':focus-visible')) show(el);
        };

        document.addEventListener('pointerover', onOver);
        document.addEventListener('pointerout', onOut);
        document.addEventListener('focusin', onFocus);
        document.addEventListener('focusout', hide);
        document.addEventListener('pointerdown', hide, true);
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        return () => {
            document.removeEventListener('pointerover', onOver);
            document.removeEventListener('pointerout', onOut);
            document.removeEventListener('focusin', onFocus);
            document.removeEventListener('focusout', hide);
            document.removeEventListener('pointerdown', hide, true);
            window.removeEventListener('scroll', hide, true);
            window.removeEventListener('resize', hide);
            tip.remove();
        };
    }, []);
    return null;
}
