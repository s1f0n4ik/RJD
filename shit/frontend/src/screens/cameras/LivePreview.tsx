import type { CSSProperties, ReactNode } from 'react';
import { useWebRTCPlayer } from '../../components/webrtc/useWebRTCPlayer';

interface LivePreviewProps {
    cameraId: string;
    /** Ключ потока камеры; пусто — сервер сам возьмёт первый смотрибельный */
    stream?: string;
    signalingUrl: string;
    /** Подпись поверх кадра — например номер канала */
    caption?: ReactNode;
    style?: CSSProperties;
}

/** Предпросмотр потока: видео на всю плитку, без панелей и наложений. */
export function LivePreview({ cameraId, stream, signalingUrl, caption, style }: LivePreviewProps) {
    const { status, errorMsg, videoRef } = useWebRTCPlayer({ cameraId, stream, signalingUrl });

    return (
        <div className="cam-preview" style={style}>
            <video ref={videoRef} autoPlay muted playsInline />
            {status !== 'streaming' && (
                <div className="state">
                    {status === 'error'
                        ? (errorMsg || 'Поток не открылся')
                        : <><span className="spin" />подключение…</>}
                </div>
            )}
            {caption && status === 'streaming' && <span className="cap">{caption}</span>}
        </div>
    );
}
