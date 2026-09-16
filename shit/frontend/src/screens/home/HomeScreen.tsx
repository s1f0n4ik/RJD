import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { navFor, useRole } from '../../app/role';
import { useSystem } from '../../app/SystemContext';
import { useDisks, useGatewayStatus, useLastDetections, useLinkerStatus, useNeuralStatus } from './useHomeData';
import { useLayouts } from '../../hooks/Layouts';
import type { Device } from '../../services/devices';
import './home.css';

// Статус 3 — пайплайн запущен; всё остальное для оператора означает «потока нет».
// Камера в работе, если работает хотя бы один её поток: их произвольное число
const isLive = (camera: { offline?: boolean; streams?: Record<string, { status?: number }> }) =>
    !camera.offline && Object.values(camera.streams ?? {}).some(s => s.status === 3);

const toGb = (bytes: number) => bytes / 1024 ** 3;

const formatGb = (gb: number) =>
    gb >= 1024 ? `${(gb / 1024).toFixed(2)} ТБ` : gb >= 10 ? `${Math.round(gb)} ГБ` : `${gb.toFixed(1)} ГБ`;

// 1 камера · 2 камеры · 5 камер
const plural = (n: number, one: string, few: string, many: string) => {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
};

const maxTemp = (device: Device) => {
    const zones = device.telemetry?.temperature ?? [];
    return zones.length ? Math.max(...zones.map(z => z.celsius)) : null;
};

export function HomeScreen() {
    const role = useRole();
    const { cameras, devices } = useSystem();
    const disks = useDisks(devices);
    const { layouts } = useLayouts();
    const { items: detections, available: journalUp } = useLastDetections();
    const gateway = useGatewayStatus();
    const linker = useLinkerStatus();
    const neural = useNeuralStatus();

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
    const neuralSummary = neural
        ? neural.slots === 0
            ? 'потоков нет'
            : (
                <span className="seps">
                    <span>{neural.running} {plural(neural.running, 'поток', 'потока', 'потоков')} в работе</span>
                    {neural.failed > 0 && <span>{neural.failed} с ошибкой</span>}
                </span>
            )
        : 'модуль не отвечает';
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

    return (
        <section className="screen glow home">
            <div className="scroll">

                <div className="hero">
                    <div>
                        <h1>Общее состояние</h1>
                    </div>
                    <div className="hero-stats">
                        <div className="stat is-acc">
                            <b>{liveCameras}/{cameras.length}</b>
                            <span>камер в работе</span>
                        </div>
                        <div className="stat">
                            <b>{online.length}/{devices.length}</b>
                            <span>устройств в сети</span>
                        </div>
                        <div className={`stat${deadCameras + offlineDevices > 0 ? ' is-warn' : ''}`}>
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
                            <Link key={item.to} to={item.to} className={`tile${(item.to === '/krsps' && !gateway) || (item.to === '/surround' && !linker) || (item.to === '/neural' && !neural) ? ' is-off' : ''}`}>
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
                            <div className="card-b" style={{ paddingTop: 4, paddingBottom: 8 }}>
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
                                    const temp = maxTemp(device);
                                    const cpu = device.telemetry?.cpu?.percent;
                                    const offline = device.status !== 'online';
                                    const details = [
                                        cpu != null ? `${Math.round(cpu)} %` : null,
                                        temp != null ? `${Math.round(temp)} °C` : null,
                                        device.ping_ms != null ? `${device.ping_ms} мс` : null,
                                    ].filter((v): v is string => v !== null);
                                    return (
                                        <div key={device.id} className={`svc${offline ? ' is-err' : ''}`}>
                                            <span className={`dot ${offline ? 'err' : 'ok'}`} />
                                            <span className="nm">{device.name}</span>
                                            <span className="val seps">
                                                {offline || details.length === 0
                                                    ? <span>{offline ? 'не в сети' : 'в сети'}</span>
                                                    : details.map(d => <span key={d}>{d}</span>)}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="card">
                            <div className="card-h"><h3>Накопители</h3></div>
                            <div className="card-b">
                                {devices.map(device => {
                                    const disk = disks[device.id];
                                    if (!disk) return null;
                                    // Незанятая часть резерва журнала архиву уже не достанется —
                                    // тревога считается по ней же, что и у чистильщика
                                    const withheld = Math.max(0, disk.journal_reserve_bytes - disk.journal_bytes);
                                    const pressure = disk.total_bytes
                                        ? (disk.used_bytes + withheld) / disk.total_bytes * 100
                                        : 0;
                                    const warn = pressure >= disk.max_used_percent - 15;
                                    const crit = pressure >= disk.max_used_percent;
                                    const share = (bytes: number) =>
                                        disk.total_bytes ? Math.max(0, bytes / disk.total_bytes * 100) : 0;
                                    const other = Math.max(0, disk.used_bytes - disk.records_bytes - disk.journal_bytes);
                                    return (
                                        <div className={`disk${crit ? ' is-err' : warn ? ' is-warn' : ''}`} key={device.id}>
                                            <div className="disk-h">
                                                <b>{device.name}</b>
                                                <span className="num">
                                                    {formatGb(disk.used_gb)} / {formatGb(disk.total_gb)}
                                                </span>
                                            </div>
                                            <div className="bar bar--split">
                                                <i className="dk-ar" style={{ width: `${share(disk.records_bytes)}%` }} />
                                                <i className="dk-jr" style={{ width: `${share(disk.journal_bytes)}%` }} />
                                                <i className="dk-ot" style={{ width: `${share(other)}%` }} />
                                            </div>
                                            <div className="disk-lg">
                                                <span><i className="dk-ar" />Архив<span className="num">{formatGb(toGb(disk.records_bytes))}</span></span>
                                                {disk.journal_reserve_bytes > 0 && (
                                                    <span>
                                                        <i className="dk-jr" />Журнал
                                                        <span className="num">
                                                            {formatGb(toGb(disk.journal_bytes))} из {formatGb(toGb(disk.journal_reserve_bytes))}
                                                        </span>
                                                    </span>
                                                )}
                                                <span><i className="dk-ot" />Прочее<span className="num">{formatGb(toGb(other))}</span></span>
                                                <span><i className="dk-fr" />Свободно<span className="num">{formatGb(disk.free_gb)}</span></span>
                                            </div>
                                        </div>
                                    );
                                })}
                                {devices.length === 0 ? (
                                    <p className="hint">Накопители появятся вместе с устройствами.</p>
                                ) : devices.every(d => !disks[d.id]) && (
                                    <p className="hint">Служба хранения не отвечает — занятость дисков неизвестна.</p>
                                )}
                            </div>
                        </div>

                        {journalUp && detections.length > 0 && (
                            <div className="card">
                                <div className="card-h">
                                    <h3>Последние обнаружения</h3>
                                    <span className="eyebrow">журнал</span>
                                </div>
                                <div className="card-b" style={{ paddingTop: 6 }}>
                                    {detections.map(item => (
                                        <div className="kv" key={item.id}>
                                            <span className="k num">
                                                {new Date(item.ts).toLocaleTimeString('ru-RU')}
                                            </span>
                                            <span className="v seps">
                                                <span>{item.camera_id}</span>
                                                <span>объектов {item.objects.length}</span>
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

            </div>
        </section>
    );
}
