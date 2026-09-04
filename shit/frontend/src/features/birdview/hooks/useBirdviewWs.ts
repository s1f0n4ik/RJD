import { useCallback, useEffect, useRef, useState } from 'react';
import type { WsMessage, WsStatus } from '../api/ws-types';
import type { LogFn } from './useEventLog';

/**
 * Основной WebSocket калибратора. Порт core/websocket.js.
 *
 * Один сокет на всю страницу: его читают и калибровка, и проекция —
 * диспетчер в no-react раздавал 18 типов сообщений между обоими экранами.
 * Поэтому хук живёт в SurroundScreen, а экраны получают send/subscribe пропсами.
 *
 * Переподключения нет намеренно: на калибратор пускается ровно один клиент
 * ([server.py] handle_client_for_calibrator), и молчаливая борьба за слот с
 * другой вкладкой хуже явной кнопки «Подключить».
 */

// Код брокера: калибратор не пришёл на свою роль
const ERR_NO_CALIBRATOR = 1005;

export type WsHandler = (msg: WsMessage) => void;

// Почему сессия калибратора не состоялась или оборвалась
export type SessionReason = 'no-calibrator' | 'busy' | 'revoked' | 'declined' | 'timeout' | 'manual' | 'closed';

// Чужая сессия, которую брокер предлагает разорвать
export interface SessionBusy {
    holder: string | null;
    heldForSec: number | null;
    timeoutSec: number | null;
}

export interface BirdviewWs {
    status: WsStatus;
    /** Причина последнего отказа или обрыва. null, пока всё в порядке. */
    reason: SessionReason | null;
    /** Брокер спросил, рвать ли чужую сессию. null — вопроса нет. */
    busy: SessionBusy | null;
    /** Ответ «да» на вопрос о перехвате. */
    confirmTakeover: () => void;
    /** Ответ «нет»: сокет закрывается. */
    declineTakeover: () => void;
    connect: () => void;
    disconnect: () => void;
    /** Отправка сырого объекта. false, если сокет не открыт. */
    send: (payload: Record<string, unknown>) => boolean;
    /** Отправка в формате калибратора: type + client_id + camera + meta. */
    sendMessage: (type: string, meta?: Record<string, unknown>, ret?: string) => boolean;
    /** Подписка на тип сообщения. Возвращает функцию отписки. */
    subscribe: (type: string, handler: WsHandler) => () => void;
}

interface Options {
    initialUrl: string;
    clientId: string;
    /** Идентификатор стрима уходит в поле camera — его ждёт калибратор. */
    getStreamId: () => string | null;
    log: LogFn;
    onClose: (reason: SessionReason | null, takenBy: string | null) => void;
    autoConnect: boolean;
}

