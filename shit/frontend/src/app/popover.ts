import { useLayoutEffect, useRef } from 'react';

// Позиционирование попапов: предпочтительная сторона, переворот, упор в кромки окна
export interface Anchor {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface PopoverOptions {
    // Предпочтительная сторона от якоря
    side?: 'top' | 'bottom' | 'left' | 'right';
    // Выравнивание по второй оси
    align?: 'center' | 'start';
    // Зазор между якорем и попапом
    gap?: number;
    // Отступ от кромки окна
    margin?: number;
}

const GAP = 10;
const MARGIN = 8;

// Точка как якорь нулевого размера
export const pointAnchor = (x: number, y: number): Anchor =>
    ({ left: x, top: y, right: x, bottom: y });

// Рамка узла как якорь
export const elementAnchor = (element: Element): Anchor => {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
};

const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(value, Math.max(min, max)));

export function placePopover(
    anchor: Anchor,
    size: { width: number; height: number },
    options: PopoverOptions = {},
): { left: number; top: number } {
    const { side = 'top', align = 'center', gap = GAP, margin = MARGIN } = options;
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;

    let left: number;
    let top: number;

    if (side === 'top' || side === 'bottom') {
        const above = anchor.top - gap - size.height;
        const below = anchor.bottom + gap;
        const fitsAbove = above >= margin;
        const fitsBelow = below + size.height <= viewHeight - margin;

        top = side === 'top'
            ? (fitsAbove || !fitsBelow ? above : below)
            : (fitsBelow || !fitsAbove ? below : above);

        left = align === 'center'
            ? (anchor.left + anchor.right) / 2 - size.width / 2
            : anchor.left;
    } else {
        const before = anchor.left - gap - size.width;
        const after = anchor.right + gap;
        const fitsBefore = before >= margin;
        const fitsAfter = after + size.width <= viewWidth - margin;

        left = side === 'left'
            ? (fitsBefore || !fitsAfter ? before : after)
            : (fitsAfter || !fitsBefore ? after : before);

        top = align === 'center'
            ? (anchor.top + anchor.bottom) / 2 - size.height / 2
            : anchor.top;
    }

    return {
        left: clamp(left, margin, viewWidth - size.width - margin),
        top: clamp(top, margin, viewHeight - size.height - margin),
    };
}

// Координаты пишутся прямо в узел: размер попапа известен только после отрисовки
export function usePopover<T extends HTMLElement>(
    anchor: Anchor | null,
    options: PopoverOptions = {},
) {
    const ref = useRef<T | null>(null);
    const { side, align, gap, margin } = options;

    useLayoutEffect(() => {
        const element = ref.current;
        if (!element || !anchor) return;

        const { left, top } = placePopover(
            anchor,
            { width: element.offsetWidth, height: element.offsetHeight },
            { side, align, gap, margin },
        );

        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
        element.style.visibility = 'visible';
    });

    return ref;
}
