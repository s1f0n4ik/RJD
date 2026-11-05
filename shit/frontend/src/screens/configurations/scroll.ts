// Прокрутка внутри области экрана (.lb-view), а не окна
export function scrollInside(element: HTMLElement, where: 'start' | 'center') {
    const scroller = element.closest<HTMLElement>('.lb-view');
    if (!scroller) return;
    scroller.dispatchEvent(new Event('lb-jump'));
    const box = element.getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    const top =
        scroller.scrollTop + (box.top - frame.top) - (where === 'center' ? (scroller.clientHeight - box.height) / 2 : 16);
    scroller.scrollTo({
        top,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
}
