import type { MouseEvent } from 'react';

// Отступ плашки слева от начала текста
const PAD = 6;

// Правая граница ближайшего предка, который обрезает содержимое
function clipRight(el: HTMLElement): number {
    for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') return p.getBoundingClientRect().right;
    }
    return window.innerWidth;
}

// Строка с многоточием: обрезанный текст при наведении раскрывается на месте поверх соседей
export function FitText({ text }: { text: string }) {
    const onEnter = (e: MouseEvent<HTMLSpanElement>) => {
        const el = e.currentTarget;
        const short = el.firstElementChild as HTMLElement;
        const full = el.lastElementChild as HTMLElement;
        const cut = short.scrollWidth > short.clientWidth;
        el.toggleAttribute('data-cut', cut);
        if (!cut) return;
        // У края обрезающего предка плашка сдвигается влево
        const room = clipRight(el) - 4 - (el.getBoundingClientRect().left - PAD);
        el.style.setProperty('--fit-shift', `${Math.min(0, room - full.scrollWidth)}px`);
    };
    return (
        <span className="fit" onMouseEnter={onEnter}>
            <span className="fit-t">{text}</span>
            <span className="fit-full" aria-hidden="true">{text}</span>
        </span>
    );
}
