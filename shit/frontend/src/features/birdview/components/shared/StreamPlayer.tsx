import { useEffect, useState } from 'react';
import { useWebRTCPlayer } from '../../../../components/webrtc/useWebRTCPlayer';
import type { PlayerStats, PlayerStatus } from '../../../../components/webrtc/useWebRTCPlayer';
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

interface StreamPlayerProps {
    cameraId: string;
    signalingUrl: string;
    collectStats?: boolean;
    onState?: (state: StreamPlayerState) => void;
}

export function StreamPlayer({ cameraId, signalingUrl, collectStats = true, onState }: StreamPlayerProps) {
    const { status, errorInfo, attempt, videoRef, stats } = useWebRTCPlayer({
        cameraId,
        signalingUrl,
        collectStats,
    });

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
