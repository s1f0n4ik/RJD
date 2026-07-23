import { useCallback, useEffect, useRef, useState } from 'react';
import type { WsMessage, WsStatus } from '../api/ws-types';
import type { LogFn } from './useEventLog';

/**
 * Основной WebSocket калибратора. Порт core/websocket.js.
 *
 * Один сокет на всю страницу: его читают и калибровка, и проекция —
 * диспетчер в no-react раздавал 18 типов сообщений между обоими экранами.
 * Поэтому хук живёт в BirdviewApp, а экраны получают send/subscribe пропсами.
 *
 * Переподключения нет намеренно: на калибратор пускается ровно один клиент
 * ([server.py] handle_client_for_calibrator), и молчаливая борьба за слот с
 * другой вкладкой хуже явной кнопки «Подключить».
 */

export type WsHandler = (msg: WsMessage) => void;

export interface BirdviewWs {
    status: WsStatus;
    url: string;
    setUrl: (url: string) => void;
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
    onClose: () => void;
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
    const [url, setUrl] = useState(initialUrl);

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
    const urlRef = useRef(url);
    urlRef.current = url;

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

        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            logRef.current('WS уже подключён', 'warn');
            return;
        }

        setStatus('connecting');
        logRef.current(`Подключение к ${target}...`);

        const ws = new WebSocket(target);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;

        ws.onopen = () => {
            setStatus('connected');
            logRef.current('WebSocket подключён', 'ok');
        };

        ws.onerror = () => {
            setStatus('disconnected');
            logRef.current('WebSocket ошибка', 'err');
        };

        ws.onclose = () => {
            // Сообщение type:'close' тут не шлём: сокет уже закрыт, отправка
            // всё равно не проходит и только пишет ложную ошибку в лог.
            wsRef.current = null;
            setStatus('disconnected');
            logRef.current('WebSocket закрыт', 'warn');
            onCloseRef.current();
        };

        ws.onmessage = (event: MessageEvent) => {
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

            logRef.current(`← ${msg.type} | ret=${msg.ret}`, msg.ret === false ? 'err' : 'info');

            // Причина отказа приходит в meta.description — без неё в логе
            // видно только ret=false и непонятно, что именно не сложилось
            if (!msg.ret && msg.meta?.description) {
                logRef.current(`Сервер: ошибка — ${msg.meta.description}`, 'err');
            }

            dispatch(msg);
        };
    }, [dispatch]);

    const disconnect = useCallback(() => {
        const ws = wsRef.current;
        if (ws) {
            send({
                type: 'close',
                client_id: clientId,
                camera: getStreamIdRef.current(),
                meta: { description: `close websocket from ${clientId}` },
                ret: 'none',
            });
            ws.close();
            wsRef.current = null;
        }
        setStatus('disconnected');
        logRef.current('WS отключён', 'warn');
    }, [send, clientId]);

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
        };
    }, [sayGoodbye]);

    return { status, url, setUrl, connect, disconnect, send, sendMessage, subscribe };
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
