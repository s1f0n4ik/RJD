import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { Anchor } from './popover';
import { elementAnchor, usePopover } from './popover';
import { isFinished, useDownloads } from './DownloadsContext';
import type { Download } from './DownloadsContext';
import { reducedMotion } from './motion';
import { fmtBytes } from '../screens/archive/model';

// Длительность перелёта жетона в плашку
const FLY_MS = 720;

// Плашка в шапке одна на приложение: перелёт ищет её здесь
let pillNode: HTMLButtonElement | null = null;

function bump(): void {
    if (!pillNode || reducedMotion()) return;
    pillNode.classList.remove('is-bump');
    void pillNode.offsetWidth;
    pillNode.classList.add('is-bump');
}

// Жетон выгрузки летит по дуге от кнопки к кольцу плашки; цель читается каждый кадр — плашка в это время раскрывается
export function flyToPill(from: DOMRect, label: string): void {
    if (reducedMotion()) return;

    const token = document.createElement('div');
    token.className = 'dl-token';
    token.innerHTML = '<svg width="13" height="13"><use href="#i-save"/></svg><span></span>';
    token.querySelector('span')!.textContent = label;
    document.body.appendChild(token);

    const width = token.offsetWidth;
    const height = token.offsetHeight;
    const x0 = from.left + from.width / 2 - width / 2;
    const y0 = from.top + from.height / 2 - height / 2;
    const started = performance.now();
    const ease = (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);

    const frame = (now: number) => {
        const k = Math.min(1, (now - started) / FLY_MS);
        const e = ease(k);
        const ring = pillNode?.querySelector('.ring')?.getBoundingClientRect();
        const x1 = (ring ? ring.left + ring.width / 2 : window.innerWidth - 120) - width / 2;
        const y1 = (ring ? ring.top + ring.height / 2 : 26) - height / 2;
        const cx = (x0 + x1) / 2 + 60;
        const cy = Math.min(y0, y1) - 120;
        const x = (1 - e) ** 2 * x0 + 2 * (1 - e) * e * cx + e ** 2 * x1;
        const y = (1 - e) ** 2 * y0 + 2 * (1 - e) * e * cy + e ** 2 * y1;
        token.style.transform = `translate(${x}px, ${y}px) scale(${1 - 0.82 * e * e})`;
        token.style.opacity = String(k > 0.82 ? (1 - k) / 0.18 : 1);
        if (k < 1) {
            requestAnimationFrame(frame);
        } else {
            token.remove();
            bump();
        }
    };
    requestAnimationFrame(frame);
}

const STATUS: Record<string, string> = {
    queued: 'в очереди',
    pending: 'ожидание',
    parsing: 'подбор',
    merging: 'склейка',
    archiving: 'упаковка',
    ready: 'готово',
    failed: 'ошибка',
    cancelled: 'отменено',
};

export function DownloadsPill() {
    const { items, overall, cancel, dismiss, save } = useDownloads();
    const [anchor, setAnchor] = useState<Anchor | null>(null);
    const button = useRef<HTMLButtonElement | null>(null);
    const pop = usePopover<HTMLDivElement>(anchor, { side: 'bottom', align: 'start' });

    useEffect(() => {
        if (!anchor) return;

        const onDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (button.current?.contains(target) || pop.current?.contains(target)) return;
            setAnchor(null);
        };
        const close = () => setAnchor(null);

        document.addEventListener('mousedown', onDown);
        window.addEventListener('resize', close);
        return () => {
            document.removeEventListener('mousedown', onDown);
            window.removeEventListener('resize', close);
        };
    }, [anchor, pop]);

    useEffect(() => {
        if (!items.length) setAnchor(null);
    }, [items.length]);

    if (!items.length) return null;

    const running = items.filter(item => !isFinished(item));
    const percent = Math.round(overall * 100);
    // Устройство ещё не начало ни одну выгрузку: кольцо крутит дугу ожидания
    const waiting = running.length > 0 && running.every(item => item.progress === 0);

    return (
        <>
            <button
                type="button"
                ref={node => { button.current = node; pillNode = node; }}
                className={`pill pill--job${running.length ? '' : ' is-done'}`}
                onClick={() => setAnchor(anchor ? null : elementAnchor(button.current!))}
                onAnimationEnd={event => event.currentTarget.classList.remove('is-bump')}
            >
                <i className={`ring${waiting ? ' is-wait' : ''}`} style={{ ['--p' as string]: `${percent}%` }} />
                {running.length
                    ? (
                        <span className="seps">
                            <span>{running.length} {plural(running.length)}</span>
                            <span>{percent} %</span>
                        </span>
                    )
                    : 'Готово к скачиванию'}
            </button>

            {anchor && createPortal(
                <div className="dl-pop" ref={pop}>
                    <div className="dl-pop-h"><span className="eyebrow">Выгрузки</span></div>
                    {items.map(item => (
                        <Row key={item.id} item={item} onCancel={cancel} onDismiss={dismiss} onSave={save} />
                    ))}
                </div>,
                document.body,
            )}
        </>
    );
}

function plural(count: number): string {
    const tail = count % 10;
    if (count % 100 >= 11 && count % 100 <= 14) return 'выгрузок';
    if (tail === 1) return 'выгрузка';
    if (tail >= 2 && tail <= 4) return 'выгрузки';
    return 'выгрузок';
}

interface RowProps {
    item: Download;
    onCancel: (id: string) => void;
    onDismiss: (id: string) => void;
    onSave: (id: string) => void;
}

function Row({ item, onCancel, onDismiss, onSave }: RowProps) {
    const done = item.status === 'ready';
    const failed = item.status === 'failed';
    const percent = Math.round(item.progress * 100);

    // Слева в подвале — что делает устройство прямо сейчас, а не выдуманные файлы
    const foot = failed
        ? item.error || 'ошибка'
        : done
            ? fmtBytes(item.bytes)
            : item.status === 'queued'
                ? 'устройство занято'
                : item.message
                    ? (
                        <span className="seps">
                            <span>{item.message}</span>
                            <span>{percent} %</span>
                        </span>
                    )
                    : `${percent} %`;

    return (
        <div className="dl-job">
            <div className="dl-job-t">
                <b>{item.title}</b>
                <span className={`st${done ? ' ok' : ''}${failed ? ' err' : ''}`}>
                    {STATUS[item.status] ?? item.status}
                </span>
            </div>
            <div className="dl-job-sub">{item.subtitle}</div>

            <div className={`dl-bar${done ? ' is-done' : ''}${item.status === 'queued' ? ' is-wait' : ''}`}>
                <i style={{ width: `${percent}%` }} />
            </div>

            <div className="dl-job-f">
                <span className="dl-job-sub">{foot}</span>
                {done && (
                    <button type="button" className="btn btn--sm btn--acc dl-grow" onClick={() => onSave(item.id)}>
                        Сохранить файл
                    </button>
                )}
                <button
                    type="button"
                    className={`btn btn--sm${done || failed ? ' dl-grow' : ' dl-grow'}`}
                    onClick={() => (done || failed ? onDismiss(item.id) : onCancel(item.id))}
                >
                    {done || failed ? 'Убрать' : 'Отменить'}
                </button>
            </div>
        </div>
    );
}
