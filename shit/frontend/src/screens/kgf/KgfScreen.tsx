import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../app/Icons';
import { createPeripheralScanSocket, getPeripheralSnapshot } from '../../features/kgf/api';
import type {
    PeripheralChannel,
    PeripheralDevice,
    PeripheralSnapshot,
    PeripheralValue,
} from '../../features/kgf/types';
import './kgf.css';

const POLL_MS = 1000;
const VALUE_STALE_MS = 5000;

const KIND_LABEL: Record<string, string> = {
    pyrometer_board: 'Плата пирометров',
    kelvin: 'Пирометр Kelvin',
    discrete: 'Дискретный модуль',
    lidar: 'Универсальный LiDAR',
    lakibeam: 'LiDAR LakiBeam',
    descriptor: 'Внешний прибор',
};

const STATE_LABEL: Record<string, string> = {
    running: 'работает',
    starting: 'запускается',
    stopped: 'остановлен',
    unavailable: 'нет данных',
    error: 'ошибка',
};

const stateTone = (device: PeripheralDevice) => {
    if (device.message || device.state === 'error') return 'err';
    if (device.state === 'running') return 'ok';
    if (device.state === 'starting') return 'warn';
    return '';
};

const formatTime = (value: string | null | undefined) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('ru-RU');
};

const formatValue = (value: PeripheralValue | undefined, channel: PeripheralChannel) => {
    if (!value || value.value === null) return { main: '—', unit: channel.unit, bool: '' };
    if (typeof value.value === 'boolean') {
        return { main: value.value ? 'Да' : 'Нет', unit: '', bool: value.value ? 'true' : 'false' };
    }
    if (Array.isArray(value.value)) {
        return { main: value.value.join(' · '), unit: '', bool: '' };
    }
    if (typeof value.value === 'object') {
        const points = Array.isArray(value.value.points) ? value.value.points.length : null;
        if (points !== null) return { main: points.toLocaleString('ru-RU'), unit: 'точек', bool: '' };
        return { main: 'получено', unit: '', bool: '' };
    }
    if (typeof value.value === 'number') {
        const digits = Number.isInteger(value.value) ? 0 : 1;
        return {
            main: value.value.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: 2 }),
            unit: channel.unit,
            bool: '',
        };
    }
    return { main: String(value.value), unit: channel.unit, bool: '' };
};

interface ChannelDiagnostic {
    last_value_at?: string | null;
    age_ms?: number | null;
    sequence?: number | null;
    state?: string;
}

const CHANNEL_STATE_LABEL: Record<string, string> = {
    fresh: 'данные актуальны',
    stale: 'данные устарели',
    no_data: 'нет данных',
};

function ValueCard({ channel, value, now, diagnostic }: {
    channel: PeripheralChannel;
    value?: PeripheralValue;
    now: number;
    diagnostic?: ChannelDiagnostic;
}) {
    const shown = formatValue(value, channel);
    const age = value ? now - new Date(value.captured_at).getTime() : Number.POSITIVE_INFINITY;
    const stale = diagnostic?.state ? diagnostic.state !== 'fresh' : age > VALUE_STALE_MS;
    const channelState = diagnostic?.state ?? (value ? stale ? 'stale' : 'fresh' : 'no_data');
    return (
        <div className={`kgf-value${stale ? ' is-stale' : ''}${shown.bool ? ` is-${shown.bool}` : ''}`}>
            <span className="kgf-value-title">
                <span className={`dot ${channelState === 'fresh' ? 'ok' : channelState === 'stale' ? 'warn' : 'err'}`} />
                <span className="kgf-value-name">{channel.name}</span>
            </span>
            <div className="kgf-value-reading">
                <b>{shown.main}</b>
                {shown.unit && <span>{shown.unit}</span>}
            </div>
            <span className="kgf-value-meta">
                {CHANNEL_STATE_LABEL[channelState] ?? channelState} · {value ? `${formatTime(value.captured_at)} · #${value.sequence}` : 'ожидание'}
            </span>
        </div>
    );
}

