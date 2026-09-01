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
import { WebSocketManager } from './WebSocketManager';
import type { WSStatus } from './WebSocketManager';
import { WebRTCManager } from './WebRTCManager';
import type { RTCStatus } from './WebRTCManager';
import { describeError, type ErrorInfo } from './error-codes';

export type PlayerStatus =
    | 'connecting'   // WS подключается
    | 'signaling'    // WS есть, ждём accept от камеры
    | 'streaming'    // видео идёт
    | 'reconnecting' // что-то упало, ждём следующую попытку
    | 'error';       // оставлено для старых потребителей; хук его не выставляет

/** Любое сообщение сигналинга, включая надстройки: neural, correction, orbit */
export type PlayerMessage = { type: string } & Record<string, unknown>;

/** Измеренные показатели сессии; null в поле — браузер его не отдал */
export interface PlayerStats {
    fps: number | null;
    /** Входящий поток, Мбит/с */
    mbits: number | null;
    /** Круговая задержка выбранной пары кандидатов, мс */
    rttMs: number | null;
    /** Доля потерянных пакетов, % */
    lossPct: number | null;
}

interface UseWebRTCPlayerOptions {
    cameraId: string;
    /** Ключ потока камеры; пусто — сервер берёт первый смотрибельный */
    stream?: string;
    signalingUrl: string;
    clientId?: string;
    /** Снимать getStats раз в секунду; включать только у видимых ячеек */
    collectStats?: boolean;
    /** Сообщения, которые хук сам не обрабатывает — надстройкам плеера */
    onMessage?: (msg: PlayerMessage) => void;
}

interface UseWebRTCPlayerResult {
    status: PlayerStatus;
    errorMsg: string;
    /** Последняя причина с кодом; живёт до следующего успешного подключения */
    errorInfo: ErrorInfo | null;
    /** Номер текущей попытки подключения; 0 — идёт первая */
    attempt: number;
    /** Ключ потока, который камера отдала на самом деле; null — не сказала */
    grantedStream: string | null;
    videoRef: React.RefObject<HTMLVideoElement>;
    /** null, пока не прошёл первый интервал или сбор выключен */
    stats: PlayerStats | null;
    /** Отправить своё сообщение в сигналинг; false — WS закрыт */
    send: (data: Record<string, unknown>) => boolean;
}

// Сколько ждать ответа камеры на запрос соединения. Камера успевает поднять
// подпайплайн не всегда быстро, поэтому ждём долго, а не долбим её заново
const ANSWER_TIMEOUT_MS = 10_000;

// Пауза перед следующей попыткой: 2 → 4 → 8 → 15 секунд и дальше по 15.
// Потолка попыток нет: изделие работает без оператора, стучаться нужно всегда
const BASE_RETRY_MS = 2000;
const MAX_RETRY_MS = 15_000;

// Сторож кадров: устройство может уничтожить сессию молча (перезапуск потока),
// и тогда peer-connection остаётся «подключённым», а кадров нет
const STALL_POLL_MS = 2000;
const STALL_TIMEOUT_MS = 8000;

// Период снятия статистики соединения
const STATS_INTERVAL_MS = 1000;

function makeClientId(): string {
    return `client_${Math.random().toString(36).substring(2, 11)}`;
}

