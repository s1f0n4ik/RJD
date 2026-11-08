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
            <div className="sx">
                <table className="stab">
                    <thead>
                        <tr>
                            <th className="s-n">Поток</th>
                            <th className="s-sub">Субпоток</th>
                            <th className="s-res">Разрешение</th>
                            <th className="s-fps">Кадров/с</th>
                            <th className="s-cod">Кодек</th>
                            {/* Запас ширины у назначений: состояние и ссылка держатся у правого края */}
                            <th className="s-purp">Назначения</th>
                            <th className="s-st">Состояние</th>
                            <th className="s-link">Ссылка на поток</th>
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
                                    <td className="s-n"><span className="chnum">{stream.number}</span></td>
                                    <td className="s-sub"><span className="chnum">{stream.substream}</span></td>
                                    <td className="s-res num">{hasFrame ? `${stream.width}×${stream.height}` : '—'}</td>
                                    <td className="s-fps num">{hasFrame && stream.fps ? Math.round(stream.fps) : '—'}</td>
                                    <td className="s-cod">{stream.codec ? stream.codec.toUpperCase() : '—'}</td>
                                    <td className="s-purp"><PurposeChips purposes={stream.purposes} /></td>
                                    <td className="s-st">
                                        <span className={`st st-${status.tone}`} data-tip={status.tip}>
                                            <span className={`dot ${status.tone === 'ok' ? 'ok' : status.tone === 'err' ? 'err' : ''}`} />
                                            {status.label}
                                        </span>
                                    </td>
                                    <td className="s-link rtsp" data-tip={stream.rtsp}>{stream.rtsp || '—'}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