function DeviceDiagnostics({ device }: { device: PeripheralDevice }) {
    const diagnostics = device.diagnostics;
    if (!diagnostics) return null;
    const transport = diagnostics.transport;
    const serial = transport?.type === 'serial';
    const transportOk = serial ? transport.adapter_present : device.state === 'running';
    const address = serial
        ? `${transport?.port ?? 'порт не задан'} · ${transport?.baudrate ?? '—'} ${transport?.format ?? ''}${transport?.slave_id ? ` · Modbus ${transport.slave_id}` : ''} · ${transport?.adapter_present ? transport.port_open ? 'порт открыт' : 'адаптер найден' : 'адаптера нет'}`
        : `${transport?.host ?? 'сеть'}${transport?.port ? `:${transport.port}` : ''} · ${transport?.protocol ?? 'авто'}`;
    return (
        <div className="kgf-diagnostics">
            <div>
                <span className={`dot ${transportOk ? 'ok' : 'err'}`} />
                <span><small>{serial ? 'Шина и адаптер' : 'Сетевое подключение'}</small><b>{address}</b></span>
            </div>
            <div>
                <span className={`dot ${diagnostics.last_success_at ? 'ok' : 'warn'}`} />
                <span><small>Последний ответ</small><b>{formatTime(diagnostics.last_success_at)} · {diagnostics.observed_hz?.toFixed(1) ?? '0.0'} Гц</b></span>
            </div>
            <div>
                <span className={`dot ${diagnostics.consecutive_errors ? 'err' : 'ok'}`} />
                <span><small>Обмен / ошибки</small><b>{diagnostics.success_count ?? 0} / {diagnostics.error_count ?? 0}{diagnostics.consecutive_errors ? ` · подряд ${diagnostics.consecutive_errors}` : ''}</b></span>
            </div>
        </div>
    );
}

interface LidarPoint {
    angle_deg: number;
    distance_mm: number;
    intensity?: number;
}

interface LidarScan {
    source?: string;
    device_ident?: string;
    points: LidarPoint[];
    profile?: LidarProfile;
}

interface LidarProfile {
    calibrated: boolean;
    points: [number, number][];
    half_width_m: number;
    floor_m: number;
    ceiling_m: number;
    sleeper_length_m: number;
    expected_left_m: number;
    expected_right_m: number;
    left_m: number | null;
    right_m: number | null;
    left_violation: boolean;
    right_violation: boolean;
}

const median = (values: number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const sectorDistance = (points: LidarPoint[], from: number, to: number) => median(
    points.filter(point => point.angle_deg >= from && point.angle_deg <= to).map(point => point.distance_mm),
);

const nearestStableDistance = (points: LidarPoint[]) => {
    const distances = points
        .filter(point => point.angle_deg >= -60 && point.angle_deg <= 60)
        .map(point => point.distance_mm)
        .sort((a, b) => a - b);
    // Медиана пяти ближайших лучей подавляет одиночный шум, но остаётся
    // достаточно чувствительной для ручной проверки расстояния до предмета.
    return median(distances.slice(0, 5));
};

const formatDistance = (millimeters: number | null) => millimeters === null
    ? '—'
    : (millimeters / 1000).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const lidarScan = (value: PeripheralValue | undefined): LidarScan | null => {
    const body = value?.value;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const raw = (body as Record<string, unknown>).points;
    if (!Array.isArray(raw)) return null;
    const points = raw.flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const point = item as Record<string, unknown>;
        const angle = Number(point.angle_deg);
        const distance = Number(point.distance_mm);
        if (!Number.isFinite(angle) || !Number.isFinite(distance) || distance <= 0) return [];
        return [{ angle_deg: angle, distance_mm: distance, intensity: Number(point.intensity) || 0 }];
    });
    const profileBody = (body as Record<string, unknown>).profile;
    let profile: LidarProfile | undefined;
    if (profileBody && typeof profileBody === 'object' && !Array.isArray(profileBody)) {
        const source = profileBody as Record<string, unknown>;
        const left = Number(source.left_m);
        const right = Number(source.right_m);
        const profilePoints = Array.isArray(source.points) ? source.points.flatMap(item => {
            if (!Array.isArray(item) || item.length < 2) return [];
            const x = Number(item[0]);
            const y = Number(item[1]);
            return Number.isFinite(x) && Number.isFinite(y) ? [[x, y] as [number, number]] : [];
        }) : [];
        profile = {
            calibrated: source.calibrated === true,
            points: profilePoints,
            half_width_m: Number(source.half_width_m) || 3,
            floor_m: Number(source.floor_m) || -1,
            ceiling_m: Number(source.ceiling_m) || .5,
            sleeper_length_m: Number(source.sleeper_length_m) || 2.7,
            expected_left_m: Number(source.expected_left_m) || 1.9,
            expected_right_m: Number(source.expected_right_m) || 1.9,
            left_m: source.left_m == null || !Number.isFinite(left) ? null : left,
            right_m: source.right_m == null || !Number.isFinite(right) ? null : right,
            left_violation: source.left_violation === true,
            right_violation: source.right_violation === true,
        };
    }
    return {
        source: typeof body.source === 'string' ? body.source : undefined,
        device_ident: typeof body.device_ident === 'string' ? body.device_ident : undefined,
        points,
        profile,
    };
};

