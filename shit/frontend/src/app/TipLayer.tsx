import { useEffect } from 'react';

// Подсказки [data-tip]: один слой на body, под элементом или над ним, в пределах окна.
// Стрелка смотрит на центр элемента; между соседними подсказками слой скользит, а не мигает
export function TipLayer() {
    useEffect(() => {
        const tip = document.createElement('div');
        tip.className = 'tip-layer';
        tip.id = 'tip-layer';
        tip.setAttribute('role', 'tooltip');
        tip.hidden = true;
        const body = document.createElement('div');
        body.className = 'tip-body';
        const text = document.createElement('span');
        const arrow = document.createElement('i');
        arrow.className = 'tip-arrow';
        body.append(text, arrow);
        tip.appendChild(body);
        document.body.appendChild(tip);

        let anchor: HTMLElement | null = null;
        let timer = 0;
        let outTimer = 0;
        let watch = 0;
        let warmUntil = 0;
        // Слой на экране: от начала показа до конца анимации ухода
        let visible = false;
        const gap = 8;
        const edge = 8;
        // Задержка показа и «тёплое» окно, в котором соседняя подсказка открывается сразу
        const DELAY_MS = 380;
        const WARM_MS = 300;
        const OUT_MS = 110;

        const describe = (el: HTMLElement | null) => {
            document.querySelectorAll('[aria-describedby="tip-layer"]').forEach((node) => node.removeAttribute('aria-describedby'));
            el?.setAttribute('aria-describedby', 'tip-layer');
        };

        const finish = () => {
            window.clearInterval(watch);
            visible = false;
            tip.hidden = true;
            tip.classList.remove('is-in', 'is-out', 'is-glide');
        };
        const hide = () => {
            window.clearTimeout(timer);
            anchor = null;
            describe(null);
            if (!visible || tip.classList.contains('is-out')) return;
            warmUntil = performance.now() + WARM_MS;
            window.clearInterval(watch);
            tip.classList.remove('is-in');
            tip.classList.add('is-out');
            outTimer = window.setTimeout(finish, OUT_MS);
        };
        const place = (el: HTMLElement) => {
            window.clearTimeout(outTimer);
            const glide = visible && !tip.classList.contains('is-out');
            const leaving = tip.classList.contains('is-out');
            text.textContent = el.dataset.tip ?? '';
            tip.classList.remove('is-out');
            tip.classList.toggle('is-glide', visible);
            tip.hidden = false;
            visible = true;

            const r = el.getBoundingClientRect();
            const width = tip.offsetWidth;
            const height = tip.offsetHeight;
            const left = Math.min(Math.max(r.left + r.width / 2 - width / 2, edge), window.innerWidth - width - edge);
            const below = r.bottom + gap;
            const above = el.dataset.tipPos === 'top' || below + height > window.innerHeight - edge;
            const top = above ? r.top - gap - height : below;
            tip.dataset.side = above ? 'above' : 'below';
            tip.style.setProperty('--ax', `${Math.round(Math.min(Math.max(r.left + r.width / 2 - left, 14), width - 14))}px`);
            tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(top, edge))}px)`;

            // Первый показ и возврат из ухода играют вход; соседняя подсказка только скользит
            if (!glide || leaving) {
                tip.classList.remove('is-in');
                void tip.offsetWidth;
                tip.classList.add('is-in');
            }
            describe(el);

            // Элемент мог исчезнуть или сменить текст, пока подсказка открыта
            window.clearInterval(watch);
            watch = window.setInterval(() => {
                if (!anchor || !anchor.isConnected || !anchor.dataset.tip) hide();
                else if (text.textContent !== anchor.dataset.tip) place(anchor);
            }, 400);
        };
        const show = (el: HTMLElement) => {
            window.clearTimeout(timer);
            anchor = el;
            if (!visible && performance.now() > warmUntil) {
                timer = window.setTimeout(() => anchor === el && place(el), DELAY_MS);
                return;
            }
            place(el);
        };
        const tipOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null);

        const onOver = (e: PointerEvent) => {
            if (e.pointerType === 'touch') return;
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
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') hide();
        };

        document.addEventListener('pointerover', onOver);
        document.addEventListener('pointerout', onOut);
        document.addEventListener('focusin', onFocus);
        document.addEventListener('focusout', hide);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('pointerdown', hide, true);
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        return () => {
            window.clearTimeout(timer);
            window.clearTimeout(outTimer);
            window.clearInterval(watch);
            document.removeEventListener('pointerover', onOver);
            document.removeEventListener('pointerout', onOut);
            document.removeEventListener('focusin', onFocus);
            document.removeEventListener('focusout', hide);
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('pointerdown', hide, true);
            window.removeEventListener('scroll', hide, true);
            window.removeEventListener('resize', hide);
            describe(null);
            tip.remove();
        };
    }, []);
    return null;
}
