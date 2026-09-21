import { Icon } from '../app/Icons';
import { useSystem } from '../app/SystemContext';
import {
    MODULE_LABEL, deviceMetrics, isOnline, netParts, sinceLabel, sortDevices, uptimeLabel,
} from '../screens/devices/model';

const METRIC_KEYS = ['cpu', 'temp', 'ping'] as const;

export default function DevicesScreen() {
    const { devices } = useSystem();
    const offline = devices.filter(d => !isOnline(d));

    return (
        <section className="m-screen">
            <div className="m-scroll">
                {offline.length > 0 && (
                    <div className="banner" style={{ marginBottom: 4 }}>
                        <Icon name="warn" />
                        <span>{offline.map(d => d.name).join(', ')} не в сети. Модули этих устройств недоступны, пока они не вернутся.</span>
                    </div>
                )}
                {devices.length === 0 && (
                    <div className="empty">
                        <Icon name="dev" />
                        <b>Устройства не добавлены</b>
                        <p>Устройства добавляются на рабочем месте.</p>
                    </div>
                )}
                <div className="m-dv2" style={{ paddingTop: 16 }}>
                    {sortDevices(devices).map(device => {
                        const metrics = deviceMetrics(device);
                        const byKey = (key: string) => metrics.find(m => m.key === key);
                        const disk = byKey('disk');
                        const net = netParts(device);
                        const online = isOnline(device);
                        return (
                            <div key={device.id} className={`m-dv${online ? '' : ' is-off'}`}>
                                <div className="m-dv-h">
                                    <span className={`dot ${online ? 'ok' : 'err'}`} />
                                    <b>{device.name}</b>
                                    <span className="ip seps">
                                        <span>{device.ip}</span>
                                        {device.telemetry?.hostname && <span>{device.telemetry.hostname}</span>}
                                    </span>
                                </div>
                                {online ? (
                                    <>
                                        <div className="m-met">
                                            {METRIC_KEYS.map(key => {
                                                const m = byKey(key)!;
                                                return (
                                                    <div key={key}>
                                                        <b className={m.tone === 'warn' || m.tone === 'err' ? m.tone : ''}>{m.value}</b>
                                                        <small>{key === 'cpu' ? 'CPU' : key === 'temp' ? 'SoC' : 'ping'}</small>
                                                    </div>
                                                );
                                            })}
                                            <div><b>{uptimeLabel(device.telemetry?.uptime_sec)}</b><small>работает</small></div>
                                        </div>
                                        <div className="m-dv-f">
                                            <div className="m-tags">
                                                {device.modules.map(m => <span key={m} className="tag is-acc">{MODULE_LABEL[m] ?? m}</span>)}
                                                {device.telemetry?.platform && <span className="tag">{device.telemetry.platform.label}</span>}
                                            </div>
                                            {disk && disk.pct > 0 && (
                                                <div className="bar"><i className="dk-ot" style={{ width: `${disk.pct}%`, background: disk.tone === 'ok' ? 'var(--acc)' : `var(--${disk.tone})` }} /></div>
                                            )}
                                            <div className="m-lg">
                                                {disk && <span>диск <span className="num">{disk.value}</span></span>}
                                                {byKey('mem') && <span>память <span className="num">{byKey('mem')!.value}</span></span>}
                                                {net && <span>сеть <span className="num">↓ {net.rx} ↑ {net.tx} Мбит/с</span></span>}
                                                {device.telemetry?.version && <span>ПО <span className="num">{device.telemetry.version}</span></span>}
                                            </div>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="m-dv-off">
                                            <Icon name="warn" />
                                            Не отвечает
                                            <span className="num">{sinceLabel(device.last_seen)}</span>
                                        </div>
                                        <div className="m-dv-f" style={{ borderTop: '1px solid var(--line)' }}>
                                            <div className="m-tags" style={{ margin: 0 }}>
                                                {device.modules.map(m => <span key={m} className="tag" style={{ opacity: .6 }}>{MODULE_LABEL[m] ?? m}</span>)}
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