function LidarScanCard({ deviceId, channel, value, now }: {
    deviceId: string;
    channel: PeripheralChannel;
    value?: PeripheralValue;
    now: number;
}) {
    const [liveValue, setLiveValue] = useState<PeripheralValue | undefined>(value);
    const [frameRate, setFrameRate] = useState(0);
    const [view, setView] = useState<'profile' | 'raw'>('profile');
    const arrivals = useRef<number[]>([]);
    const pending = useRef<PeripheralValue | null>(null);
    const animation = useRef<number | null>(null);

    useEffect(() => {
        if (value) setLiveValue(current => !current || value.sequence > current.sequence ? value : current);
    }, [value]);

    useEffect(() => {
        let stopped = false;
        let socket: WebSocket | null = null;
        let reconnect: number | null = null;
        const connect = () => {
            socket = createPeripheralScanSocket(deviceId);
            socket.onmessage = event => {
                try {
                    const next = JSON.parse(String(event.data)) as PeripheralValue;
                    if (next.device_id !== deviceId || next.channel_id !== channel.id) return;
                    const arrivedAt = performance.now();
                    arrivals.current = [...arrivals.current.filter(item => arrivedAt - item <= 2000), arrivedAt];
                    const times = arrivals.current;
                    if (times.length > 1) setFrameRate((times.length - 1) * 1000 / (times[times.length - 1] - times[0]));
                    pending.current = next;
                    if (animation.current === null) {
                        animation.current = window.requestAnimationFrame(() => {
                            animation.current = null;
                            if (pending.current) setLiveValue(pending.current);
                        });
                    }
                } catch { /* следующий кадр восстановит отображение */ }
            };
            socket.onclose = () => {
                arrivals.current = [];
                setFrameRate(0);
                if (!stopped) reconnect = window.setTimeout(connect, 1000);
            };
        };
        connect();
        return () => {
            stopped = true;
            socket?.close();
            if (reconnect !== null) window.clearTimeout(reconnect);
            if (animation.current !== null) window.cancelAnimationFrame(animation.current);
        };
    }, [channel.id, deviceId]);

    const scan = lidarScan(liveValue);
    const age = liveValue ? now - new Date(liveValue.captured_at).getTime() : Number.POSITIVE_INFINITY;
    const stale = age > VALUE_STALE_MS;
    const maxDistance = Math.max(1000, ...(scan?.points.map(point => point.distance_mm) ?? []));
    const scale = Math.ceil(maxDistance / 1000) * 1000;
    const coordinates = scan?.points.map(point => {
        const angle = point.angle_deg * Math.PI / 180;
        const radius = point.distance_mm / scale;
        const x = radius * Math.cos(angle);
        const y = radius * Math.sin(angle);
        return `${x.toFixed(4)} ${y.toFixed(4)}`;
    }) ?? [];
    const path = coordinates.map((point, index) => `${index ? 'L' : 'M'}${point}`).join(' ');
    // Короткие нулевые сегменты с round linecap дают яркие точки одним SVG-path,
    // без сотен DOM-элементов и заметной нагрузки при ежесекундном обновлении.
    const pointCloud = coordinates.map(point => `M${point}h.0001`).join(' ');
    const centerDistance = sectorDistance(scan?.points ?? [], -1.5, 1.5);
    const leftDistance = sectorDistance(scan?.points ?? [], -45, -10);
    const rightDistance = sectorDistance(scan?.points ?? [], 10, 45);
    const nearestDistance = nearestStableDistance(scan?.points ?? []);
    const profile = scan?.profile;
    const profileHeight = Math.max(.1, (profile?.ceiling_m ?? .5) - (profile?.floor_m ?? -1));
    const profileCoordinates = profile?.points.map(([x, y]) => {
        const px = x / profile.half_width_m;
        const py = -1 + 2 * (profile.ceiling_m - y) / profileHeight;
        return `${px.toFixed(4)} ${py.toFixed(4)}`;
    }) ?? [];
    const profilePath = profileCoordinates.map((point, index) => `${index ? 'L' : 'M'}${point}`).join(' ');
    const profileCloud = profileCoordinates.map(point => `M${point}h.0001`).join(' ');
    const sleeperHalf = (profile?.sleeper_length_m ?? 2.7) / 2 / (profile?.half_width_m ?? 3);
    const expectedLeft = -(profile?.expected_left_m ?? 1.9) / (profile?.half_width_m ?? 3);
    const expectedRight = (profile?.expected_right_m ?? 1.9) / (profile?.half_width_m ?? 3);

    return (
        <div className={`kgf-scan${stale ? ' is-stale' : ''}`}>
            <div className="kgf-scan-head">
                <div>
                    <span className="kgf-value-name">{channel.name}</span>
                    <b>{scan ? scan.points.length.toLocaleString('ru-RU') : '—'} <small>точек</small></b>
                </div>
                <div className="kgf-scan-meta">
                    <span>{scan?.device_ident ?? scan?.source ?? 'нет данных'}</span>
                    <span>{liveValue ? `${formatTime(liveValue.captured_at)} · #${liveValue.sequence}` : 'ожидание скана'}</span>
                </div>
            </div>
            <div className="kgf-scan-controls">
                <button className={view === 'profile' ? 'is-active' : ''} onClick={() => setView('profile')}>Профиль пути</button>
                <button className={view === 'raw' ? 'is-active' : ''} onClick={() => setView('raw')}>Сырые данные</button>
            </div>
            {view === 'profile' ? <>
                <div className="kgf-scan-metrics">
                    <div><span>Левое плечо</span><b>{formatDistance(profile?.left_m == null ? null : profile.left_m * 1000)} <small>м</small></b></div>
                    <div><span>Правое плечо</span><b>{formatDistance(profile?.right_m == null ? null : profile.right_m * 1000)} <small>м</small></b></div>
                    <div><span>Норма слева / справа</span><b>{profile ? `${profile.expected_left_m.toFixed(2)} / ${profile.expected_right_m.toFixed(2)}` : '—'} <small>м</small></b></div>
                    <div><span>Калибровка</span><b className={profile?.calibrated ? 'is-ok' : 'is-warn'}>{profile?.calibrated ? 'готова' : 'требуется'}</b></div>
                    <div><span>Частота / возраст</span><b>{frameRate ? frameRate.toFixed(1) : '—'} <small>Гц · {Number.isFinite(age) ? `${Math.max(0, Math.round(age))} мс` : '—'}</small></b></div>
                </div>
                <div className="kgf-scan-plot is-profile">
                    <svg viewBox="-1.08 -1.08 2.16 2.16" role="img" aria-label="Поперечный профиль пути по данным LiDAR">
                        <g className="kgf-profile-grid">
                            <path d="M-1 0H1M0-1V1" />
                            <path d="M-.5-1V1M.5-1V1M-1-.5H1M-1 .5H1" />
                        </g>
                        <path className="kgf-profile-sleeper" d={`M${-sleeperHalf} 0H${sleeperHalf}`} />
                        <path className="kgf-profile-expected" d={`M${expectedLeft}-1V1M${expectedRight}-1V1`} />
                        {profile?.left_m != null && <path className={profile.left_violation ? 'kgf-profile-measured is-err' : 'kgf-profile-measured'} d={`M${-profile.left_m / profile.half_width_m}-.12V.12`} />}
                        {profile?.right_m != null && <path className={profile.right_violation ? 'kgf-profile-measured is-err' : 'kgf-profile-measured'} d={`M${profile.right_m / profile.half_width_m}-.12V.12`} />}
                        {profilePath && <path className="kgf-scan-line" d={profilePath} />}
                        {profileCloud && <path className="kgf-scan-points" d={profileCloud} />}
                    </svg>
                    <span className="kgf-profile-axis is-left">−{profile?.half_width_m ?? 3} м</span>
                    <span className="kgf-profile-axis is-center">ось пути</span>
                    <span className="kgf-profile-axis is-right">+{profile?.half_width_m ?? 3} м</span>
                    {!profile?.calibrated && <span className="kgf-profile-warning">Черновой профиль — задайте высоту и угол установки LiDAR</span>}
                </div>
            </> : <>
                <div className="kgf-scan-metrics">
                    <div><span>По оси</span><b>{formatDistance(centerDistance)} <small>м</small></b></div>
                    <div><span>Ближайшая цель ±60°</span><b>{formatDistance(nearestDistance)} <small>м</small></b></div>
                    <div><span>Слева 10–45°</span><b>{formatDistance(leftDistance)} <small>м</small></b></div>
                    <div><span>Справа 10–45°</span><b>{formatDistance(rightDistance)} <small>м</small></b></div>
                    <div><span>Частота / возраст</span><b>{frameRate ? frameRate.toFixed(1) : '—'} <small>Гц · {Number.isFinite(age) ? `${Math.max(0, Math.round(age))} мс` : '—'}</small></b></div>
                </div>
                <div className="kgf-scan-plot">
                    <svg viewBox="-1.08 -1.08 2.16 2.16" role="img" aria-label="Скан LiDAR, вид сверху">
                        <g className="kgf-scan-grid">
                            <circle r="1" /><circle r=".75" /><circle r=".5" /><circle r=".25" />
                            <path d="M-1 0H1M0-1V1" />
                        </g>
                        {path && <path className="kgf-scan-line" d={path} />}
                        {pointCloud && <path className="kgf-scan-points" d={pointCloud} />}
                        <path className="kgf-scan-origin" d="M-.035 -.035L0 .055L.035 -.035Z" />
                    </svg>
                    <span className="kgf-scan-scale">радиус до {(scale / 1000).toLocaleString('ru-RU')} м</span>
                </div>
            </>}
        </div>
    );
}

