import type { ReactNode } from 'react';
import { Icon } from '../../app/Icons';
import { Switch } from '../../app/Modal';
import type { PlayerStats } from '../../components/webrtc/useWebRTCPlayer';
import { Cell, NumCell, PurposePicker } from './CameraFields';
import { PurposeChips } from './StreamsTable';
import {
    PRODUCTION_NAMES,
    cameraStatus,
    dotClass,
    streamNumber,
    streamStatus,
    streamsOf,
    togglePurpose,
    type Camera,
    type StreamForm,
    type StreamInfo,
} from './model';

const num = (value: number | null | undefined, digits: number) =>
    (value === null || value === undefined ? '—' : value.toFixed(digits).replace('.', ','));

// Время, с которого поток не поднимается: since приходит в миллисекундах
const sinceLabel = (since: number) =>
    new Date(since).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

// Полоса состояния под шапкой панели
export function CameraSummary({ camera }: { camera: Camera }) {
    const status = cameraStatus(camera);
    const streams = streamsOf(camera);
    const live = streams.filter(s => s.live).length;

    return (
        <div className={`cd-sum is-${status.tone}`}>
            <span className={`st st-${status.tone}`} data-tip={status.tip}>
                <span className={`dot ${dotClass(status.tone)}`} />
                {status.label}
            </span>
            <span className="cd-why">{camera.offline ? 'данные из кэша' : status.detail ?? ''}</span>
            <span className="cd-n"><b>{camera.offline ? '—' : live}</b> из {streams.length} потоков</span>
        </div>
    );
}

const withUnit = (value: string, unit: string) => (value === '—' ? value : `${value} ${unit}`);

// Показатели плеера просматриваемого потока: таблица на всю ширину
export function PreviewStats({ stats }: { stats: PlayerStats | null }) {
    const cells: Array<[string, string]> = [
        ['Кадров/с', num(stats?.fps, 0)],
        ['Мбит/с', num(stats?.mbits, 1)],
        ['Задержка', withUnit(num(stats?.rttMs, 0), 'мс')],
        ['Потери', withUnit(num(stats?.lossPct, 1), '%')],
    ];

    return (
        <div className="cd-pst">
            {cells.map(([cap, value]) => (
                <div key={cap}>
                    <span className="k">{cap}</span>
                    <span className={`v${value === '—' ? ' dim' : ''}`}>{value}</span>
                </div>
            ))}
        </div>
    );
}

interface ModuleHeadProps {
    icon: 'cam' | 'layers';
    title: string;
    count?: number;
    camera?: boolean;
    children?: ReactNode;
}

// Шапка модуля панели: «Камера» и «Потоки» — два отдельных блока
export function ModuleHead({ icon, title, count, camera, children }: ModuleHeadProps) {
    return (
        <div className="cd-sec-h">
            <span className={`cd-mod${camera ? ' cd-mod--cam' : ''}`}><Icon name={icon} size={14} /></span>
            <span className="t">{title}</span>
            {count !== undefined && <span className="cam-count">{count}</span>}
            {children}
        </div>
    );
}

// Сведения о камере для просмотра
export function CameraInfo({ camera }: { camera: Camera }) {
    return (
        <div className="cd-kv">
            <div>
                <span className="k">Устройство</span>
                <span className={`v${camera.offline ? ' st-err' : ''}`}>{camera.device_name ?? '—'}</span>
            </div>
            <div><span className="k">Производитель</span><span className="v">{PRODUCTION_NAMES[camera.production] ?? '—'}</span></div>
            <div><span className="k">IP-адрес</span><span className="v m">{camera.ip_adress}</span></div>
            <div><span className="k">Порт RTSP</span><span className="v m">{camera.port}</span></div>
            <div><span className="k">Логин</span><span className="v m">{camera.user || '—'}</span></div>
            <div><span className="k">Пароль</span><span className="v m">••••••••</span></div>
            <div className="span2"><span className="k">Описание</span><span className="v">{camera.description || '—'}</span></div>
        </div>
    );
}

// Блоки есть только у назначений, которым нужно что-то вводить
function roleBlocks(stream: StreamForm, onPatch: (patch: Partial<StreamForm>) => void): ReactNode[] {
    const blocks: ReactNode[] = [];

    if (stream.purposes.includes('record')) {
        blocks.push(
            <div key="record" className="cd-role cd-role--record">
                <span className="purp purp--record">Запись</span>
                <div className="frow">
                    <Cell cap="Путь записи">
                        <input
                            className="inp cd-mono"
                            value={stream.record_path}
                            onChange={e => onPatch({ record_path: e.target.value })}
                        />
                    </Cell>
                    <NumCell cap="Длина сегмента, с" value={stream.segment} onValue={n => onPatch({ segment: n })} />
                </div>
            </div>,
        );
    }

    return blocks;
}

interface StreamCardProps {
    camera: Camera;
    streamKey: string;
    info?: StreamInfo;
    // Поток в форме правки; пусто — карточка только для просмотра
    form?: StreamForm;
    modules: string[];
    onSelect: (key: string) => void;
    onPatch: (key: string, patch: Partial<StreamForm>) => void;
    onRemove: (key: string) => void;
}