export function useBirdviewWs({
    initialUrl,
    clientId,
    getStreamId,
    log,
    onClose,
    autoConnect,
}: Options): BirdviewWs {
    const [status, setStatus] = useState<WsStatus>('disconnected');
    const [reason, setReason] = useState<SessionReason | null>(null);
    const [busy, setBusy] = useState<SessionBusy | null>(null);

    // Причина и адрес нужны в onclose, куда состояние не доезжает
    const reasonRef = useRef<SessionReason | null>(null);
    const takenByRef = useRef<string | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    const handlersRef = useRef<Map<string, Set<WsHandler>>>(new Map());

    // Колбэки держим в ref: они меняются на каждый рендер родителя, а
    // пересоздавать из-за этого соединение нельзя.
    const logRef = useRef(log);
    logRef.current = log;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const getStreamIdRef = useRef(getStreamId);
    getStreamIdRef.current = getStreamId;
    const urlRef = useRef(initialUrl);
    urlRef.current = initialUrl;

    const send = useCallback((payload: Record<string, unknown>): boolean => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            logRef.current('WS не открыт, отправка невозможна', 'err');
            return false;
        }
        ws.send(JSON.stringify(payload));
        return true;
    }, []);

    const sendMessage = useCallback(
        (type: string, meta: Record<string, unknown> = {}, ret = 'none'): boolean =>
            send({
                type,
                client_id: clientId,
                camera: getStreamIdRef.current(),
                meta,
                ret,
            }),
        [send, clientId],
    );

    // Разбор служебных сообщений брокера; true — сообщение дальше не идёт
    const handleSession = useCallback((msg: WsMessage): boolean => {
        const meta = msg.meta ?? {};

        if (msg.type === 'session_ready') {
            setStatus('connected');
            setBusy(null);
            setReason(null);
            reasonRef.current = null;
            takenByRef.current = null;
            logRef.current(
                meta.took_over
                    ? 'Сессия калибратора перехвачена'
                    : meta.resumed
                      ? 'Сессия калибратора восстановлена'
                      : 'Сессия калибратора получена',
                'ok',
            );
            return true;
        }

        if (msg.type === 'session_busy') {
            reasonRef.current = 'busy';
            setBusy({
                holder: meta.holder ?? null,
                heldForSec: typeof meta.held_for_sec === 'number' ? meta.held_for_sec : null,
                timeoutSec: typeof meta.timeout_sec === 'number' ? meta.timeout_sec : null,
            });
            logRef.current(`Калибратор занят клиентом ${meta.holder ?? 'неизвестно'}`, 'warn');
            return true;
        }

        if (msg.type === 'session_error') {
            const next: SessionReason = meta.code === ERR_NO_CALIBRATOR ? 'no-calibrator' : 'closed';
            reasonRef.current = next;
            setReason(next);
            logRef.current(
                next === 'no-calibrator'
                    ? 'Калибратор не подключён к брокеру'
                    : `Брокер отказал: ${meta.description ?? ''}`,
                'err',
            );
            return true;
        }

        if (msg.type === 'session_revoked') {
            reasonRef.current = 'revoked';
            setReason('revoked');
            takenByRef.current = meta.taken_by ?? null;
            logRef.current(`Сессию перехватил клиент ${meta.taken_by ?? 'неизвестно'}`, 'warn');
            return true;
        }

        return false;
    }, []);

    const subscribe = useCallback((type: string, handler: WsHandler): (() => void) => {
        let set = handlersRef.current.get(type);
        if (!set) {
            set = new Set();
            handlersRef.current.set(type, set);
        }
        set.add(handler);
        return () => {
            set?.delete(handler);
        };
    }, []);

    const dispatch = useCallback((msg: WsMessage) => {
        const set = handlersRef.current.get(msg.type);
        if (!set || set.size === 0) {
            logRef.current(`Неизвестный тип: ${msg.type}`, 'warn');
            return;
        }
        set.forEach(h => h(msg));
    }, []);

    const connect = useCallback(() => {
        const target = urlRef.current.trim();
        if (!target) return;

        // CONNECTING тоже считается занятым: иначе на странице заводится второй
        // сокет, и оба клиента дерутся за единственный слот калибратора
        const current = wsRef.current;
        if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) {
            logRef.current('WS уже подключён', 'warn');
            return;
        }

        setStatus('connecting');
        setReason(null);
        setBusy(null);
        reasonRef.current = null;
        takenByRef.current = null;
        logRef.current(`Подключение к ${target}...`);

        const ws = new WebSocket(target);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;

        // События покинутого сокета не должны трогать состояние живого
        const isCurrent = () => wsRef.current === ws;

        ws.onopen = () => {
            if (!isCurrent()) return;
            // Сокет открыт, но сессия ещё не наша: её подтверждает session_ready
            logRef.current('WebSocket открыт, ждём подтверждения сессии');
        };

        ws.onerror = () => {
            if (!isCurrent()) return;
            setStatus('disconnected');
            logRef.current('WebSocket ошибка', 'err');
        };

        ws.onclose = () => {
            if (!isCurrent()) return;
            // Сообщение type:'close' тут не шлём: сокет уже закрыт, отправка
            // всё равно не проходит и только пишет ложную ошибку в лог.
            wsRef.current = null;
            setStatus('disconnected');
            setBusy(null);

            // Брокер закрыл сокет, не дождавшись ответа на вопрос о перехвате
            const why: SessionReason = reasonRef.current === 'busy' ? 'timeout' : reasonRef.current ?? 'closed';
            reasonRef.current = why;
            setReason(why);

            logRef.current('WebSocket закрыт', 'warn');
            onCloseRef.current(why, takenByRef.current);
        };

        ws.onmessage = (event: MessageEvent) => {
            if (!isCurrent()) return;
            const data = event.data;

            if (data instanceof ArrayBuffer) {
                dispatch(parseBinary(data));
                return;
            }

            let msg: WsMessage;
            try {
                msg = JSON.parse(data);
            } catch {
                logRef.current('Не удалось разобрать сообщение: ' + data, 'err');
                return;
            }

            if (handleSession(msg)) return;

            logRef.current(`← ${msg.type} | ret=${msg.ret}`, msg.ret === false ? 'err' : 'info');

            // Причина отказа приходит в meta.description — без неё в логе
            // видно только ret=false и непонятно, что именно не сложилось
            if (!msg.ret && msg.meta?.description) {
                logRef.current(`Сервер: ошибка — ${msg.meta.description}`, 'err');
            }

            dispatch(msg);
        };
    }, [dispatch, handleSession]);

    const disconnect = useCallback(() => {
        const ws = wsRef.current;
        reasonRef.current = 'manual';
        if (ws) {
            send({
                type: 'close',
                client_id: clientId,
                camera: getStreamIdRef.current(),
                meta: { description: `close websocket from ${clientId}`, keep_images: true },
                ret: 'none',
            });
            ws.close();
            wsRef.current = null;
        }
        setStatus('disconnected');
        logRef.current('WS отключён', 'warn');
    }, [send, clientId]);

    const confirmTakeover = useCallback(() => {
        setBusy(null);
        reasonRef.current = null;
        send({ type: 'session_takeover', client_id: clientId, camera: null, meta: {}, ret: 'none' });
    }, [send, clientId]);

    const declineTakeover = useCallback(() => {
        setBusy(null);
        reasonRef.current = 'declined';
        setReason('declined');
        wsRef.current?.close();
    }, []);

    // Автоподключение при открытии страницы
    const autoConnectedRef = useRef(false);
    useEffect(() => {
        if (!autoConnect || autoConnectedRef.current) return;
        autoConnectedRef.current = true;
        connect();
    }, [autoConnect, connect]);

    /**
     * Прощание с калибратором.
     *
     * Он не узнаёт об отключении сам: брокер при уходе клиента просто забывает
     * его, и пайплайн продолжает считать undistort в фоне. Поэтому перед
     * закрытием сокета шлём close.
     *
     * keep_images просит не трогать набор снимков: оператор ушёл со страницы,
     * а не закончил калибровку, и потерять два десятка кадров шахматки из-за
     * перехода по ссылке было бы обидно. Кнопка «Закрыть стрим» его не ставит
     * и чистит всё, как раньше.
     */
    const sayGoodbye = useCallback(() => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        try {
            ws.send(
                JSON.stringify({
                    type: 'close',
                    client_id: clientId,
                    camera: getStreamIdRef.current(),
                    meta: { description: `page left by ${clientId}`, keep_images: true },
                    ret: 'none',
                }),
            );
        } catch {
            // Сокет уже рвётся — брокер подстрахует своим close
        }
    }, [clientId]);

    // Закрытие вкладки. pagehide, а не beforeunload: он надёжнее и
    // срабатывает там, где beforeunload молчит
    useEffect(() => {
        const onHide = () => sayGoodbye();
        window.addEventListener('pagehide', onHide);
        return () => window.removeEventListener('pagehide', onHide);
    }, [sayGoodbye]);

    // Уход с маршрута /app/birdview размонтирует всё дерево страницы
    useEffect(() => {
        return () => {
            sayGoodbye();
            wsRef.current?.close();
            wsRef.current = null;
            // Флаг живёт в ref и переживает размонтирование: без сброса
            // повторный монтаж (StrictMode, возврат в раздел) не подключится
            autoConnectedRef.current = false;
        };
    }, [sayGoodbye]);

    return {
        status,
        reason,
        busy,
        confirmTakeover,
        declineTakeover,
        connect,
        disconnect,
        send,
        sendMessage,
        subscribe,
    };
}

/**
 * Бинарный кадр: 4 байта длины JSON (big-endian), затем JSON, затем JPEG.
 */
function parseBinary(buffer: ArrayBuffer): WsMessage {
    const view = new DataView(buffer);
    const jsonSize =
        (view.getUint8(0) << 24) | (view.getUint8(1) << 16) | (view.getUint8(2) << 8) | view.getUint8(3);

    const jsonBytes = new Uint8Array(buffer, 4, jsonSize);
    const imageBytes = new Uint8Array(buffer, 4 + jsonSize);

    let msg: WsMessage = { type: '' };
    try {
        msg = JSON.parse(new TextDecoder().decode(jsonBytes));
    } catch {
        // Заголовок не разобрался — отдаём хотя бы байты картинки
    }
    msg.imageBytes = imageBytes;
    return msg;
}
