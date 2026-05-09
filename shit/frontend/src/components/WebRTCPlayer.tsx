import React, { useEffect, useRef, useState } from 'react';
import { Box, Typography, CircularProgress, IconButton, Paper } from '@mui/material';
import { Fullscreen, Error as ErrorIcon } from '@mui/icons-material';

interface WebRTCPlayerProps {
    cameraId: string;
    cameraName?: string;
    signalingUrl: string;
    onError?: (error: string) => void;
}

const WebRTCPlayer: React.FC<WebRTCPlayerProps> = ({ cameraId, cameraName, signalingUrl, onError }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
    const [errorMsg, setErrorMsg] = useState<string>('');

    const wsRef = useRef<WebSocket | null>(null);
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const clientIdRef = useRef<string>('');
    const isMountedRef = useRef<boolean>(true);
    const cleanupTimeoutRef = useRef<number | null>(null);

    const retryTimeoutRef = useRef<number | null>(null);
    const retryAttemptRef = useRef<number>(0);
    const isRetryingRef = useRef<boolean>(false);
    const intentionalCloseRef = useRef<boolean>(false);

    const connectionTimeoutRef = useRef<number | null>(null);
    const connectionResponseTimeoutRef = useRef<number | null>(null);

    const MAX_RETRY_DELAY = 15000;
    const getRetryDelay = () => {
        const base = 2000 * Math.pow(2, retryAttemptRef.current); // 2s, 4s, 8s, 16s…
        return Math.min(base, MAX_RETRY_DELAY);
    };

    // Внутренний reset PC + WS без отправки close-сообщения.
    // Не ставит intentionalClose — это именно переустановка соединения.
    const softReset = () => {
        if (pcRef.current) {
            try { pcRef.current.close(); } catch {}
            pcRef.current = null;
        }
        if (videoRef.current && videoRef.current.srcObject) {
            const stream = videoRef.current.srcObject as MediaStream;
            stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
            videoRef.current.srcObject = null;
        }
        if (wsRef.current) {
            // 🔑 отвязываем обработчики ДО close, чтобы отложенный onclose старого WS
            // не дёрнул scheduleReconnect ещё раз.
            wsRef.current.onopen = null;
            wsRef.current.onmessage = null;
            wsRef.current.onerror = null;
            wsRef.current.onclose = null;
            try { wsRef.current.close(); } catch {}
            wsRef.current = null;
        }
    };

    const sendCloseRequest = () => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            try {
                wsRef.current.send(JSON.stringify({
                    type: 'close',
                    client_id: clientIdRef.current,
                    camera: cameraId,
                    description: 'client disconnect'
                }));

                console.log(`[${cameraId}] 📤 Sent close message`);
            } catch (err) {
                console.error(`[${cameraId}] ❌ Error sending close message:`, err);
            }
        }
    };

    const sendCreateRequest = () => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            try {
                const connectionRequest = {
                    type: 'connection',
                    client_id: clientIdRef.current,
                    camera: cameraId,
                    description: 'connect_request from client',
                    ret: 'none'
                };

                wsRef.current.send(JSON.stringify(connectionRequest));
                console.log(`[${cameraId}] 📤 Sent connection request`);

                startConnectionResponseTimeout();
            } catch (err) {
                console.error(`[${cameraId}] ❌ Error sending create request:`, err);
            }
        }
    };

    const startConnectionResponseTimeout = () => {
        // очищаем старый таймер
        if (connectionResponseTimeoutRef.current) {
            clearTimeout(connectionResponseTimeoutRef.current);
        }

        connectionResponseTimeoutRef.current = window.setTimeout(() => {
            console.warn(`[${cameraId}] ⏱️ No connection response in 5s, retrying...`);

            if (!isMountedRef.current) return;

            sendCreateRequest(); // повторяем запрос
        }, 5000);
    };

    const closeWebRTC = () => {
        // 1. Close PeerConnection
        if (pcRef.current) {
            console.log(`[${cameraId}] 🔌 Closing PeerConnection (state: ${pcRef.current.connectionState})`);
            pcRef.current.ontrack = null;
            pcRef.current.onicecandidate = null;
            pcRef.current.oniceconnectionstatechange = null;
            pcRef.current.onconnectionstatechange = null;

            try {
                pcRef.current.close();
            } catch {}

            pcRef.current = null;
        }

        // 2. Stop video tracks
        if (videoRef.current && videoRef.current.srcObject) {
            const stream = videoRef.current.srcObject as MediaStream;
            stream.getTracks().forEach(track => {
                console.log(`[${cameraId}] ⏹️ Stopping track: ${track.kind}`);
                track.stop();
            });
            videoRef.current.srcObject = null;
        }
    };

    const scheduleReconnect = (reason: string) => {
        if (!isMountedRef.current) return;
        if (intentionalCloseRef.current) return;
        if (isRetryingRef.current) return;  // уже запланирован
        isRetryingRef.current = true;

        const delay = getRetryDelay();
        retryAttemptRef.current += 1;
        console.warn(`[${cameraId}] 🔁 Reconnect #${retryAttemptRef.current} in ${delay}ms (reason: ${reason})`);

        setStatus('error');
        setErrorMsg(`Переподключение... (попытка ${retryAttemptRef.current})`);

        retryTimeoutRef.current = window.setTimeout(() => {
            retryTimeoutRef.current = null;
            if (!isMountedRef.current) return;
            softReset();
            isRetryingRef.current = false;
            connectWebSocket(); // тот же самый метод, что и на старте — он пошлёт {type:'connection', ...}
        }, delay);
    };

    useEffect(() => {
        isMountedRef.current = true;
        clientIdRef.current = `client_${Math.random().toString(36).substr(2, 9)}`;

        console.log(`[${cameraId}] 🚀 Component mounted, client_id: ${clientIdRef.current}`);

        // Небольшая задержка перед подключением, чтобы избежать race conditions
        cleanupTimeoutRef.current = window.setTimeout(() => {
            if (isMountedRef.current) {
                connectWebSocket();
            }
        }, 2000);

        return () => {
            console.log(`[${cameraId}] 🔴 Component unmounting, cleaning up...`);
            isMountedRef.current = false;

            if (cleanupTimeoutRef.current) {
                clearTimeout(cleanupTimeoutRef.current);
                cleanupTimeoutRef.current = null;
            }

            cleanup();
        };
    }, [cameraId, signalingUrl]);

    const cleanup = () => {
        console.log(`[${cameraId}] 🧹 Cleanup started`);
        intentionalCloseRef.current = true;
        if (retryTimeoutRef.current) {
            clearTimeout(retryTimeoutRef.current);
            retryTimeoutRef.current = null;
        }
        isRetryingRef.current = false;

        closeWebRTC();
        sendCloseRequest()

        // 3. Send close message (но НЕ закрывать WebSocket!)
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {

            // ✅ КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: НЕ закрываем WebSocket, просто очищаем обработчики
            wsRef.current.onopen = null;
            wsRef.current.onmessage = null;
            wsRef.current.onerror = null;
            wsRef.current.onclose = null;

            // ❌ УДАЛИТЬ эту строку:
            // wsRef.current.close(1000, 'Component unmounted');

            wsRef.current = null;
        }

        console.log(`[${cameraId}] ✅ Cleanup complete`);
    };

    const connectWebSocket = async () => {
        if (!isMountedRef.current) {
            console.log(`[${cameraId}] ⚠️ Component unmounted, skipping connection`);
            return;
        }

        setStatus('connecting');

        try {
            console.log(`[${cameraId}] 🔌 Connecting to: ${signalingUrl}`);
            const ws = new WebSocket(signalingUrl);
            wsRef.current = ws;

            ws.onopen = () => {
                if (!isMountedRef.current) {
                    console.log(`[${cameraId}] ⚠️ Component unmounted during connection, closing WS`);
                    ws.close();
                    return;
                }

                console.log(`[${cameraId}] ✅ WebSocket connected`);

                sendCreateRequest();
            };

            ws.onmessage = async (event) => {
                if (!isMountedRef.current) return;

                const msg = JSON.parse(event.data);
                console.log(`[${cameraId}] 📩 Received:`, msg.type);

                if (msg.type === 'connection') {
                    if (msg.ret === 'success') {
                        if (connectionResponseTimeoutRef.current) {
                            clearTimeout(connectionResponseTimeoutRef.current);
                            connectionResponseTimeoutRef.current = null;
                        }
                        console.log(`[${cameraId}] ✅ Camera accepted connection`);
                        createPeerConnection();
                    } else {
                        console.error(`[${cameraId}] ❌ Camera rejected connection: ret=${msg.ret}`);
                        if (isMountedRef.current) {
                            setStatus('error');
                            setErrorMsg('Камера отклонила соединение');
                            onError?.('Camera rejected connection');
                        }
                        // Может отклонять только в случае открытой сессии с таким же клиентом, иначе - не приходит сообщение вовсе
                        sendCloseRequest();
                        // Пробуем еще раз отправить спустя время
                        setTimeout(() => {
                            sendCreateRequest();
                        }, 10000); // 10 секунд
                    }
                    return;
                }

                if (msg.type === 'offer') {
                    await handleOffer(msg.sdp);
                }

                if (msg.type === 'ice') {
                    await handleIceCandidate(msg);
                }
            };

            ws.onerror = (error) => {
                console.error(`[${cameraId}] ❌ WebSocket error:`, error);
                if (!isMountedRef.current) return;
                onError?.('WebSocket error');
                scheduleReconnect('ws.onerror');
            };

            ws.onclose = (event) => {
                console.log(`[${cameraId}] 🔌 WS closed (code=${event.code}, reason=${event.reason})`);
                if (!isMountedRef.current) return;
                if (intentionalCloseRef.current) return; // мы сами закрыли — не ретраимся

                scheduleReconnect(`ws.onclose code=${event.code}`);
            };

        } catch (err) {
            console.error(`[${cameraId}] ❌ Connect error:`, err);
            if (isMountedRef.current) {
                setStatus('error');
                setErrorMsg('Не удалось подключиться');
                onError?.(String(err));
            }
        }
    };

    const createPeerConnection = () => {
        if (!isMountedRef.current) return;

        console.log(`[${cameraId}] 🔧 Creating RTCPeerConnection...`);

        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                {
                    urls: 'turn:172.25.78.169:3478',
                    username: 'niac',
                    credential: 'VniiTest'
                }
            ]
        });
        pcRef.current = pc;

        pc.addTransceiver('video', { direction: 'recvonly' });

        pc.onicecandidate = (event) => {
            if (!isMountedRef.current) return;

            if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
                const msg = {
                    type: 'ice',
                    client_id: clientIdRef.current,
                    camera: cameraId,
                    candidate: event.candidate.candidate,
                    sdpMLineIndex: event.candidate.sdpMLineIndex,
                    sdpMid: event.candidate.sdpMid,
                    usernameFragment: event.candidate.usernameFragment,
                };
                wsRef.current.send(JSON.stringify(msg));
                console.log(`[${cameraId}] 📤 Sent ICE candidate`);
            }
        };

        pc.ontrack = (event) => {
            if (!isMountedRef.current) return;
            console.log(`[${cameraId}] 🎥 Got video track`);
            retryAttemptRef.current = 0; // 👈 успех — обнуляем счётчик, следующий сбой начнёт с 2с
            if (videoRef.current) {
                videoRef.current.srcObject = event.streams[0];
                setStatus('connected');
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`[${cameraId}] ICE state:`, pc.iceConnectionState);
            if (!isMountedRef.current) return;
            const s = pc.iceConnectionState;
            if (s === 'disconnected') {
                //setStatus('error');
            }
            else if (s === 'failed' || s === 'closed') {
                //scheduleReconnect(`ice=${s}`);
            }
        };

        pc.onconnectionstatechange = () => {
            console.log(`[${cameraId}] Connection state:`, pc.connectionState);
            if (!isMountedRef.current) return;
            const s = pc.connectionState;
            if (s === 'new') {
                setStatus('connecting');
                console.log(`[${cameraId}] New webRTC connection pending!`);
                // Запускаем таймер, если не удалось подключиться за 20 секунд
                if (connectionTimeoutRef.current) {
                    clearTimeout(connectionTimeoutRef.current);
                }

                connectionTimeoutRef.current = window.setTimeout(() => {
                    console.warn(`[${cameraId}] ⏱️ Connection timeout (20s)`);

                    if (!isMountedRef.current) return;

                    setStatus('error');
                    setErrorMsg('Таймаут подключения');

                    closeWebRTC();
                    sendCloseRequest();
                    sendCreateRequest();
                }, 20000);
            }
            if (s === 'connected') {
                if (connectionTimeoutRef.current) {
                    clearTimeout(connectionTimeoutRef.current);
                    connectionTimeoutRef.current = null;
                }
                setStatus('connected');
                console.log(`[${cameraId}] Connection successfully suggested!`);
            }
            else if (s === 'connecting') {
                setStatus('connecting');
                console.log(`[${cameraId}] WebRTC turned to connecting state!`);
            }
            else if (s === 'disconnected') {
                setStatus('error');
                setErrorMsg('Обрыв соединения. Ожидание переподключения');
                console.warn(`[${cameraId}] WebRTC turned to disconnected state!`);
            }
            else if (s === 'failed' || s === 'closed') {
                console.warn(`[${cameraId}] WebRTC closed, try to restart connection!`);
                setStatus('error');
                setErrorMsg('Соединение оборвано, ожидание нового...');
                closeWebRTC();
                sendCloseRequest();
                sendCreateRequest();
            }
        };
    };

    const handleOffer = async (sdp: string) => {
        if (!isMountedRef.current || !pcRef.current) return;

        console.log(`[${cameraId}] 📩 Processing SDP offer`);

        try {
            const offer = {
                type: 'offer' as RTCSdpType,
                sdp: sdp
            };

            await pcRef.current.setRemoteDescription(new RTCSessionDescription(offer));
            console.log(`[${cameraId}] ✅ Remote description set`);

            const answer = await pcRef.current.createAnswer();
            await pcRef.current.setLocalDescription(answer);

            if (isMountedRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
                const response = {
                    type: 'answer',
                    client_id: clientIdRef.current,
                    camera: cameraId,
                    description: 'SDP answer from client',
                    sdp: answer.sdp
                };
                wsRef.current.send(JSON.stringify(response));
                console.log(`[${cameraId}] 📤 Sent SDP answer`);
            }

        } catch (err) {
            console.error(`[${cameraId}] ❌ SDP Error:`, err);
            if (isMountedRef.current) {
                setStatus('error');
                setErrorMsg('Ошибка обработки SDP');
                onError?.(` error: ${err}`);
            }
        }
    };

    const handleIceCandidate = async (msg: any) => {
        if (!isMountedRef.current || !pcRef.current) return;

        try {
            const iceCandidateInit: RTCIceCandidateInit = {
                candidate: msg.candidate,
                sdpMLineIndex: msg.sdpMLineIndex,
            };

            if (msg.sdpMid !== undefined) {
                iceCandidateInit.sdpMid = msg.sdpMid;
            }

            await pcRef.current.addIceCandidate(new RTCIceCandidate(iceCandidateInit));
            console.log(`[${cameraId}] ✅ Added ICE candidate`);
        } catch (err) {
            console.error(`[${cameraId}] ❌ ICE error:`, err);
        }
    };

    const handleFullscreen = () => {
        if (videoRef.current) {
            videoRef.current.requestFullscreen();
        }
    };

    return (
        <Paper
            sx={{
                position: 'relative',
                bgcolor: 'black',
                overflow: 'hidden',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
            }}
        >
            {
                <Box
                    sx={{
                        position: 'absolute',
                        top: 12,
                        left: 20,
                        zIndex: 10,
                        bgcolor: 'rgba(0,0,0,0.65)',
                        color: 'white',
                        padding: '4px 10px',
                        borderRadius: 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.5,
                        backdropFilter: 'blur(4px)',
                    }}
                >
                    <Typography variant="caption" sx={{ fontSize: 12, lineHeight: 1 }}>
                        {cameraName || cameraId}
                    </Typography>

                    {/*
                    {status === 'connected' && (
                        <IconButton
                            size="small"
                            onClick={handleFullscreen}
                            sx={{
                                color: 'white',
                                p: 0.2,
                                ml: 0.5,
                            }}
                        >
                            <Fullscreen fontSize="small" />
                        </IconButton>
                    )}
                    */}
                </Box>
            }

            <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    display: status === 'connected' ? 'block' : 'none'
                }}
            />

            {status === 'connecting' && (
                <Box
                    display="flex"
                    flexDirection="column"
                    alignItems="center"
                    justifyContent="center"
                    sx={{ flexGrow: 1, color: 'white' }}
                >
                    <CircularProgress size={40} sx={{ mb: 2 }} />
                    <Typography>Подключение...</Typography>
                </Box>
            )}

            {status === 'error' && (
                <Box
                    display="flex"
                    flexDirection="column"
                    alignItems="center"
                    justifyContent="center"
                    sx={{ flexGrow: 1, color: 'white' }}
                >
                    <ErrorIcon sx={{ fontSize: 48, mb: 2, color: 'error.main' }} />
                    <Typography>{errorMsg}</Typography>
                </Box>
            )}
        </Paper>
    );
};

export default WebRTCPlayer;