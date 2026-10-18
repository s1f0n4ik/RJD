import { useEffect, useRef } from 'react';

// Пользователь попросил систему убрать движение
export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Сводный счётчик вспыхивает один раз при смене значения; первое значение не мигает
export function useFlash<T extends HTMLElement>(value: unknown, tone: '' | 'warn' | 'bad' = '') {
    const ref = useRef<T>(null);
    const prev = useRef(value);
    useEffect(() => {
        if (Object.is(prev.current, value)) return;
        prev.current = value;
        const el = ref.current;
        if (!el) return;
        el.classList.remove('flash');
        void el.offsetWidth;
        el.dataset.flash = tone;
        el.classList.add('flash');
    }, [value, tone]);
    return ref;
}
