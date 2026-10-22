import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { navFor, useRole } from '../../app/role';
import { useSystem } from '../../app/SystemContext';
import { neuralSummaryOff, neuralSummaryParts, useGatewayStatus, useLastDetections, useLinkerStatus, useNeuralSummary } from './useHomeData';
import { useLayouts } from '../../hooks/Layouts';
import { detClass } from '../../features/neural/components/journal/DetectionRow';
import { fmtTime } from '../../features/neural/components/journal/format';
import { useCameraNames } from '../../features/neural/components/journal/useCameraNames';
import { useClassResolver } from '../../features/neural/components/journal/useClassResolver';
import { getRouting } from '../../services/devices';
import {
    deviceMetrics, formatBytes, formatPair, lastSeenTime, MODULE_LABEL, netParts, sinceLabel, uptimeLabel, type RoutingSlot,
} from '../devices/model';
import { disksLabel, usePools } from '../settings/pool';
import './home.css';
import { useFlash } from '../../app/motion';

// Статус 3 — пайплайн запущен; всё остальное для оператора означает «потока нет».
// Камера в работе, если работает хотя бы один её поток: их произвольное число
const isLive = (camera: { offline?: boolean; streams?: Record<string, { status?: number }> }) =>
    !camera.offline && Object.values(camera.streams ?? {}).some(s => s.status === 3);

const DISK_POLL_MS = 20_000;

// 1 камера · 2 камеры · 5 камер
const plural = (n: number, one: string, few: string, many: string) => {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
};

// Показатели карточки устройства и их короткие подписи
const METRIC_LABEL: Record<string, string> = { cpu: 'ЦП', mem: 'ОЗУ', temp: '°C', ping: 'Откл.' };

