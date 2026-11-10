import { Icon } from '../app/Icons';
import { PurposeChips } from '../screens/cameras/StreamsTable';
import { cameraStatus, dotClass, rtpSummary, streamStatus, streamsOf, type Camera, type StreamInfo } from '../screens/cameras/model';
import '../screens/cameras/cameras.css';

// Время, с которого поток не поднимается: since приходит в миллисекундах
const sinceLabel = (since: number) =>
    new Date(since).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

function StreamRow({ camera, stream }: { camera: Camera; stream: StreamInfo }) {
    const raw = camera.streams[stream.key];
    const status = streamStatus(stream, !!camera.offline);
    const hasFrame = stream.live && stream.width > 0;

    return (
        <div className="cd-sc">
            <div className="cd-sc-h">
                <span className="cd-plate"><b>{stream.number}</b><i>суб {stream.substream}</i></span>
                <span className="who">
                    <b>{hasFrame ? `${stream.width}×${stream.height}` : `Поток ${stream.number}`}</b>
                    <span className="sub">
                        {stream.codec ? stream.codec.toUpperCase() : '—'}
                        {hasFrame && stream.fps ? ` · ${Math.round(stream.fps)} к/с` : ''}
                        {` · ${stream.useUdp ? 'UDP' : 'TCP'}`}
                    </span>
                </span>
                <span className={`st st-${status.tone}`}>
                    <span className={`dot ${dotClass(status.tone)}`} />
                    {status.label}
                </span>
            </div>
            <div className="cd-sc-p"><PurposeChips purposes={stream.purposes} /></div>
            {stream.purposes.includes('record') && raw && (
                <div className="cd-sc-rec">
                    <span>Путь <b>{raw.record_path || '—'}</b></span>
                    <span>Сегмент <b>{Math.round(raw.segment / 60)} мин</b></span>
                </div>
            )}
            {stream.purposes.includes('rtp') && raw?.rtp && (
                <div className="cd-sc-rec">
                    <span>Приёмник <b>{raw.rtp.host}:{raw.rtp.port}</b></span>
                    <span><b>{rtpSummary(raw.rtp)}</b></span>
                </div>
            )}
            {stream.fault && !camera.offline && (
                <div className="cd-fault">
                    <Icon name="warn" size={14} />
                    <span><b>{stream.fault.label}</b></span>
                    {raw?.error && <span className="tm">с {sinceLabel(raw.error.since)} · попыток {raw.error.attempts}</span>}
                </div>
            )}
        </div>
    );
}

// Состояние камеры и её потоки под строкой списка
export function CameraDetail({ camera, closing }: { camera: Camera; closing: boolean }) {
    const status = cameraStatus(camera);

    return (
        <div className={`m-cd-wrap${closing ? ' is-closing' : ''}`}>
            <div className="m-cd">
                <div className="m-cd-in">
                    <div className="m-cd-top">
                        <span className={`st st-${status.tone}`}>
                            <span className={`dot ${dotClass(status.tone)}`} />
                            {status.label}
                        </span>
                        <span className="mono">{camera.ip_adress}</span>
                        <span>{camera.device_name ?? '—'}</span>
                    </div>
                    {status.detail && <div className="m-cd-top"><span>{status.detail}</span></div>}
                    {camera.offline && <div className="m-cd-top"><span>Устройство не отвечает — данные из кэша.</span></div>}
                    {streamsOf(camera).map(stream => <StreamRow key={stream.key} camera={camera} stream={stream} />)}
                </div>
            </div>
        </div>
    );
}
