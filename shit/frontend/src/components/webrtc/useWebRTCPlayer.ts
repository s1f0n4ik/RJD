/**
 * useWebRTCPlayer
 *
 * Оркестратор: связывает WebSocketManager и WebRTCManager.
 *
 * Правила взаимодействия:
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │  WS открылся          → отправить connection-request             │
 *  │  WS получил success   → создать RTCPeerConnection                │
 *  │  WS получил offer     → передать в RTCManager                   │
 *  │  WS получил ice       → передать в RTCManager                   │
 *  │  WS закрылся          → закрыть RTCManager (с отправкой close)  │
 *  │                         WS реконнектится сам                     │
 *  │  RTC: pc=failed       → RTCManager сам шлёт close через WS      │
 *  │                       → запросить новый connection-request       │
 *  │  destroy()            → WS.destroy() + RTC.destroy()            │
 *  └──────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { WebSocketManager, WSStatus } from './WebSocketManager';
import { WebRTCManager, RTCStatus } from './WebRTCManager';

export type PlayerStatus =
    | 'connecting'   // WS подключается
    | 'signaling'    // WS есть, ждём accept от камеры
    | 'streaming'    // видео идёт
    | 'reconnecting' // что-то упало, ждём реконнект
    | 'error';       // невосстановимая ошибка (не используется сейчас — всё reconnect)

interface UseWebRTCPlayerOptions {
    cameraId: string;
    signalingUrl: string;
    clientId?: string;
}

interface UseWebRTCPlayerResult {
    status: PlayerStatus;
    errorMsg: string;
    videoRef: React.RefObject<HTMLVideoElement>;
}

function makeClientId(): string {
    return `client_${Math.random().toString(36).substring(2, 11)}`;
}

export function useWebRTCPlayer({
                                    cameraId,
                                    signalingUrl,
                                    clientId: externalClientId,
                                }: UseWebRTCPlayerOptions): UseWebRTCPlayerResult {
    const videoRef = useRef<HTMLVideoElement>(null);

    const [status, setStatus] = useState<PlayerStatus>('connecting');
    const [errorMsg, setErrorMsg] = useState('');

    // Стабильный client_id на всё время жизни хука
    const clientIdRef = useRef<string>(externalClientId ?? makeClientId());

    // Ссылки на менеджеры — создаются один раз в useEffect
    const wsRef = useRef<WebSocketManager | null>(null);
    const rtcRef = useRef<WebRTCManager | null>(null);

    // ─── Вспомогательные функции ────────────────────────────────────────────

    const clearVideoSrc = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        if (video.srcObject) {
            (video.srcObject as MediaStream).getTracks().forEach(t => {
                try { t.stop(); } catch { /* ignore */ }
            });
            video.srcObject = null;
        }
    }, []);

    const attachStream = useCallback((stream: MediaStream) => {
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        setStatus('streaming');
    }, []);

    // Закрыть текущий WebRTC без реконнекта (напр. WS упал — ждём пока WS поднимется)
    const closeRTC = useCallback((sendClose: boolean) => {
        if (rtcRef.current) {
            rtcRef.current.close(sendClose);
            rtcRef.current = null;
        }
        clearVideoSrc();
    }, [clearVideoSrc]);

    // Отправить connection-request (WS должен быть открыт)
    const sendConnectionRequest = useCallback(() => {
        const ws = wsRef.current;
        if (!ws) return;
        console.log(`[Player:${cameraId}] → connection request`);
        setStatus('signaling');
        ws.sendConnectionRequest({ client_id: clientIdRef.current, camera: cameraId });
    }, [cameraId]);

    // ─── Создать RTCManager ─────────────────────────────────────────────────

    const createRTC = useCallback(() => {
        if (rtcRef.current) {
            console.warn(`[Player:${cameraId}] RTC already exists`);
            return;
        }

        const ws = wsRef.current;

        rtcRef.current = new WebRTCManager({
            onSendIce: (candidate) => {
                ws?.sendIceCandidate({
                    client_id: clientIdRef.current,
                    camera: cameraId,
                    candidate: candidate.candidate ?? '',
                    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
                    sdpMid: candidate.sdpMid ?? null,
                    usernameFragment: candidate.usernameFragment ?? null,
                });
            },

            onSendAnswer: (sdp) => {
                ws?.sendAnswer({ client_id: clientIdRef.current, camera: cameraId, sdp });
            },

            // Любое закрытие PC → уведомить сервер
            onSendClose: () => {
                ws?.sendClose({
                    client_id: clientIdRef.current,
                    camera: cameraId,
                    description: 'client WebRTC closed',
                });
            },

            // PC закрылся не по нашей инициативе → нужен новый connection-request
            onNeedReconnect: (reason) => {
                console.warn(`[Player:${cameraId}] RTC needs reconnect: ${reason}`);
                clearVideoSrc();
                // Очищаем ссылку (teardown уже внутри RTCManager)
                rtcRef.current = null;
                setStatus('reconnecting');
                setErrorMsg(`Переподключение WebRTC (${reason})`);
                // Если WS открыт — сразу запрашиваем новую сессию
                if (ws?.isOpen) {
                    sendConnectionRequest();
                }
                // Если WS не открыт — он реконнектится сам и onOpen запустит sendConnectionRequest
            },

            onStatusChange: (rtcStatus: RTCStatus) => {
                console.log(`[Player:${cameraId}] RTC status: ${rtcStatus}`);
            },

            onTrack: attachStream,
        });

        rtcRef.current.createPeerConnection();
    }, [cameraId, clearVideoSrc, sendConnectionRequest, attachStream]);

    // ─── useEffect: создаём менеджеры ───────────────────────────────────────

    useEffect(() => {
        // Генерируем новый clientId при изменении cameraId/signalingUrl
        clientIdRef.current = externalClientId ?? makeClientId();

        console.log(`[Player:${cameraId}] mount, client_id=${clientIdRef.current}`);

        const ws = new WebSocketManager(signalingUrl, {

            onOpen: () => {
                // WS открылся → запрашиваем соединение с камерой
                sendConnectionRequest();
            },

            onMessage: (msg) => {
                const rtc = rtcRef.current;

                if (msg.type === 'connection') {
                    if (msg.ret === 'success') {
                        console.log(`[Player:${cameraId}] Camera accepted connection`);
                        // Создаём PeerConnection
                        createRTC();
                    } else {
                        console.warn(`[Player:${cameraId}] Camera rejected: ret=${msg.ret}`);
                        setStatus('reconnecting');
                        setErrorMsg(`Камера отклонила соединение (ret=${msg.ret})`);
                        // Повторим connection-request через паузу (простая задержка)
                        setTimeout(() => {
                            if (ws.isOpen) sendConnectionRequest();
                        }, 3000);
                    }
                    return;
                }

                if (msg.type === 'offer' && rtc) {
                    rtc.handleOffer(msg.sdp);
                    return;
                }

                if (msg.type === 'ice' && rtc) {
                    rtc.handleRemoteIce({
                        candidate: msg.candidate,
                        sdpMLineIndex: msg.sdpMLineIndex,
                        sdpMid: msg.sdpMid,
                    });
                    return;
                }

                if (msg.type === 'close') {
                    // Сервер закрыл сессию
                    console.warn(`[Player:${cameraId}] Server closed session`);
                    // Закрываем RTC без повторной отправки close (сервер уже знает)
                    closeRTC(false);
                    rtcRef.current = null;
                    setStatus('reconnecting');
                    setErrorMsg('Сервер закрыл сессию, переподключение...');
                    // Переподключаемся
                    if (ws.isOpen) sendConnectionRequest();
                    return;
                }
            },

            onClose: (reason) => {
                // WS упал → принудительно закрываем RTC
                // close(true) = пытаемся отправить close через WS (не получится если WS уже закрыт,
                // WebSocketManager.send вернёт false — это нормально)
                console.warn(`[Player:${cameraId}] WS closed: ${reason}`);
                closeRTC(true);
                rtcRef.current = null;
                setStatus('reconnecting');
                setErrorMsg('Соединение прервано, переподключение...');
                // WS реконнектится сам. onOpen снова вызовет sendConnectionRequest.
            },

            onStatusChange: (wsStatus: WSStatus) => {
                console.log(`[Player:${cameraId}] WS status: ${wsStatus}`);
                if (wsStatus === 'connecting') {
                    setStatus(prev => prev === 'streaming' ? 'reconnecting' : 'connecting');
                }
            },
        });

        wsRef.current = ws;
        ws.start();

        return () => {
            console.log(`[Player:${cameraId}] unmount — destroying managers`);
            // destroy() у RTCManager отправит close через WS перед его закрытием
            rtcRef.current?.destroy();
            rtcRef.current = null;
            // destroy() у WSManager закроет WS без реконнектов
            ws.destroy();
            wsRef.current = null;
            clearVideoSrc();
        };

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cameraId, signalingUrl]);

    return { status, errorMsg, videoRef };
}