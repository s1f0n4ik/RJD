import { useEffect, useState } from 'react';
import { useWebRTCPlayer } from '../../../../components/webrtc/useWebRTCPlayer';
import type { PlayerMessage, PlayerStats, PlayerStatus } from '../../../../components/webrtc/useWebRTCPlayer';
import { useOrbitGesture } from '../../../../components/webrtc/useOrbitGesture';
import type { ErrorInfo } from '../../../../components/webrtc/error-codes';

// Плеер раздела «Система 360» поверх общего хука сигналинга

export interface StreamPlayerState {
    status: PlayerStatus;
    /** Номер текущей попытки подключения; 0 — идёт первая */
    attempt: number;
    stats: PlayerStats | null;
    error: ErrorInfo | null;
    /** Размер кадра, который реально пришёл; null — метаданные ещё не готовы */
    width: number | null;
    height: number | null;
}

/** Отправка своего сообщения в сигналинг; false — WS закрыт */
export type StreamPlayerSend = (data: Record<string, unknown>) => boolean;

interface StreamPlayerProps {
    cameraId: string;
    signalingUrl: string;
    collectStats?: boolean;
    onState?: (state: StreamPlayerState) => void;
    /** Сообщения, которые хук сам не обрабатывает — надстройкам раздела */
    onMessage?: (msg: PlayerMessage) => void;
    /** Сюда кладётся отправка, пока плеер смонтирован */
    sendRef?: React.MutableRefObject<StreamPlayerSend | null>;
    /** Слой жестов орбиты поверх кадра */
    gesture?: boolean;
}

export function StreamPlayer({
    cameraId,
    signalingUrl,
    collectStats = true,
    onState,
    onMessage,
    sendRef,
    gesture = false,
}: StreamPlayerProps) {
    const { status, errorInfo, attempt, videoRef, stats, send } = useWebRTCPlayer({
        cameraId,
        signalingUrl,
        collectStats,
        onMessage,
    });

    const orbit = useOrbitGesture({ videoRef, send, enabled: gesture });

    useEffect(() => {
        if (!sendRef) return;
        sendRef.current = send;
        return () => {
            sendRef.current = null;
        };
    }, [send, sendRef]);

    const [size, setSize] = useState<{ w: number; h: number } | null>(null);

    // Размер кадра берём с самого video: сигналинг его не сообщает
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const read = () => {
            const w = video.videoWidth;
            const h = video.videoHeight;
            if (!w || !h) return;
            setSize(prev => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
        };

        read();
        video.addEventListener('loadedmetadata', read);
        video.addEventListener('resize', read);
        return () => {
            video.removeEventListener('loadedmetadata', read);
            video.removeEventListener('resize', read);
        };
    }, [videoRef]);

    useEffect(() => {
        onState?.({
            status,
            attempt,
            stats,
            error: errorInfo,
            width: size?.w ?? null,
            height: size?.h ?? null,
        });
    }, [status, attempt, stats, errorInfo, size, onState]);

    return (
        <>
            <video ref={videoRef} autoPlay muted playsInline />

            {gesture && (
                <div
                    ref={orbit.layerRef}
                    className={`orbit-gest${orbit.dragging ? ' is-drag' : ''}`}
                    onPointerDown={orbit.onPointerDown}
                    onPointerMove={orbit.onPointerMove}
                    onPointerUp={orbit.onPointerUp}
                    onPointerCancel={orbit.onPointerUp}
                />
            )}

            {status !== 'streaming' && (
                <div className="empty">
                    <span className="spin" />
                    <b>{status === 'reconnecting' ? 'Переподключение' : 'Подключение'}</b>
                    {errorInfo && (
                        <span className="why">
                            {errorInfo.text}
                            {errorInfo.code !== null && <i>{errorInfo.code}</i>}
                        </span>
                    )}
                </div>
            )}
        </>
    );
}
