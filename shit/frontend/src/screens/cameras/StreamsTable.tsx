import { streamStatus, type Camera, type StreamInfo, type StreamKey } from './model';

interface StreamsTableProps {
    camera: Camera;
    streams: StreamInfo[];
    selected: StreamKey;
    onSelect: (key: StreamKey) => void;
}

/** Потоки выбранной камеры — подтаблицей прямо под её строкой. */
export function StreamsTable({ camera, streams, selected, onSelect }: StreamsTableProps) {
    if (streams.length === 0) {
        return (
            <div className="streams">
                <p className="hint" style={{ margin: 0 }}>Камера не отдала ни одного потока.</p>
            </div>
        );
    }

    return (
        <div className="streams">
            <table className="stab">
                <thead>
                    <tr>
                        <th style={{ width: 74 }}>Канал</th>
                        <th style={{ width: 116 }}>Разрешение</th>
                        <th style={{ width: 74 }}>Кадров/с</th>
                        <th style={{ width: 78 }}>Кодек</th>
                        <th style={{ width: 96 }}>Транспорт</th>
                        <th style={{ width: 84 }}>Буфер</th>
                        <th style={{ width: 104 }}>Запись</th>
                        <th style={{ width: 118 }}>Состояние</th>
                        <th>Ссылка на поток</th>
                    </tr>
                </thead>
                <tbody>
                    {streams.map(stream => {
                        const status = streamStatus(stream, !!camera.offline);
                        const hasFrame = stream.live && stream.width > 0;
                        return (
                            <tr
                                key={stream.key}
                                className={stream.key === selected ? 'is-on' : ''}
                                onClick={e => { e.stopPropagation(); onSelect(stream.key); }}
                            >
                                <td><span className="chnum">{stream.channel}</span></td>
                                <td className="num">{hasFrame ? `${stream.width}×${stream.height}` : '—'}</td>
                                <td className="num">{hasFrame && stream.fps ? Math.round(stream.fps) : '—'}</td>
                                <td>{stream.codec ? stream.codec.toUpperCase() : '—'}</td>
                                <td>{stream.useUdp ? 'UDP' : 'TCP'}</td>
                                <td className="num">{stream.latency} мс</td>
                                <td className={stream.toRecord ? 'st-ok' : ''}>
                                    {stream.toRecord ? 'в архив' : '—'}
                                </td>
                                <td>
                                    <span className={`st st-${status.tone}`}>
                                        <span className={`dot ${status.tone === 'ok' ? 'ok' : status.tone === 'err' ? 'err' : ''}`} />
                                        {status.label}
                                    </span>
                                </td>
                                <td className="rtsp" title={stream.rtsp}>{stream.rtsp || '—'}</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