export function useWebRTCPlayer({
                                    cameraId,
                                    stream,
                                    signalingUrl,
                                    clientId: externalClientId,
                                    collectStats = false,
                                    onMessage,
                                }: UseWebRTCPlayerOptions): UseWebRTCPlayerResult {
    const videoRef = useRef<HTMLVideoElement>(null);

    const [status, setStatus] = useState<PlayerStatus>('connecting');
    const [errorInfo, setErrorInfo] = useState<ErrorInfo | null>(null);
    const [attempt, setAttempt] = useState(0);
    // Ответ храним вместе с запросом, на который он пришёл: иначе при смене
    // потока сторожа наверху судят по ответу прошлой сессии
    const [granted, setGranted] = useState<{ forStream?: string; value: string | null } | null>(null);
    const [stats, setStats] = useState<PlayerStats | null>(null);

    // Колбэк в ref: инлайн-функция родителя не должна пересоздавать сессию
    const onMessageRef = useRef(onMessage);
    onMessageRef.current = onMessage;

    // Стабильный client_id на всё время жизни хука
    const clientIdRef = useRef<string>(externalClientId ?? makeClientId());

    // Идентификатор сессии выдаёт камера; им адресуются answer, ice и close
    const sessionIdRef = useRef<string>('');

    // Ссылки на менеджеры — создаются один раз в useEffect
    const wsRef = useRef<WebSocketManager | null>(null);
    const rtcRef = useRef<WebRTCManager | null>(null);

    // Номер попытки для нарастающей паузы; обнуляется при успехе и при
    // открытии нового сокета — свежее соединение это новый шанс
    const retryAttemptRef = useRef(0);
    const retryTimerRef = useRef<number | null>(null);
    // Ожидание ответа на запрос соединения
    const answerTimerRef = useRef<number | null>(null);
    // Ссылка на саму отправку: нужна, чтобы повтор вызывал свежую версию
    const sendRef = useRef<() => void>(() => {});

    const clearAnswerTimer = useCallback(() => {
        if (answerTimerRef.current !== null) {
            window.clearTimeout(answerTimerRef.current);
            answerTimerRef.current = null;
        }
    }, []);

    const clearRetryTimer = useCallback(() => {
        if (retryTimerRef.current !== null) {
            window.clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
        }
    }, []);

    // Следующая попытка запроса сессии. Причина остаётся видимой до успеха:
    // статус сокета не должен втихую превращать её в «подключение»
    const scheduleRetry = useCallback((info: ErrorInfo) => {
        clearAnswerTimer();
        setErrorInfo(info);
        setStatus('reconnecting');

        if (retryTimerRef.current !== null) return;

        const delay = Math.min(BASE_RETRY_MS * Math.pow(2, retryAttemptRef.current), MAX_RETRY_MS);
        retryAttemptRef.current += 1;
        setAttempt(retryAttemptRef.current);

        console.warn(`[Player:${cameraId}] retry #${retryAttemptRef.current} in ${delay}ms: ${info.text}`);

        retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null;
            sendRef.current();
        }, delay);
    }, [cameraId, clearAnswerTimer]);

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

        clearRetryTimer();
        clearAnswerTimer();

        console.log(`[Player:${cameraId}] → connection request`);
        // Прежней сессии больше нет
        sessionIdRef.current = '';
        setGranted(null);
        setStatus(prev => (prev === 'reconnecting' ? prev : 'signaling'));

        const sent = ws.sendConnectionRequest({ client_id: clientIdRef.current, camera: cameraId, stream });
        if (!sent) {
            // Сокет закрыт: он поднимется сам, но попытку всё равно планируем —
            // иначе запрос потеряется молча, как было с потолком отказов
            scheduleRetry({ code: null, kind: 'transport', text: 'Нет связи с сигналингом' });
            return;
        }

        // Ответа может не быть вовсе: брокер молча выбрасывает сообщение,
        // если камера к нему не подключена
        answerTimerRef.current = window.setTimeout(() => {
            answerTimerRef.current = null;
            scheduleRetry({
                code: null,
                kind: 'transport',
                text: 'Камера не ответила на запрос соединения',
            });
        }, ANSWER_TIMEOUT_MS);
    }, [cameraId, stream, clearAnswerTimer, clearRetryTimer, scheduleRetry]);

    useEffect(() => {
        sendRef.current = sendConnectionRequest;
    }, [sendConnectionRequest]);

    useEffect(() => () => {
        clearAnswerTimer();
        clearRetryTimer();
    }, [clearAnswerTimer, clearRetryTimer]);

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
                    session_id: sessionIdRef.current,
                    candidate: candidate.candidate ?? '',
                    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
                    sdpMid: candidate.sdpMid ?? null,
                    usernameFragment: candidate.usernameFragment ?? null,
                });
            },

            onSendAnswer: (sdp) => {
                ws?.sendAnswer({
                    client_id: clientIdRef.current,
                    camera: cameraId,
                    session_id: sessionIdRef.current,
                    sdp,
                });
            },

            // Любое закрытие PC → уведомить сервер
            onSendClose: () => {
                ws?.sendClose({
                    client_id: clientIdRef.current,
                    camera: cameraId,
                    session_id: sessionIdRef.current,
                    description: 'client WebRTC closed',
                });
            },

            // PC закрылся не по нашей инициативе → нужен новый connection-request
            onNeedReconnect: (reason) => {
                console.warn(`[Player:${cameraId}] RTC needs reconnect: ${reason}`);
                clearVideoSrc();
                // Очищаем ссылку (teardown уже внутри RTCManager)
                rtcRef.current = null;
                // Новая сессия запрашивается через общую очередь: мгновенный
                // перезапрос от шестнадцати ячеек сразу камере не нужен
                scheduleRetry({ code: null, kind: 'session', text: `Сессия оборвалась (${reason})` });
            },

            onStatusChange: (rtcStatus: RTCStatus) => {
                console.log(`[Player:${cameraId}] RTC status: ${rtcStatus}`);
            },

            onTrack: attachStream,
        });

        rtcRef.current.createPeerConnection();
    }, [cameraId, clearVideoSrc, sendConnectionRequest, attachStream, scheduleRetry]);

    // ─── useEffect: создаём менеджеры ───────────────────────────────────────

    useEffect(() => {
        // Генерируем новый clientId при изменении cameraId/signalingUrl
        clientIdRef.current = externalClientId ?? makeClientId();

        console.log(`[Player:${cameraId}] mount, client_id=${clientIdRef.current}`);

        const ws = new WebSocketManager(signalingUrl, {

            onOpen: () => {
                // Свежий сокет — новый шанс: очередь пауз начинается заново
                retryAttemptRef.current = 0;
                sendConnectionRequest();
            },

            onMessage: (msg) => {
                const rtc = rtcRef.current;

                if (msg.type === 'connection') {
                    clearAnswerTimer();

                    if (msg.ret === 'success') {
                        retryAttemptRef.current = 0;
                        setAttempt(0);
                        clearRetryTimer();
                        setErrorInfo(null);

                        const value = (msg as unknown as PlayerMessage).stream;
                        setGranted({ forStream: stream, value: typeof value === 'string' ? value : null });
                        sessionIdRef.current = msg.session_id ?? '';
                        console.log(`[Player:${cameraId}] Camera accepted connection`);
                        // Создаём PeerConnection
                        createRTC();
                        return;
                    }

                    // Отказ несёт код: у брокера 1xxx, у камеры — свой
                    scheduleRetry(describeError(msg as unknown as Record<string, unknown>));
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

                const raw = msg as unknown as PlayerMessage;

                if (raw.type === 'stream_error') {
                    // Ошибки рассылаются всем клиентам камеры, а потоков у неё
                    // несколько: чужой сломанный поток нас не касается
                    if (typeof raw.stream === 'string' && stream && raw.stream !== stream) {
                        return;
                    }

                    const info = describeError(raw);
                    console.warn(`[Player:${cameraId}] stream error: ${info.code ?? info.text}`);
                    onMessageRef.current?.(raw);
                    // Сессия поверх умершего потока бесполезна: рвём и встаём в очередь
                    closeRTC(true);
                    rtcRef.current = null;
                    scheduleRetry(info);
                    return;
                }

                if (msg.type === 'close') {
                    // Подтверждение нашего же close: закрывать нечего
                    if (msg.ret === 'success') return;

                    // Сессию разорвало устройство
                    console.warn(`[Player:${cameraId}] Server closed session`);
                    // Закрываем RTC без повторной отправки close (сервер уже знает)
                    closeRTC(false);
                    rtcRef.current = null;

                    const closeInfo = describeError(raw);
                    scheduleRetry(closeInfo.code !== null
                        ? closeInfo
                        : { code: null, kind: 'session', text: 'Устройство закрыло сессию' });
                    return;
                }

                if (raw.type === 'fault') {
                    setErrorInfo(describeError(raw));
                    return;
                }

                // neural, neural_tracks, correction, orbit — разбирают надстройки
                onMessageRef.current?.(raw);
            },

            onClose: (reason) => {
                // WS упал → принудительно закрываем RTC
                // close(true) = пытаемся отправить close через WS (не получится если WS уже закрыт,
                // WebSocketManager.send вернёт false — это нормально)
                console.warn(`[Player:${cameraId}] WS closed: ${reason}`);
                closeRTC(true);
                rtcRef.current = null;
                setErrorInfo({ code: null, kind: 'transport', text: 'Связь с сигналингом прервана' });
                setStatus('reconnecting');
                // WS реконнектится сам. onOpen снова вызовет sendConnectionRequest.
            },

            onStatusChange: (wsStatus: WSStatus) => {
                console.log(`[Player:${cameraId}] WS status: ${wsStatus}`);
                if (wsStatus !== 'connecting') return;
                // «Подключение» показываем только на первом заходе: после сбоя
                // состояние честнее назвать переподключением
                setStatus(prev => (prev === 'connecting' || prev === 'signaling' ? 'connecting' : 'reconnecting'));
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
    }, [cameraId, stream, signalingUrl]);

    // ─── Сторож кадров ──────────────────────────────────────────────────────

    useEffect(() => {
        if (status !== 'streaming') return;

        let lastFrames = -1;
        let stalledMs = 0;

        const timer = window.setInterval(() => {
            void rtcRef.current?.getStats().then(report => {
                if (!report) return;

                let frames = -1;
                report.forEach(entry => {
                    const item = entry as unknown as Record<string, unknown>;
                    if (item.type === 'inbound-rtp' && item.kind === 'video'
                        && typeof item.framesDecoded === 'number') {
                        frames = item.framesDecoded;
                    }
                });

                if (frames < 0) return;

                if (frames !== lastFrames) {
                    lastFrames = frames;
                    stalledMs = 0;
                    return;
                }

                stalledMs += STALL_POLL_MS;
                if (stalledMs < STALL_TIMEOUT_MS) return;

                console.warn(`[Player:${cameraId}] no new frames for ${stalledMs}ms, restarting session`);
                closeRTC(true);
                rtcRef.current = null;
                scheduleRetry({ code: null, kind: 'stream', text: 'Кадры перестали приходить' });
            });
        }, STALL_POLL_MS);

        return () => window.clearInterval(timer);
    }, [status, cameraId, closeRTC, scheduleRetry]);

    // ─── Статистика соединения ──────────────────────────────────────────────

    useEffect(() => {
        if (!collectStats) {
            setStats(null);
            return;
        }

        // Предыдущий снимок: показатели считаются приращением
        let prev: {
            ts: number;
            bytes: number;
            frames: number;
            lost: number;
            received: number;
        } | null = null;

        const num = (v: unknown): number | null =>
            typeof v === 'number' && Number.isFinite(v) ? v : null;

        const timer = window.setInterval(async () => {
            const report = await rtcRef.current?.getStats();
            if (!report) {
                setStats(null);
                prev = null;
                return;
            }

            let inbound: Record<string, unknown> | null = null;
            let rttMs: number | null = null;

            report.forEach(entry => {
                const item = entry as unknown as Record<string, unknown>;
                if (item.type === 'inbound-rtp' && item.kind === 'video') {
                    inbound = item;
                }
                // Пара кандидатов бывает нескольких, задержку несёт выбранная
                if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) {
                    const rtt = num(item.currentRoundTripTime);
                    if (rtt !== null) rttMs = Math.round(rtt * 1000);
                }
            });

            if (!inbound) {
                setStats(null);
                return;
            }

            const now = num((inbound as Record<string, unknown>).timestamp) ?? 0;
            const bytes = num((inbound as Record<string, unknown>).bytesReceived) ?? 0;
            const frames = num((inbound as Record<string, unknown>).framesDecoded) ?? 0;
            const lost = num((inbound as Record<string, unknown>).packetsLost) ?? 0;
            const received = num((inbound as Record<string, unknown>).packetsReceived) ?? 0;

            // framesPerSecond отдают не все сборки Chromium — тогда считаем сами
            let fps = num((inbound as Record<string, unknown>).framesPerSecond);
            let mbits: number | null = null;
            let lossPct: number | null = null;

            if (prev && now > prev.ts) {
                const seconds = (now - prev.ts) / 1000;
                mbits = ((bytes - prev.bytes) * 8) / seconds / 1_000_000;
                if (fps === null) fps = (frames - prev.frames) / seconds;

                const lostDelta = lost - prev.lost;
                const receivedDelta = received - prev.received;
                const total = lostDelta + receivedDelta;
                if (total > 0) lossPct = (lostDelta / total) * 100;
            }

            prev = { ts: now, bytes, frames, lost, received };
            setStats({ fps, mbits, rttMs, lossPct });
        }, STATS_INTERVAL_MS);

        return () => window.clearInterval(timer);
    }, [collectStats, cameraId, stream, signalingUrl]);

    const send = useCallback((data: Record<string, unknown>): boolean => {
        // client_id и camera обязательны: без них камера отвечает отказом
        return wsRef.current?.sendMessage({
            client_id: clientIdRef.current,
            camera: cameraId,
            ...data,
        }) ?? false;
    }, [cameraId]);

    // errorMsg оставлен для потребителей, которым хватает текста
    // Ответ прошлой сессии для текущего запроса не значит ничего
    const grantedStream = granted && granted.forStream === stream ? granted.value : null;

    return { status, errorMsg: errorInfo?.text ?? '', errorInfo, attempt, grantedStream, videoRef, stats, send };
}