import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { Anchor } from './popover';
import { elementAnchor, usePopover } from './popover';
import { isFinished, useDownloads } from './DownloadsContext';
import type { Download } from './DownloadsContext';

const STATUS: Record<string, string> = {
    queued: 'устройство занято',
    pending: 'ожидание',
    parsing: 'подбор файлов',
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

    return (
        <>
            <button
                type="button"
                ref={button}
                className={`pill pill--job${running.length ? '' : ' is-done'}`}
                onClick={() => setAnchor(anchor ? null : elementAnchor(button.current!))}
            >
                <i className="ring" style={{ ['--p' as string]: `${percent}%` }} />
                {running.length
                    ? `${running.length} ${plural(running.length)} · ${percent} %`
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
    const percent = Math.round((item.saving ? item.savingProgress : item.progress) * 100);

    return (
        <div className="dl-job">
            <div className="dl-job-t">
                <b>{item.title}</b>
                <span className={`st${done ? ' ok' : ''}${failed ? ' err' : ''}`}>
                    {item.saving ? 'скачивание' : STATUS[item.status] ?? item.status}
                </span>
            </div>
            <div className="dl-job-sub">{item.error || item.subtitle}</div>

            <div className={`dl-bar${done && !item.saving ? ' is-done' : ''}${item.status === 'queued' ? ' is-wait' : ''}`}>
                <i style={{ width: `${percent}%` }} />
            </div>

            <div className="dl-job-f">
                <span className="dl-job-sub">
                    {item.filesTotal ? `${item.filesDone} из ${item.filesTotal} файлов` : `${percent} %`}
                </span>
                {done && !item.saving && (
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
