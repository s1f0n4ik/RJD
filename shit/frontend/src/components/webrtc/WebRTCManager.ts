/**
 * WebRTCManager
 *
 * Управляет RTCPeerConnection. Не знает о WebSocket напрямую —
 * общается с сигналингом через колбэки (onSendIce, onSendAnswer, onSendClose).
 *
 * Правила:
 *  - Любое закрытие PC (ручное или по ошибке) → вызывает onSendClose
 *  - Если закрылось не намеренно → вызывает onNeedReconnect
 *  - destroy() — единственная точка ручного останова
 */

export type RTCStatus = 'idle' | 'connecting' | 'connected' | 'failed';

export interface RTCHandlers {
    /** Отправить ICE-кандидата через сигналинг */
    onSendIce: (candidate: RTCIceCandidateInit) => void;
    /** Отправить SDP-answer через сигналинг */
    onSendAnswer: (sdp: string) => void;
    /**
     * Уведомить сигналинг о закрытии сессии.
     * Вызывается при ЛЮБОМ закрытии PeerConnection.
     */
    onSendClose: () => void;
    /**
     * Вызывается, если PC закрылся НЕ по команде destroy().
     * WebSocketManager / родитель должен инициировать новый connection-request.
     */
    onNeedReconnect: (reason: string) => void;
    /** Изменение статуса */
    onStatusChange?: (status: RTCStatus) => void;
    /** Получен видеопоток */
    onTrack?: (stream: MediaStream) => void;
}

const ICE_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    {
        urls: 'turn:172.25.78.169:3478',
        username: 'niac',
        credential: 'VniiTest',
    },
];

export class WebRTCManager {
    private readonly handlers: RTCHandlers;

    private reconnectLocked = false;

    private pc: RTCPeerConnection | null = null;
    private destroyed = false;

    constructor(handlers: RTCHandlers) {
        this.handlers = handlers;
    }

    // ─── Публичный API ──────────────────────────────────────────────────────

    /**
     * Создать RTCPeerConnection и начать переговоры.
     * Вызывается после получения connection:success от камеры.
     */
    createPeerConnection(): void {
        if (this.destroyed) {
            console.warn('[RTCManager] Cannot create PC — destroyed');
            return;
        }
        if (this.pc) {
            console.warn('[RTCManager] PC already exists, ignoring');
            return;
        }

        this.reconnectLocked = false;

        console.log('[RTCManager] Creating RTCPeerConnection');
        this.handlers.onStatusChange?.('connecting');

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        this.pc = pc;

        pc.addTransceiver('video', { direction: 'recvonly' });

        pc.onicecandidate = (event) => {
            if (this.pc !== pc) return;
            if (event.candidate) {
                console.log('[RTCManager] → ICE candidate');
                this.handlers.onSendIce({
                    candidate: event.candidate.candidate,
                    sdpMLineIndex: event.candidate.sdpMLineIndex,
                    sdpMid: event.candidate.sdpMid ?? undefined,
                    usernameFragment: event.candidate.usernameFragment ?? undefined,
                });
            }
        };

        pc.ontrack = (event) => {
            if (this.pc !== pc) return;
            console.log('[RTCManager] 🎥 Got video track');
            this.handlers.onStatusChange?.('connected');
            this.handlers.onTrack?.(event.streams[0]);
        };

        pc.onconnectionstatechange = () => {
            if (this.pc !== pc) return;
            const state = pc.connectionState;
            console.log('[RTCManager] Connection state:', state);

            if (state === 'failed' || state === 'closed') {
                if (this.reconnectLocked || this.destroyed) return;

                this.reconnectLocked = true;

                this.handlers.onStatusChange?.('failed');
                // Уведомляем сигналинг о закрытии сессии
                this.handlers.onSendClose();
                // Очищаем PC
                this.teardownPC(pc);
                // Если не мы инициировали закрытие — просим реконнект
                if (!this.destroyed) {
                    this.handlers.onNeedReconnect(`pc_state=${state}`);
                }
            }
        };

        pc.oniceconnectionstatechange = () => {
            if (this.pc !== pc) return;
            console.log('[RTCManager] ICE state:', pc.iceConnectionState);
        };
    }

    /**
     * Обработать входящий SDP-offer от камеры.
     */
    async handleOffer(sdp: string): Promise<void> {
        if (this.destroyed || !this.pc) {
            console.warn('[RTCManager] handleOffer: no active PC');
            return;
        }

        const pc = this.pc;
        console.log('[RTCManager] Processing SDP offer');

        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            if (this.pc === pc && answer.sdp) {
                console.log('[RTCManager] → SDP answer');
                this.handlers.onSendAnswer(answer.sdp);
            }
        } catch (err) {
            console.error('[RTCManager] SDP error:', err);
            // SDP-ошибка — закрываем текущую сессию и просим реконнект
            this.handlers.onSendClose();
            this.teardownPC(pc);
            if (!this.destroyed) {
                this.handlers.onNeedReconnect(`sdp_error`);
            }
        }
    }

    /**
     * Добавить входящий ICE-кандидат.
     */
    async handleRemoteIce(init: RTCIceCandidateInit): Promise<void> {
        if (this.destroyed || !this.pc) return;
        try {
            await this.pc.addIceCandidate(new RTCIceCandidate(init));
            console.log('[RTCManager] ✅ Added remote ICE');
        } catch (err) {
            console.error('[RTCManager] ICE add error:', err);
        }
    }

    /**
     * Принудительно закрыть PC.
     * Обязательно вызывается когда:
     *   - WS закрылся (сигналинг пропал)
     *   - Родитель явно хочет завершить сессию
     *
     * Отправляет close через сигналинг (если wsManager.isOpen).
     */
    close(sendCloseMsg = true): void {
        if (!this.pc) return;
        const pc = this.pc;
        console.log('[RTCManager] close() called, sendClose:', sendCloseMsg);
        if (sendCloseMsg) {
            this.handlers.onSendClose();
        }
        this.teardownPC(pc);
    }

    /**
     * Финальный останов — больше никаких реконнектов.
     */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        console.log('[RTCManager] destroy()');
        this.close(true);
    }

    /** Сырая статистика соединения; null — сессии нет */
    async getStats(): Promise<RTCStatsReport | null> {
        if (!this.pc) return null;
        try {
            return await this.pc.getStats();
        } catch {
            return null;
        }
    }

    get isConnecting(): boolean {
        return this.pc?.connectionState === 'connecting';
    }

    get isConnected(): boolean {
        return this.pc?.connectionState === 'connected';
    }

    // ─── Внутренняя логика ──────────────────────────────────────────────────

    private teardownPC(pc: RTCPeerConnection): void {
        if (this.pc === pc) {
            this.pc = null;
        }

        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.oniceconnectionstatechange = null;

        try { pc.close(); } catch { /* ignore */ }
        console.log('[RTCManager] PC closed');
    }
}