function DeviceCard({ device, values, now }: { device: PeripheralDevice; values: Map<string, PeripheralValue>; now: number }) {
    const tone = stateTone(device);
    return (
        <article className={`kgf-device${tone ? ` is-${tone}` : ''}`}>
            <header className="kgf-device-h">
                <span className={`dot ${tone}`} />
                <div className="kgf-device-title">
                    <b>{device.name}</b>
                    <span>{KIND_LABEL[device.kind] ?? device.kind} · <span className="num">{device.id}</span></span>
                </div>
                <span className={`tag${tone ? ` is-${tone}` : ''}`}>{STATE_LABEL[device.state] ?? device.state}</span>
            </header>
            {device.message && (
                <div className="kgf-device-error">
                    <Icon name="warn" size={15} />
                    <span>{device.message}</span>
                </div>
            )}
            <DeviceDiagnostics device={device} />
            <div className="kgf-values">
                {device.channels.map(channel => (
                    channel.type === 'scan'
                        ? <LidarScanCard key={channel.id} deviceId={device.id} channel={channel} value={values.get(channel.id)} now={now} />
                        : <ValueCard
                            key={channel.id}
                            channel={channel}
                            value={values.get(channel.id)}
                            now={now}
                            diagnostic={device.diagnostics?.channels?.[channel.id]}
                        />
                ))}
            </div>
        </article>
    );
}

