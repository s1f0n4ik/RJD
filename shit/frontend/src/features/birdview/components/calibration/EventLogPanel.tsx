import { useEffect, useRef } from 'react';
import type { EventLog } from '../../hooks/useEventLog';

/** Лента событий. Порт блока «Лог событий» и log() из utility.js. */

export function EventLogPanel({ log }: { log: EventLog }) {
    const listRef = useRef<HTMLDivElement>(null);

    // Прокрутка к последней записи, как делал append в no-react
    useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [log.entries.length]);

    return (
        <section className="panel-block panel-block--log">
            <div className="block-header">
                <span className="block-icon">≡</span>
                <span className="block-title">Лог событий</span>
                <button className="btn-icon" onClick={log.clear} title="Очистить">✕</button>
            </div>
            <div ref={listRef} className="event-log">
                {log.entries.map(e => (
                    <div key={e.id} className={`log-entry ${e.level}`}>
                        <span className="log-time">{e.time}</span>
                        <span className="log-msg">{e.text}</span>
                    </div>
                ))}
            </div>
        </section>
    );
}
