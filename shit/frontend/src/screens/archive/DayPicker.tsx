import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../../app/Icons';
import { elementAnchor, usePopover } from '../../app/popover';
import type { Anchor } from '../../app/popover';
import { Calendar } from './Calendar';
import { dateKey, dayStartMs, weekdayShort } from './model';

// Выбор дня

interface Props {
    date: string;
    todayKey: string | null;
    onChange: (date: string) => void;
}

export function DayPicker({ date, todayKey, onChange }: Props) {
    const [open, setOpen] = useState(false);
    const [month, setMonth] = useState(() => date.slice(0, 7));
    const box = useRef<HTMLDivElement | null>(null);
    const button = useRef<HTMLButtonElement | null>(null);
    const [anchor, setAnchor] = useState<Anchor | null>(null);
    const pop = usePopover<HTMLDivElement>(anchor, { side: 'top', align: 'start' });

    useEffect(() => {
        if (!open) return;

        // Попап лежит в body, поэтому снаружи считается всё, что не он и не кнопка
        const onDocumentDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (box.current?.contains(target) || pop.current?.contains(target)) return;
            setOpen(false);
        };
        const onEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        const close = () => setOpen(false);

        document.addEventListener('mousedown', onDocumentDown);
        document.addEventListener('keydown', onEscape);
        window.addEventListener('resize', close);
        return () => {
            document.removeEventListener('mousedown', onDocumentDown);
            document.removeEventListener('keydown', onEscape);
            window.removeEventListener('resize', close);
        };
    }, [open, pop]);

    return (
        <div className="arch-daypick" ref={box}>
            <div className="arch-step">
                <button type="button" className="arch-step-arrow" onClick={() => onChange(shift(date, -1))} aria-label="Предыдущий день">‹</button>
                <button
                    type="button"
                    className="arch-step-day"
                    ref={button}
                    onClick={() => {
                        if (button.current) setAnchor(elementAnchor(button.current));
                        setMonth(date.slice(0, 7));
                        setOpen(value => !value);
                    }}
                >
                    <b>{formatDay(date)}</b>
                    <em>{weekdayShort(date)}</em>
                    <Icon name="cal" />
                </button>
                <button type="button" className="arch-step-arrow" onClick={() => onChange(shift(date, 1))} aria-label="Следующий день">›</button>
            </div>

            {open && anchor && createPortal(
                <div className="arch-pop" ref={pop}>
                    <Calendar
                        month={month}
                        onMonth={setMonth}
                        todayKey={todayKey}
                        from={date}
                        to={date}
                        onPick={key => { onChange(key); setOpen(false); }}
                    />
                </div>,
                document.body,
            )}
        </div>
    );
}

function formatDay(key: string): string {
    const [year, month, day] = key.split('-');
    return `${day}.${month}.${year}`;
}

function shift(key: string, days: number): string {
    return dateKey(dayStartMs(key) + days * 86_400_000);
}