export default function KgfScreen() {
    const [snapshot, setSnapshot] = useState<PeripheralSnapshot | null>(null);
    const [failed, setFailed] = useState(false);
    const [loading, setLoading] = useState(false);
    const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
    const [now, setNow] = useState(Date.now());
    const mounted = useRef(true);
    const request = useRef(0);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const refresh = useCallback(async () => {
        const id = ++request.current;
        setLoading(true);
        try {
            const next = await getPeripheralSnapshot();
            if (!mounted.current || id !== request.current) return;
            setSnapshot(next);
            setUpdatedAt(new Date());
            setFailed(false);
        } catch {
            if (mounted.current && id === request.current) setFailed(true);
        } finally {
            if (mounted.current && id === request.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => void refresh(), POLL_MS);
        return () => window.clearInterval(timer);
    }, [refresh]);

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), POLL_MS);
        return () => window.clearInterval(timer);
    }, []);

    const deviceValues = useMemo(() => {
        const result = new Map<string, Map<string, PeripheralValue>>();
        for (const value of snapshot?.values ?? []) {
            const values = result.get(value.device_id) ?? new Map<string, PeripheralValue>();
            values.set(value.channel_id, value);
            result.set(value.device_id, values);
        }
        return result;
    }, [snapshot]);

    const devices = snapshot?.status.devices ?? [];
    const lidarDevices = devices.filter(device => device.channels.some(channel => channel.type === 'scan'));
    const otherDevices = devices.filter(device => !device.channels.some(channel => channel.type === 'scan'));
    const deviceGroups = lidarDevices.length && otherDevices.length ? [otherDevices, lidarDevices] : [devices];
    const errors = devices.filter(device => stateTone(device) === 'err').length;
    const liveValues = (snapshot?.values ?? []).filter(value => now - new Date(value.captured_at).getTime() <= VALUE_STALE_MS).length;
    const runtime = snapshot?.status.runtime;
    const runtimeOk = !failed && runtime?.state === 'running';

    return (
        <section className="screen kgf-screen glow">
            <div className="kgf-toolbar">
                <div>
                    <span className="eyebrow">Дополнительные модули РСМ 2000</span>
                    <h1>Периферия КГФ</h1>
                </div>
                <span className={`pill ${runtimeOk ? 'ok' : 'err'}`}>
                    <span className="dot" />
                    {failed ? 'нет связи' : runtime?.state === 'running' ? 'сервис работает' : runtime?.state ?? 'подключение'}
                </span>
                <span className="pill num">{updatedAt ? `обновлено ${updatedAt.toLocaleTimeString('ru-RU')}` : 'ожидание данных'}</span>
                <button className="btn btn--ghost btn--sm" onClick={() => void refresh()} disabled={loading}>
                    <Icon name="refresh" size={15} />
                    Обновить
                </button>
            </div>

            <div className="kgf-scroll">
                {failed && (
                    <div className="banner">
                        <Icon name="warn" size={16} />
                        Сервис периферии не отвечает. Показан последний полученный снимок.
                    </div>
                )}

                <div className="kgf-summary">
                    <div className="kgf-kpi">
                        <span>Приборов</span>
                        <b>{devices.length}</b>
                        <small>{devices.length ? `${devices.length - errors} без ошибок` : 'конфигурация пуста'}</small>
                    </div>
                    <div className={`kgf-kpi${errors ? ' is-err' : ' is-ok'}`}>
                        <span>Требуют внимания</span>
                        <b>{errors}</b>
                        <small>{errors ? 'ошибка связи или драйвера' : 'ошибок нет'}</small>
                    </div>
                    <div className="kgf-kpi is-acc">
                        <span>Актуальных каналов</span>
                        <b>{liveValues}</b>
                        <small>данные моложе 5 секунд</small>
                    </div>
                    <div className="kgf-kpi">
                        <span>Время и координаты</span>
                        <b>{snapshot?.status.gateway_time.can_time ? 'CAN' : snapshot?.status.gateway_time.ntp_time ? 'NTP' : '—'}</b>
                        <small>{snapshot?.status.gateway_time.gps_valid ? 'GPS подтверждён' : 'GPS нет'}</small>
                    </div>
                </div>

                {!snapshot && !failed ? (
                    <div className="kgf-empty"><span className="skel" /><span className="skel" /><span className="skel" /></div>
                ) : devices.length === 0 ? (
                    <div className="kgf-empty-state">
                        <Icon name="empty" size={32} />
                        <b>Приборы не настроены</b>
                        <span>Активируйте профиль КГФ или добавьте периферийные устройства в паспорт машины.</span>
                    </div>
                ) : (
                    <div className={`kgf-devices${deviceGroups.length === 1 ? ' is-single' : ''}`}>
                        {deviceGroups.map((group, index) => (
                            <div className="kgf-device-column" key={index}>
                                {group.map(device => (
                                    <DeviceCard key={device.id} device={device} values={deviceValues.get(device.id) ?? new Map()} now={now} />
                                ))}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}
