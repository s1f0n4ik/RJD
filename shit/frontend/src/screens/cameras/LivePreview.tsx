import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { useWebRTCPlayer, type PlayerStats } from '../../components/webrtc/useWebRTCPlayer';

interface LivePreviewProps {
    cameraId: string;
    /** Ключ потока камеры; пусто — сервер сам возьмёт первый смотрибельный */
    stream?: string;
    signalingUrl: string;
    /** Подпись поверх кадра — например номер канала */
    caption?: ReactNode;
    style?: CSSProperties;
    /** Показатели сессии раз в секунду; без обработчика сбор выключен */
    onStats?: (stats: PlayerStats | null) => void;
}

/** Предпросмотр потока: видео на всю плитку, без панелей и наложений. */
export function LivePreview({ cameraId, stream, signalingUrl, caption, style, onStats }: LivePreviewProps) {
    const { status, errorInfo, videoRef, stats } = useWebRTCPlayer({ cameraId, stream, signalingUrl, collectStats: !!onStats });

    useEffect(() => { onStats?.(stats); }, [stats, onStats]);

    return (
        <div className="cam-preview" style={style}>
            <video ref={videoRef} autoPlay muted playsInline />
            {status !== 'streaming' && (
                <div className="state">
                    <span className="spin" />
                    {status === 'connecting' || status === 'signaling' ? 'подключение…' : 'переподключение…'}
                    {errorInfo && (
                        <span className="cell-state-why">
                            {errorInfo.text}
                            {errorInfo.code !== null && <i className="cell-code">{errorInfo.code}</i>}
                        </span>
                    )}
                </div>
            )}
            {caption && status === 'streaming' && <span className="cap">{caption}</span>}
        </div>
    );
}
