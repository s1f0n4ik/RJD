import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { NAV } from '../../app/nav';
import { useSystem } from '../../app/SystemContext';
import { useDisks, useLastDetections } from './useHomeData';
import { useLayouts } from '../../hooks/Layouts';
import type { Device } from '../../services/devices';
import './home.css';

// Статус 3 — пайплайн запущен; всё остальное для оператора означает «потока нет».
// Камера в работе, если работает хотя бы один её поток: их произвольное число
const isLive = (camera: { offline?: boolean; streams?: Record<string, { status?: number }> }) =>
    !camera.offline && Object.values(camera.streams ?? {}).some(s => s.status === 3);

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
    const { cameras, devices } = useSystem();
    const disks = useDisks(devices);
    const { layouts } = useLayouts();
    const { items: detections, available: journalUp } = useLastDetections();

    const online = devices.filter(d => d.status === 'online');
    const liveCameras = cameras.filter(isLive).length;
    const deadCameras = cameras.length - liveCameras;
    const offlineDevices = devices.length - online.length;

    const layoutSummary = layouts.length === 0
        ? 'отображения не настроены'
        : `${layouts.length} ${plural(layouts.length, 'отображение', 'отображения', 'отображений')}`;

    const cameraSummary = cameras.length === 0
        ? 'камеры не добавлены'
        : `${cameras.length} ${plural(cameras.length, 'камера', 'камеры', 'камер')}` +
          (deadCameras > 0 ? ` · ${deadCameras} без потока` : ' · все в работе');

    // Закрытие помнит состав офлайна: погаснет другое устройство — баннер вернётся
    const offlineNames = devices.filter(d => d.status !== 'online').map(d => d.name).join(', ');
    const [dismissed, setDismissed] = useState<string | null>(null);

    return (
        <section className="screen glow">
            <div className="scroll">

                {devices.length === 0 ? (
                    <div className="card" style={{ marginBottom: 18 }}>
                        <div className="card-b">
                            <div className="empty">
                                <Icon name="dev" size={34} />
                                <b>Устройства не добавлены</b>
                                <p>
                                    В системе нет ни одного вычислительного устройства — показывать нечего.
                                    Добавьте устройство в разделе «Устройства».
                                </p>
                            </div>
                        </div>
                    </div>
                ) : (
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
                )}

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
                        {NAV.filter(item => item.to !== '/').map(item => (
                            item.ready ? (
                                <Link key={item.to} to={item.to} className="tile">
                                    <Icon name={item.icon} size={22} />
                                    <b>{item.label}</b>
                                    {item.desc && <span>{item.desc}</span>}
                                    {item.to === '/cameras' && <span className="foot">{cameraSummary}</span>}
                                    {item.to === '/live' && <span className="foot">{layoutSummary}</span>}
                                </Link>
                            ) : (
                                <div key={item.to} className="tile is-off">
                                    <Icon name={item.icon} size={22} />
                                    <b>{item.label}</b>
                                    <span className="foot">в работе</span>
                                </div>
                            )
                        ))}
                    </div>

                    <div className="stack">
                        <div className="card">
                            <div className="card-h">
                                <h3>Устройства</h3>
                                <span className="eyebrow">опрос 10 с</span>
                            </div>
                            <div className="card-b" style={{ paddingTop: 4, paddingBottom: 8 }}>
                                {devices.map(device => {
                                    const temp = maxTemp(device);
                                    const cpu = device.telemetry?.cpu?.percent;
                                    const offline = device.status !== 'online';
                                    const details = [
                                        cpu != null ? `${Math.round(cpu)} %` : null,
                                        temp != null ? `${Math.round(temp)} °C` : null,
                                        device.ping_ms != null ? `${device.ping_ms} мс` : null,
                                    ].filter(Boolean).join(' · ');
                                    return (
                                        <div key={device.id} className={`svc${offline ? ' is-err' : ''}`}>
                                            <span className={`dot ${offline ? 'err' : 'ok'}`} />
                                            <span className="nm">{device.name}</span>
                                            <span className="val">
                                                {offline ? 'не в сети' : details || 'в сети'}
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
                                    const warn = disk.used_percent >= disk.max_used_percent - 15;
                                    const crit = disk.used_percent >= disk.max_used_percent;
                                    return (
                                        <div className="disk" key={device.id}>
                                            <div className="disk-h">
                                                <b>{device.name}</b>
                                                <span className="num">
                                                    {formatGb(disk.used_gb)} / {formatGb(disk.total_gb)}
                                                </span>
                                            </div>
                                            <div className="bar">
                                                <i
                                                    className={crit ? 'is-err' : warn ? 'is-warn' : ''}
                                                    style={{ width: `${Math.min(100, disk.used_percent)}%` }}
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                                {devices.every(d => !disks[d.id]) && (
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
                                            <span className="v">
                                                {item.camera_id} · объектов {item.objects.length}
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
