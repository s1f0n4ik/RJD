import { useCallback, useRef, useState } from 'react';
import type { LogLevel } from '../api/ws-types';

/**
 * Лента «Лог событий» из сайдбара калибровки. Порт log() из utility.js.
 *
 * Главный потребитель — трассировка основного WS: без неё непонятно, что
 * калибратор ответил на команду. В no-react лента росла неограниченно
 * (append в DOM), здесь ограничена MAX_ENTRIES.
 */

const MAX_ENTRIES = 500;

export interface LogEntry {
    id: number;
    time: string;
    text: string;
    level: LogLevel;
}

export type LogFn = (msg: string, level?: LogLevel, data?: unknown) => void;

export interface EventLog {
    entries: LogEntry[];
    log: LogFn;
    clear: () => void;
}

export function useEventLog(): EventLog {
    const [entries, setEntries] = useState<LogEntry[]>([]);
    const nextId = useRef(0);

    const log = useCallback<LogFn>((msg, level = 'info', data = undefined) => {
        const prefix = `[${level.toUpperCase()}]`;
        if (data !== undefined) console.log(prefix, msg, data);
        else console.log(prefix, msg);

        const entry: LogEntry = {
            id: nextId.current++,
            time: new Date().toTimeString().slice(0, 8),
            text: data !== undefined ? `${msg}\n${JSON.stringify(data, null, 2)}` : msg,
            level,
        };

        setEntries(prev => {
            const next = [...prev, entry];
            return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
        });
    }, []);

    const clear = useCallback(() => setEntries([]), []);

    return { entries, log, clear };
}