function StreamCard({ camera, streamKey, info, form, modules, onSelect, onPatch, onRemove }: StreamCardProps) {
    const raw = camera.streams[streamKey];
    const number = info?.number ?? streamNumber(streamKey);
    const substream = form?.substream ?? info?.substream ?? raw?.substream ?? 0;
    const hasFrame = !!info && info.live && info.width > 0;
    const status = info
        ? streamStatus(info, !!camera.offline)
        : { label: 'новый', tone: 'info' as const, tip: undefined };
    const purposes = form?.purposes ?? info?.purposes ?? [];
    const viewable = purposes.includes('view');

    return (
        <div className="cd-sc">
            <div
                className={`cd-sc-h${viewable ? ' is-pick' : ''}`}
                onClick={() => viewable && onSelect(streamKey)}
            >
                <span className="cd-plate"><b>{number}</b><i>суб {substream}</i></span>
                <span className="who">
                    <b>{hasFrame && info ? `${info.width}×${info.height}` : `Поток ${number}`}</b>
                    <span className="sub">{info?.codec ? info.codec.toUpperCase() : '—'} · субпоток {substream}</span>
                </span>
                <span className={`st st-${status.tone}`} data-tip={status.tip}>
                    <span className={`dot ${dotClass(status.tone)}`} />
                    {status.label}
                </span>
            </div>

            {form ? (
                <StreamEdit
                    stream={form}
                    modules={modules}
                    onPatch={patch => onPatch(streamKey, patch)}
                    onRemove={() => onRemove(streamKey)}
                />
            ) : info && raw && (
                <>
                    <div className="cd-sc-p"><PurposeChips purposes={info.purposes} /></div>
                    <div className="cd-sc-kv">
                        <div><span className="k">Кадров/с</span><span className={`v${hasFrame ? '' : ' dim'}`}>{hasFrame && info.fps ? Math.round(info.fps) : '—'}</span></div>
                        <div><span className="k">Задержка</span><span className="v">{raw.latency} мс</span></div>
                        <div><span className="k">Транспорт</span><span className="v">{raw.use_udp ? 'UDP' : 'TCP'}</span></div>
                        <div><span className="k">Реконнект</span><span className="v">{raw.reconnect} с</span></div>
                    </div>
                    {info.purposes.includes('record') && (
                        <div className="cd-sc-rec">
                            <span>Путь <b>{raw.record_path || '—'}</b></span>
                            <span>Сегмент <b>{Math.round(raw.segment / 60)} мин</b></span>
                        </div>
                    )}
                    <div className="cd-sc-link" data-tip={info.rtsp}>{info.rtsp || '—'}</div>
                    {info.fault && !camera.offline && (
                        <div className="cd-fault">
                            <Icon name="warn" size={14} />
                            <span><b>{info.fault.label}</b></span>
                            {raw.error && (
                                <span className="tm">с {sinceLabel(raw.error.since)} · попыток {raw.error.attempts}</span>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

interface StreamEditProps {
    stream: StreamForm;
    modules: string[];
    onPatch: (patch: Partial<StreamForm>) => void;
    onRemove: () => void;
}

// Правка потока: назначения, общие поля, поля включённых назначений
function StreamEdit({ stream, modules, onPatch, onRemove }: StreamEditProps) {
    const blocks = roleBlocks(stream, onPatch);

    return (
        <div className="cd-edit">
            <div className="cd-grp">
                <span className="eyebrow">Назначения</span>
                <PurposePicker
                    purposes={stream.purposes}
                    modules={modules}
                    compact
                    onToggle={purpose => onPatch(togglePurpose(stream, purpose))}
                />
            </div>

            <div className="cd-grp">
                <span className="eyebrow">Общие</span>
                <div className="frow frow--3">
                    {/* Номер выбран из опроса камеры, руками не правится */}
                    <div className="fcell">
                        <span className="fcap">Субпоток</span>
                        <span className="fstatic">{stream.substream}</span>
                    </div>
                    <NumCell cap="Задержка, мс" value={stream.latency} onValue={n => onPatch({ latency: n })} />
                    <NumCell cap="Реконнект, с" value={stream.reconnect} onValue={n => onPatch({ reconnect: n })} />
                </div>
                <label className="fsw">
                    <Switch on={stream.use_udp} onToggle={v => onPatch({ use_udp: v })}>
                        Передавать по UDP
                    </Switch>
                </label>
            </div>

            {blocks.length > 0 && (
                <div className="cd-grp">
                    <span className="eyebrow">Поля назначений</span>
                    <div className="cd-roles">{blocks}</div>
                </div>
            )}

            <div>
                <button type="button" className="btn btn--sm btn--err" onClick={onRemove}>Удалить поток</button>
            </div>
        </div>
    );
}

interface StreamCardsProps {
    camera: Camera;
    infos: StreamInfo[];
    // Потоки формы в режиме правки; null — просмотр
    form: StreamForm[] | null;
    modules: string[];
    onSelect: (key: string) => void;
    onPatch: (key: string, patch: Partial<StreamForm>) => void;
    onRemove: (key: string) => void;
}

export function StreamCards({ camera, infos, form, modules, onSelect, onPatch, onRemove }: StreamCardsProps) {
    const keys = form ? form.map(s => s.key) : infos.map(s => s.key);

    if (keys.length === 0) {
        return <p className="hint" style={{ margin: 0 }}>У камеры не настроено ни одного потока.</p>;
    }

    return (
        <>
            {keys.map(key => (
                <StreamCard
                    key={key}
                    camera={camera}
                    streamKey={key}
                    info={infos.find(s => s.key === key)}
                    form={form?.find(s => s.key === key)}
                    modules={modules}
                    onSelect={onSelect}
                    onPatch={onPatch}
                    onRemove={onRemove}
                />
            ))}
        </>
    );
}
