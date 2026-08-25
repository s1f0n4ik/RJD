/**
 * WebSocketManager
 *
 * Отвечает ТОЛЬКО за WebSocket-соединение и сигналинг.
 * Живёт независимо от WebRTC. Реконнектится бесконечно до вызова destroy().
 *
 * Жизненный цикл:
 *   new WebSocketManager(url, handlers) → start() → ... → destroy()
 *
 * destroy() — единственная точка полного останова. После него реконнектов нет.
 */

export type WSStatus = 'connecting' | 'connected' | 'disconnected';

export interface WSHandlers {
    onOpen?: () => void;
    onMessage?: (msg: SignalingMessage) => void;
    onClose?: (reason: string) => void;
    onStatusChange?: (status: WSStatus) => void;
}

// ─── Типы сигналинговых сообщений ──────────────────────────────────────────

export type SignalingMessage =
    | ConnectionResponseMsg
    | OfferMsg
    | IceMsg
    | CloseMsg;

export interface ConnectionResponseMsg {
    type: 'connection';
    ret: 'success' | 'error' | string;
    client_id: string;
    camera: string;
    description?: string;
}

export interface OfferMsg {
    type: 'offer';
    sdp: string;
    client_id?: string;
    camera?: string;
}

export interface IceMsg {
    type: 'ice';
    candidate: string;
    sdpMLineIndex: number | null;
    sdpMid?: string;
    usernameFragment?: string;
}

export interface CloseMsg {
    type: 'close';
    ret?: string;
    client_id?: string;
    camera?: string;
    description?: string;
}

// ─── Исходящие сообщения ───────────────────────────────────────────────────

export interface ConnectionRequestPayload {
    client_id: string;
    camera: string;
    /** Ключ потока камеры; пусто — сервер берёт первый смотрибельный */
    stream?: string;
}

export interface IceCandidatePayload {
    client_id: string;
    camera: string;
    candidate: string;
    sdpMLineIndex: number | null;
    sdpMid: string | null;
    usernameFragment: string | null;
}

export interface AnswerPayload {
    client_id: string;
    camera: string;
    sdp: string;
}

export interface ClosePayload {
    client_id: string;
    camera: string;
    description?: string;
}

// ──────────────────────────────────────────────────────────────────────────

const BASE_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 10_000;

export class WebSocketManager {
    private readonly url: string;
    private readonly handlers: WSHandlers;

    private ws: WebSocket | null = null;
    private destroyed = false;

    private retryAttempt = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(url: string, handlers: WSHandlers) {
        this.url = url;
        this.handlers = handlers;
    }

    // ─── Публичный API ──────────────────────────────────────────────────────

    start(): void {
        if (this.destroyed) {
            console.warn('[WSManager] Cannot start — already destroyed');
            return;
        }
        this.connect();
    }

    /**
     * Полный останов. После вызова реконнектов нет, WS закрывается.
     */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        console.log('[WSManager] destroy()');
        this.clearRetryTimer();
        this.closeSocket(1000, 'destroyed');
    }

    /**
     * Отправить connection-request (запрос на подключение к камере).
     */
    sendConnectionRequest(payload: ConnectionRequestPayload): boolean {
        return this.send({
            type: 'connection',
            client_id: payload.client_id,
            camera: payload.camera,
            description: 'connect_request from client',
            ret: 'none',
        });
    }

    /**
     * Отправить ICE-кандидата.
     */
    sendIceCandidate(payload: IceCandidatePayload): boolean {
        return this.send({
            type: 'ice',
            client_id: payload.client_id,
            camera: payload.camera,
            candidate: payload.candidate,
            sdpMLineIndex: payload.sdpMLineIndex,
            sdpMid: payload.sdpMid,
            usernameFragment: payload.usernameFragment,
        });
    }

    /**
     * Отправить SDP-answer.
     */
    sendAnswer(payload: AnswerPayload): boolean {
        return this.send({
            type: 'answer',
            client_id: payload.client_id,
            camera: payload.camera,
            description: 'SDP answer from client',
            sdp: payload.sdp,
        });
    }

    /**
     * Отправить close-уведомление серверу.
     * Вызывается: при уничтожении WebRTC, при ручном отключении.
     */
    sendClose(payload: ClosePayload): boolean {
        return this.send({
            type: 'close',
            client_id: payload.client_id,
            camera: payload.camera,
            description: payload.description ?? 'client disconnect',
        });
    }

    get isOpen(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    // ─── Внутренняя логика ──────────────────────────────────────────────────

    private connect(): void {
        if (this.destroyed) return;

        this.clearRetryTimer();

        console.log(`[WSManager] Connecting to ${this.url} (attempt ${this.retryAttempt})`);
        this.handlers.onStatusChange?.('connecting');

        const ws = new WebSocket(this.url);
        this.ws = ws;

        ws.onopen = () => {
            if (this.destroyed || this.ws !== ws) { ws.close(); return; }
            console.log('[WSManager] Connected');
            this.retryAttempt = 0;
            this.handlers.onStatusChange?.('connected');
            this.handlers.onOpen?.();
        };

        ws.onmessage = (event: MessageEvent) => {
            if (this.destroyed || this.ws !== ws) return;
            try {
                const msg: SignalingMessage = JSON.parse(event.data as string);
                console.log('[WSManager] ← received:', msg.type);
                this.handlers.onMessage?.(msg);
            } catch (err) {
                console.error('[WSManager] Failed to parse message:', err);
            }
        };

        ws.onerror = () => {
            // Ошибка всегда сопровождается onclose, обрабатываем там.
            console.warn('[WSManager] Socket error');
        };

        ws.onclose = (event: CloseEvent) => {
            if (this.ws !== ws) return; // устаревший WS — игнорируем
            this.ws = null;

            const reason = `code=${event.code} reason=${event.reason}`;
            console.log(`[WSManager] Closed: ${reason}`);

            this.handlers.onStatusChange?.('disconnected');
            this.handlers.onClose?.(reason);

            if (!this.destroyed) {
                this.scheduleReconnect();
            }
        };
    }

    private scheduleReconnect(): void {
        if (this.destroyed) return;
        if (this.retryTimer !== null) return;

        const delay = Math.min(
            BASE_RETRY_DELAY_MS * Math.pow(2, this.retryAttempt),
            MAX_RETRY_DELAY_MS,
        );
        this.retryAttempt += 1;

        console.log(`[WSManager] Retry in ${delay}ms (attempt ${this.retryAttempt})`);

        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!this.destroyed) this.connect();
        }, delay);
    }

    private clearRetryTimer(): void {
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    private closeSocket(code = 1000, reason = ''): void {
        if (!this.ws) return;
        const ws = this.ws;
        this.ws = null;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try { ws.close(code, reason); } catch { /* ignore */ }
    }

    private send(data: Record<string, unknown>): boolean {
        if (!this.isOpen) {
            console.warn('[WSManager] Cannot send — WS not open:', data.type);
            return false;
        }
        try {
            this.ws!.send(JSON.stringify(data));
            console.log('[WSManager] → sent:', data.type);
            return true;
        } catch (err) {
            console.error('[WSManager] Send error:', err);
            return false;
        }
    }
}