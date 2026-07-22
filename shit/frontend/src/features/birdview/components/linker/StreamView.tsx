import { useState } from 'react';
import WebRTCPlayer from '../../../../components/WebRTCPlayer';
import type { PlayerStatusInfo } from '../../../../components/WebRTCPlayer';
import { wsUrl } from '../../constants';

/**
 * Просмотр собранной панорамы. Порт linker-stream.js.
 *
 * Кадром владеет WebRTCPlayer целиком: свой overlay с лоадером не рисуем,
 * индикация подключения — та, что внутри плеера. Наружу остались только два
 * индикатора в шапке, их кормит onStatusChange.
 */

interface StreamViewProps {
    streamId: string;
    onStop: () => void;
}

const INITIAL: PlayerStatusInfo = { status: 'connecting', ice: '—', conn: '—' };

export function StreamView({ streamId, onStop }: StreamViewProps) {
    const [info, setInfo] = useState<PlayerStatusInfo>(INITIAL);

    // Смена ключа пересоздаёт плеер: новый WS, новый PeerConnection и сброшенный
    // счётчик попыток — то же, что делал closeWebRTC + connect в no-react.
    const [reconnectToken, setReconnectToken] = useState(0);

    const handleReconnect = () => {
        setInfo(INITIAL);
        setReconnectToken(t => t + 1);
    };

    let connClass = '';
    if (info.conn === 'connected') connClass = 'connected';
    else if (info.conn === 'failed' || info.conn === 'disconnected') connClass = 'failed';

    return (
        <div className="linker-stream">
            <div className="linker-stream-header">
                <div className="linker-stream-header-left">
                    <span className="linker-stream-title">BIRDVIEW — Поток</span>
                    <div className={`linker-stream-status ${connClass}`}>{info.conn}</div>
                    <div className="linker-stream-status">ICE: {info.ice}</div>
                </div>

                <div className="linker-stream-actions">
                    <button className="btn btn-secondary" onClick={handleReconnect}>
                        ↻ Переподключить
                    </button>
                    <button className="btn btn-secondary" onClick={onStop}>
                        ⏹ Завершить
                    </button>
                </div>
            </div>

            <div className="linker-stream-viewport">
                <WebRTCPlayer
                    key={`${streamId}-${reconnectToken}`}
                    cameraId={streamId}
                    signalingUrl={wsUrl(`/signaling/client/${streamId}`)}
                    onStatusChange={setInfo}
                />
            </div>
        </div>
    );
}
