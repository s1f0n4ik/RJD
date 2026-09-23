import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useWebRTCPlayer } from '../../components/webrtc/useWebRTCPlayer';

interface VideoBoxProps {
    cameraId: string;
    stream?: string;
    signalingUrl: string;
    /** Пропорция коробки; видео растягивается в неё, поэтому доли кадра совпадают с долями коробки */
    aspect: number;
    enabled?: boolean;
    /** Слой разметки поверх видео; получает размер коробки в пикселях */
    children?: (size: { w: number; h: number }) => ReactNode;
}

/** Видео, вписанное в сцену с заданной пропорцией, и слой разметки поверх */
export function VideoBox({ cameraId, stream, signalingUrl, aspect, enabled = true, children }: VideoBoxProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState<{ w: number; h: number } | null>(null);
    const { status, errorInfo, videoRef } = useWebRTCPlayer({ cameraId, stream, signalingUrl, enabled });

    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const fit = () => {
            const W = host.clientWidth, H = host.clientHeight;
            if (!W || !H || !aspect) return;
            const w = Math.min(W, H * aspect);
            setSize({ w: Math.floor(w), h: Math.floor(w / aspect) });
        };
        fit();
        const ro = new ResizeObserver(fit);
        ro.observe(host);
        return () => ro.disconnect();
    }, [aspect]);

    return (
        <div className="vbox-host" ref={hostRef}>
            {size && (
                <div className="vbox" style={{ width: size.w, height: size.h }}>
                    <video ref={videoRef} autoPlay muted playsInline />
                    {status !== 'streaming' && (
                        <div className="vbox-state">
                            <span className="spin" />
                            {status === 'connecting' || status === 'signaling' ? 'подключение…' : 'переподключение…'}
                            {errorInfo && <span className="why">{errorInfo.text}{errorInfo.code !== null && <i> · {errorInfo.code}</i>}</span>}
                        </div>
                    )}
                    {children?.(size)}
                </div>
            )}
        </div>
    );
}
