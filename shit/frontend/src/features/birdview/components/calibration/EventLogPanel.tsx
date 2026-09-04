import { useEffect, useRef } from 'react';
import type { EventLog } from '../../hooks/useEventLog';
import type { LogLevel } from '../../api/ws-types';

// Лента событий во вкладке «Журнал» шторки

const LEVEL_CLASS: Record<LogLevel, string> = { info: '', ok: 'ok', warn: 'wr', err: 'er' };

export function EventLogPanel({ log }: { log: EventLog }) {
    const listRef = useRef<HTMLDivElement>(null);

    // Прокрутка к последней записи
    useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [log.entries.length]);

    return (
        <div ref={listRef} className="log">
            {log.entries.map(e => (
                <div key={e.id} className="row">
                    <span className="t">{e.time}</span>
                    <span className={LEVEL_CLASS[e.level]}>{e.text}</span>
                </div>
            ))}
        </div>
    );
}
