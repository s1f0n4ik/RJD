import { PURPOSE_NAMES, PURPOSE_ORDER, streamStatus, type Camera, type StreamInfo } from './model';
import type { StreamPurpose } from '../../types';

interface StreamsTableProps {
    camera: Camera;
    streams: StreamInfo[];
    selected: string;
    onSelect: (key: string) => void;
}

/** Назначения потока — цветными плашками, порядок всегда один. */
export function PurposeChips({ purposes }: { purposes: StreamPurpose[] }) {
    const shown = PURPOSE_ORDER.filter(p => purposes.includes(p));
    if (shown.length === 0) return <span className="st-dim">—</span>;

    return (
        <span className="purps">
            {shown.map(purpose => (
                <span key={purpose} className={`purp purp--${purpose}`}>{PURPOSE_NAMES[purpose]}</span>
            ))}
        </span>
    );
}

/** Потоки выбранной камеры — подтаблицей прямо под её строкой. */
export function StreamsTable({ camera, streams, selected, onSelect }: StreamsTableProps) {
    if (streams.length === 0) {
        return (
            <div className="streams">
                <p className="hint" style={{ margin: 0 }}>У камеры не настроено ни одного потока.</p>
            </div>
        );
    }

    return (
        <div className="streams">
            <table className="stab">
                <thead>
                    <tr>
                        <th style={{ width: 66 }}>Поток</th>
                        <th style={{ width: 84 }}>Субпоток</th>
                        <th style={{ width: 112 }}>Разрешение</th>
                        <th style={{ width: 70 }}>Кадров/с</th>
                        <th style={{ width: 74 }}>Кодек</th>
                        <th style={{ width: 210 }}>Назначения</th>
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
                                <td><span className="chnum">{stream.number}</span></td>
                                <td><span className="chnum">{stream.substream}</span></td>
                                <td className="num">{hasFrame ? `${stream.width}×${stream.height}` : '—'}</td>
                                <td className="num">{hasFrame && stream.fps ? Math.round(stream.fps) : '—'}</td>
                                <td>{stream.codec ? stream.codec.toUpperCase() : '—'}</td>
                                <td><PurposeChips purposes={stream.purposes} /></td>
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
