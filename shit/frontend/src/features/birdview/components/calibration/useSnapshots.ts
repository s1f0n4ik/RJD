import { useCallback, useEffect, useRef, useState } from 'react';
import type { BirdviewWs } from '../../hooks/useBirdviewWs';
import type { WsMessage } from '../../api/ws-types';
import type { LogFn } from '../../hooks/useEventLog';

/**
 * Снимки калибровки. Порт снимочной части calibration.js.
 *
 * Просмотр кадра — непрозрачная картинка поверх плеера, а не подмена video:
 * размонтировать плеер ради просмотра снимка означало бы полное
 * переподключение WebRTC при возврате к стриму.
 */

export interface Snapshot {
    id: number;
    /** Обнаружены ли углы шахматки — приходит в ходе калибровки. */
    used: boolean;
}

export interface SnapshotFrame {
    id: number;
    url: string;
}

export interface Snapshots {
    items: Snapshot[];
    frame: SnapshotFrame | null;
    take: () => void;
    requestFrame: (id: number) => void;
    requestRemove: (id: number) => void;
    requestClear: () => void;
    resumeStream: () => void;
    clear: () => void;
    setUsed: (id: number, used: boolean) => void;
    handleAdd: (msg: WsMessage) => void;
    handleRemove: (msg: WsMessage) => void;
    handleFrame: (msg: WsMessage) => void;
}

interface Options {
    ws: BirdviewWs;
    clientId: string;
    log: LogFn;
}

export function useSnapshots({ ws, clientId, log }: Options): Snapshots {
    const [items, setItems] = useState<Snapshot[]>([]);
    const [frame, setFrame] = useState<SnapshotFrame | null>(null);

    // Blob-url надо освобождать вручную, иначе кадры копятся в памяти
    const frameUrlRef = useRef<string | null>(null);

    const revoke = useCallback(() => {
        if (frameUrlRef.current) {
            URL.revokeObjectURL(frameUrlRef.current);
            frameUrlRef.current = null;
        }
    }, []);

    useEffect(() => revoke, [revoke]);

    const take = useCallback(() => {
        ws.send({ type: 'add_image', client_id: clientId, meta: {} });
        log('Запрос снимка', 'ok');
    }, [ws, clientId, log]);

    const requestFrame = useCallback(
        (id: number) => {
            ws.send({ type: 'get_image', client_id: clientId, meta: { id } });
        },
        [ws, clientId],
    );

    const requestRemove = useCallback(
        (id: number) => {
            ws.send({ type: 'delete_image', client_id: clientId, meta: { id, all: false } });
        },
        [ws, clientId],
    );

    const requestClear = useCallback(() => {
        ws.send({ type: 'delete_image', client_id: clientId, meta: { id: -1, all: true } });
    }, [ws, clientId]);

    const resumeStream = useCallback(() => {
        revoke();
        setFrame(null);
    }, [revoke]);

    const clear = useCallback(() => {
        setItems([]);
        revoke();
        setFrame(null);
    }, [revoke]);

    const setUsed = useCallback((id: number, used: boolean) => {
        setItems(prev => prev.map(s => (s.id === id ? { ...s, used } : s)));
    }, []);

    const handleAdd = useCallback(
        (msg: WsMessage) => {
            if (!msg.ret) {
                log(`Снимок: ${msg.meta?.description ?? ''}`, 'err');
                return;
            }
            const count = msg.meta?.count ?? 0;
            const addedId = msg.meta?.added_id ?? -1;
            setItems(prev => [...prev, { id: addedId, used: false }]);
            log(`Снимок id=${addedId}. Всего: ${count}`, 'ok');
        },
        [log],
    );

    const handleRemove = useCallback(
        (msg: WsMessage) => {
            if (!msg.ret) {
                log(`Удаление: ${msg.meta?.description ?? ''}`, 'err');
                return;
            }
            const { id = -1, all = false } = msg.meta ?? {};
            if (all) {
                clear();
                log('Все снимки очищены', 'ok');
                return;
            }
            if (id === -1) {
                log('Некорректные данные', 'err');
                return;
            }
            // Сервер перенумеровывает оставшиеся подряд — повторяем это же
            setItems(prev => prev.filter(s => s.id !== id).map((s, i) => ({ ...s, id: i })));
        },
        [log, clear],
    );

    const handleFrame = useCallback(
        (msg: WsMessage) => {
            if (!msg.ret) {
                log(`Кадр: ${msg.meta?.description}`, 'err');
                return;
            }
            if (!msg.imageBytes) return;

            revoke();
            // slice() копирует байты в собственный буфер — вид над буфером
            // WS-сообщения переживать это сообщение не обязан
            const bytes = msg.imageBytes.slice();
            const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
            frameUrlRef.current = url;
            setFrame({ id: msg.meta?.id ?? -1, url });
        },
        [log, revoke],
    );

    return {
        items,
        frame,
        take,
        requestFrame,
        requestRemove,
        requestClear,
        resumeStream,
        clear,
        setUsed,
        handleAdd,
        handleRemove,
        handleFrame,
    };
}