export function HomeScreen() {
    const role = useRole();
    const { cameras, devices } = useSystem();
    const { pools } = usePools(devices, DISK_POLL_MS);
    const { layouts } = useLayouts();
    const { items: detections, available: journalUp } = useLastDetections();
    const { resolve } = useClassResolver();
    const { cameraName } = useCameraNames();
    const gateway = useGatewayStatus();
    const linker = useLinkerStatus();
    const neural = useNeuralSummary();

    const routing = getRouting();
    const online = devices.filter(d => d.status === 'online');
    const liveCameras = cameras.filter(isLive).length;
    const deadCameras = cameras.length - liveCameras;
    const offlineDevices = devices.length - online.length;

    const layoutSummary = layouts.length === 0
        ? 'отображения не настроены'
        : `${layouts.length} ${plural(layouts.length, 'отображение', 'отображения', 'отображений')}`;

    const deviceSummary = devices.length === 0
        ? 'устройства не добавлены'
        : (
            <span className="seps">
                <span>{devices.length} {plural(devices.length, 'устройство', 'устройства', 'устройств')}</span>
                <span>{offlineDevices > 0 ? `${offlineDevices} не в сети` : 'все в сети'}</span>
            </span>
        );

    const linkerSummary = linker
        ? linker.running
            ? (
                <span className="seps">
                    <span>вывод в эфире</span>
                    <span>{linker.dualOutput ? 'оба вида' : linker.viewMode === 'surround' ? 'объём' : 'сверху'}</span>
                </span>
            )
            : 'вывод остановлен'
        : 'модуль не отвечает';
    const neuralSummary = <span className="seps">{neuralSummaryParts(neural).map(p => <span key={p}>{p}</span>)}</span>;
    const gatewaySummary = gateway
        ? (
            <span className="seps">
                <span>{gateway.modules} {plural(gateway.modules, 'модуль', 'модуля', 'модулей')}</span>
                <span>{gateway.connected} на связи</span>
            </span>
        )
        : 'шлюз не отвечает';

    const cameraSummary = cameras.length === 0
        ? 'камеры не добавлены'
        : (
            <span className="seps">
                <span>{cameras.length} {plural(cameras.length, 'камера', 'камеры', 'камер')}</span>
                <span>{deadCameras > 0 ? `${deadCameras} без потока` : 'все в работе'}</span>
            </span>
        );

    // Закрытие помнит состав офлайна: погаснет другое устройство — баннер вернётся
    const offlineNames = devices.filter(d => d.status !== 'online').map(d => d.name).join(', ');
    const [dismissed, setDismissed] = useState<string | null>(null);

    const flashCameras = useFlash<HTMLDivElement>(`${liveCameras}/${cameras.length}`);
    const flashDevices = useFlash<HTMLDivElement>(`${online.length}/${devices.length}`);
    const flashAttention = useFlash<HTMLDivElement>(deadCameras + offlineDevices, deadCameras + offlineDevices > 0 ? 'warn' : '');

    return (
        <section className="screen glow home">
            <div className="scroll">

                <div className="hero">
                    <div>
                        <h1>Общее состояние</h1>
                    </div>
                    <div className="hero-stats">
                        <div className="stat is-acc" ref={flashCameras}>
                            <b>{liveCameras}/{cameras.length}</b>
                            <span>камер в работе</span>
                        </div>
                        <div className="stat" ref={flashDevices}>
                            <b>{online.length}/{devices.length}</b>
                            <span>устройств в сети</span>
                        </div>
                        <div className={`stat${deadCameras + offlineDevices > 0 ? ' is-warn' : ''}`} ref={flashAttention}>
                            <b>{deadCameras + offlineDevices}</b>
                            <span>требуют внимания</span>
                        </div>
                    </div>
                </div>

                {offlineDevices > 0 && dismissed !== offlineNames && (
                    <div className="banner" style={{ marginBottom: 18 }}>
                        <Icon name="warn" size={16} />
                        {offlineNames} не отвечает. Камеры этого устройства показаны без потока.
                        <button
                            className="icon-btn"
                            style={{ marginLeft: 'auto', flexShrink: 0 }}
                            onClick={() => setDismissed(offlineNames)}
                            aria-label="Скрыть предупреждение"
                        >
                            <Icon name="x" size={13} />
                        </button>
                    </div>
                )}

                <div className="cols">
                    <div className="tiles">
                        {navFor(role).filter(item => item.to !== '/').map(item => (
                            <Link key={item.to} to={item.to} className={`tile${(item.to === '/krsps' && !gateway) || (item.to === '/surround' && !linker) || (item.to === '/neural' && neuralSummaryOff(neural)) ? ' is-off' : ''}`}>
                                <Icon name={item.icon} size={22} />
                                <b>{item.label}</b>
                                {item.desc && <span>{item.desc}</span>}
                                {item.to === '/cameras' && <span className="foot">{cameraSummary}</span>}
                                {item.to === '/live' && <span className="foot">{layoutSummary}</span>}
                                {item.to === '/devices' && <span className="foot">{deviceSummary}</span>}
                                {item.to === '/krsps' && <span className="foot">{gatewaySummary}</span>}
                                {item.to === '/surround' && <span className="foot">{linkerSummary}</span>}
                                {item.to === '/neural' && <span className="foot">{neuralSummary}</span>}
                            </Link>
                        ))}
                    </div>

                    <div className="stack">
                        <div className="card">
                            <div className="card-h">
                                <h3>Устройства</h3>
                                <span className="eyebrow">опрос 10 с</span>
                            </div>
                            <div className="card-b" style={{ paddingTop: 10, paddingBottom: 10 }}>
                                {devices.length === 0 && (
                                    <div className="card-none">
                                        <b>Устройства не добавлены</b>
                                        <span>
                                            Показывать нечего: ни одно вычислительное устройство
                                            не подключено. Добавьте его в разделе «Устройства».
                                        </span>
                                    </div>
                                )}
                                {devices.map(device => {
                                    const offline = device.status !== 'online';
                                    const net = netParts(device);
                                    const platform = device.telemetry?.platform;
                                    return (
                                        <div key={device.id} className={`home-dev${offline ? ' is-off' : ''}`}>
                                            <div className="home-dev-h">
                                                <span className={`dot ${offline ? 'err' : 'ok'}`} />
                                                <b>{device.name}</b>
                                                <span className="home-dev-ip">{device.ip}</span>
                                                {!offline && <span className="home-dev-r">{uptimeLabel(device.telemetry?.uptime_sec)}</span>}
                                            </div>
                                            {offline ? (
                                                <span className="home-dev-off seps">
                                                    <span>не в сети {sinceLabel(device.last_seen)}</span>
                                                    <span>последний ответ {lastSeenTime(device.last_seen)}</span>
                                                </span>
                                            ) : (
                                                <>
                                                    <div className="home-dev-m">
                                                        {deviceMetrics(device).filter(m => m.key in METRIC_LABEL).map(m => (
                                                            <div className="home-met" key={m.key}>
                                                                <span className="home-met-k">{METRIC_LABEL[m.key]}</span>
                                                                <span className="bar sm">
                                                                    <i className={m.tone === 'dim' ? '' : `is-${m.tone}`} style={{ width: `${m.pct}%` }} />
                                                                </span>
                                                                <span className={`home-met-v${m.tone === 'warn' || m.tone === 'err' ? ` is-${m.tone}` : ''}`}>{m.value}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                    <div className="home-dev-h">
                                                        <span className="home-dev-net">
                                                            {net ? (
                                                                <>
                                                                    <span className="net-rx">↓ {net.rx}</span> <span className="net-tx">↑ {net.tx}</span> Мбит/с
                                                                </>
                                                            ) : '—'}
                                                        </span>
                                                        {platform?.label && (
                                                            <span className="home-dev-r seps">
                                                                <span>{platform.label}</span>
                                                                {platform.npu_cores > 0 && <span>NPU {platform.npu_cores}</span>}
                                                            </span>
                                                        )}
                                                    </div>
                                                </>
                                            )}
                                            <div className="home-dev-tags">
                                                {device.modules.map(module => (
                                                    <span key={module} className={`tag is-acc${routing[module as RoutingSlot] === device.id ? '' : ' is-mute'}`}>
                                                        {MODULE_LABEL[module] ?? module}
                                                    </span>
                                                ))}
                                                {routing.cameras === device.id && <span className="tag is-acc">новые камеры</span>}
                                                {device.telemetry?.version && <span className="tag">{device.telemetry.version}</span>}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="card">
                            <div className="card-h"><h3>Накопители</h3></div>
                            <div className="card-b">
                                {devices.map(device => {
                                    const pool = pools[device.id];
                                    // undefined — ответа ещё не было, null — служба не ответила
                                    if (pool === undefined) return (
                                        <div className="disk" key={device.id}>
                                            <div className="disk-h"><b>{device.name}</b></div>
                                            <div className="disk-sub"><span className="skel" style={{ width: 110, height: 10, margin: '3px 0' }} /></div>
                                            <span className="skel" style={{ display: 'block', height: 8 }} />
                                            <div className="disk-lg">
                                                <span className="skel" style={{ width: '100%', height: 10, margin: '3px 0' }} />
                                                <span className="skel" style={{ width: '60%', height: 10, margin: '3px 0' }} />
                                            </div>
                                        </div>
                                    );
                                    if (!pool) return null;
                                    const s = pool.summary;
                                    const share = (bytes: number) =>
                                        s.total_bytes ? Math.max(0, bytes / s.total_bytes * 100) : 0;
                                    const other = Math.max(0, s.used_bytes - s.records_bytes - s.journal_bytes);
                                    // Состояние пула считает служба: кольцо — жёлтая, писать некуда — красная
                                    const tone = s.state === 'stuck' ? ' is-err' : s.state === 'ring' ? ' is-warn' : '';
                                    return (
                                        <div className={`disk${tone}`} key={device.id}>
                                            <div className="disk-h">
                                                <b>{device.name}</b>
                                                <span className="num">{formatPair(s.used_bytes, s.total_bytes)}</span>
                                            </div>
                                            <div className="disk-sub">
                                                <span className="seps">
                                                    <span>{disksLabel(s.disk_count)}</span>
                                                    {s.state !== 'stuck' && s.writing && <span className="is-w">пишется на «{s.writing}»</span>}
                                                    {s.state === 'ring' && <span className="is-st">удаляются старые</span>}
                                                    {s.state === 'stuck' && <span className="is-st">писать некуда</span>}
                                                </span>
                                            </div>
                                            <div className="bar bar--split">
                                                <i className="dk-ar" style={{ width: `${share(s.records_bytes)}%` }} />
                                                <i className="dk-jr" style={{ width: `${share(s.journal_bytes)}%` }} />
                                                <i className="dk-ot" style={{ width: `${share(other)}%` }} />
                                            </div>
                                            <div className="disk-lg">
                                                <span><i className="dk-ar" />Архив<span className="num">{formatBytes(s.records_bytes)}</span></span>
                                                {s.journal_reserve_bytes > 0 && (
                                                    <span>
                                                        <i className="dk-jr" />Журнал
                                                        <span className="num">
                                                            {formatBytes(s.journal_bytes)} из {formatBytes(s.journal_reserve_bytes)}
                                                        </span>
                                                    </span>
                                                )}
                                                <span><i className="dk-ot" />Прочее<span className="num">{formatBytes(other)}</span></span>
                                                <span><i className="dk-fr" />Свободно<span className="num">{formatBytes(s.free_bytes)}</span></span>
                                            </div>
                                            {pool.volumes.filter(v => v.state !== 'online').map(v => (
                                                <div key={v.id} className={`disk-off${v.state === 'readonly' ? ' is-ro' : ''}`}>
                                                    <Icon name={v.state === 'readonly' ? 'lock' : 'unlink'} size={13} />
                                                    <span>«{v.name}» {v.state === 'readonly' ? 'только для чтения' : 'не подключён'}</span>
                                                    {v.records_bytes > 0 && <span className="num">{formatBytes(v.records_bytes)} архива</span>}
                                                </div>
                                            ))}
                                        </div>
                                    );
                                })}
                                {devices.length === 0 ? (
                                    <p className="hint">Накопители появятся вместе с устройствами.</p>
                                ) : devices.every(d => pools[d.id] === null) && (
                                    <p className="hint">Служба хранения не отвечает — занятость дисков неизвестна.</p>
                                )}
                            </div>
                        </div>

                        {journalUp && detections.length > 0 && (
                            <div className="card">
                                <div className="card-h">
                                    <h3>Последние обнаружения</h3>
                                    <Link className="eyebrow home-lnk" to="/neural/journal">Журнал ›</Link>
                                </div>
                                <div className="card-b" style={{ paddingTop: 4, paddingBottom: 6 }}>
                                    {detections.map(item => {
                                        const cls = detClass(item, resolve);
                                        return (
                                            <Link className="home-det" key={item.id} to="/neural/journal" state={{ open: item.id }}>
                                                <span className="home-det-t">{fmtTime(item.started_at)}</span>
                                                <span className="home-det-c">{cameraName(item.camera_id)}</span>
                                                <span className="tag"><i className="sw-col" style={{ background: cls.color }} />{cls.name}</span>
                                            </Link>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

            </div>
        </section>
    );
}
