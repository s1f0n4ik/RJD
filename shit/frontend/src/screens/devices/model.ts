import type { Device, RoutingTable } from '../../services/devices';

export type Tone = 'ok' | 'warn' | 'err' | 'dim';

export interface DeviceMetric {
    key: string;
    label: string;
    value: string;
    // Заполнение полосы, 0…100
    pct: number;
    tone: Tone;
}

const GB = 1024 ** 3;

export const isOnline = (device: Device): boolean => device.status === 'online';

const ru = (value: number, digits = 1) => value.toFixed(digits).replace('.', ',');

export const formatBytes = (bytes?: number | null): string => {
    if (!bytes || bytes <= 0) return '—';
    const tb = bytes / (1024 * GB);
    if (tb >= 1) return `${ru(tb)} ТБ`;
    return `${Math.round(bytes / GB)} ГБ`;
};

export const formatBits = (bps?: number | null): string => {
    if (bps === null || bps === undefined) return '—';
    return ru(bps * 8 / 1_000_000);
};

export const uptimeLabel = (sec?: number | null): string => {
    if (!sec || sec <= 0) return '—';
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    if (days > 0) return `${days} сут ${hours} ч`;
    if (hours > 0) return `${hours} ч ${Math.floor((sec % 3600) / 60)} мин`;
    return `${Math.max(1, Math.floor(sec / 60))} мин`;
};

// Давность последнего ответа устройства
export const sinceLabel = (lastSeen: number | null): string => {
    if (!lastSeen) return 'ни разу не отвечало';
    const sec = Math.max(0, Math.round(Date.now() / 1000 - lastSeen));
    if (sec < 60) return `${sec} с`;
    if (sec < 3600) return `${Math.floor(sec / 60)} мин`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} ч`;
    return `${Math.floor(sec / 86400)} сут`;
};

export const lastSeenTime = (lastSeen: number | null): string =>
    lastSeen ? new Date(lastSeen * 1000).toLocaleTimeString('ru-RU') : '—';

// Самая горячая зона устройства
const hottest = (device: Device): number | null => {
    const zones = device.telemetry?.temperature ?? [];
    if (!zones.length) return null;
    return Math.max(...zones.map(z => z.celsius));
};

// Диск с наибольшим объёмом: на нём лежит архив
const mainDisk = (device: Device) => {
    const disks = (device.telemetry?.disks ?? []).filter(d => d.available && d.total_bytes);
    if (!disks.length) return null;
    return disks.reduce((a, b) => ((b.total_bytes ?? 0) > (a.total_bytes ?? 0) ? b : a));
};

const band = (value: number, warn: number, err: number): Tone =>
    value >= err ? 'err' : value >= warn ? 'warn' : 'ok';

const EMPTY_METRIC = (key: string, label: string): DeviceMetric =>
    ({ key, label, value: '—', pct: 0, tone: 'dim' });

export function deviceMetrics(device: Device): DeviceMetric[] {
    const keys = [
        ['cpu', 'Процессор'],
        ['mem', 'ОЗУ свободно'],
        ['disk', 'Диск свободно'],
        ['temp', 'Температура'],
        ['ping', 'Отклик'],
    ] as const;

    if (!isOnline(device)) return keys.map(([key, label]) => EMPTY_METRIC(key, label));

    const telemetry = device.telemetry ?? {};
    const cores = telemetry.cpu?.cores ?? 0;
    const cpu = telemetry.cpu?.percent;
    const total = telemetry.memory?.total_bytes ?? 0;
    const free = telemetry.memory?.available_bytes ?? 0;
    const disk = mainDisk(device);
    const temp = hottest(device);
    const ping = device.ping_ms;

    const metrics: DeviceMetric[] = [];

    metrics.push(cpu === undefined ? EMPTY_METRIC('cpu', 'Процессор') : {
        key: 'cpu',
        label: 'Процессор',
        value: `${Math.round(cpu)} %${cores ? ` · ${cores} яд.` : ''}`,
        pct: Math.min(100, cpu),
        tone: band(cpu, 70, 88),
    });

    metrics.push(!total ? EMPTY_METRIC('mem', 'ОЗУ свободно') : {
        key: 'mem',
        label: 'ОЗУ свободно',
        value: `${ru(free / GB)} / ${ru(total / GB)} ГБ`,
        pct: Math.min(100, (free / total) * 100),
        tone: band(100 - (free / total) * 100, 82, 92),
    });

    metrics.push(!disk ? EMPTY_METRIC('disk', 'Диск свободно') : {
        key: 'disk',
        label: 'Диск свободно',
        value: formatBytes(disk.free_bytes),
        pct: Math.min(100, ((disk.free_bytes ?? 0) / (disk.total_bytes ?? 1)) * 100),
        tone: band(100 - ((disk.free_bytes ?? 0) / (disk.total_bytes ?? 1)) * 100, 85, 95),
    });

    metrics.push(temp === null ? EMPTY_METRIC('temp', 'Температура') : {
        key: 'temp',
        label: 'Температура',
        value: `${Math.round(temp)} °C`,
        pct: Math.min(100, (temp / 100) * 100),
        tone: band(temp, 70, 82),
    });

    metrics.push(ping === null || ping === undefined ? EMPTY_METRIC('ping', 'Отклик') : {
        key: 'ping',
        label: 'Отклик',
        value: `${Math.round(ping)} мс`,
        pct: Math.min(100, (ping / 500) * 100),
        tone: band(ping, 150, 400),
    });

    return metrics;
}

export const netLabel = (device: Device): string => {
    if (!isOnline(device) || device.net_rx_bps === null) return '—';
    return `↓ ${formatBits(device.net_rx_bps)} ↑ ${formatBits(device.net_tx_bps)} Мбит/с`;
};

// В сети сверху, дальше по имени
export const sortDevices = (devices: Device[]): Device[] =>
    [...devices].sort((a, b) => {
        if (isOnline(a) !== isOnline(b)) return isOnline(a) ? -1 : 1;
        return a.name.localeCompare(b.name, 'ru', { numeric: true });
    });

export const MODULE_LABEL: Record<string, string> = {
    birdview: '360',
    neural: 'тех. зрение',
    krsps: 'КРСПС',
};

export type RoutingSlot = keyof RoutingTable;

export interface RoutingRow {
    slot: RoutingSlot;
    label: string;
    // Модуль, который устройство обязано нести; для камер — ядро, подходит любое
    module: string | null;
    state: string;
}

export const MODULE_ROWS: RoutingRow[] = [
    { slot: 'birdview', label: 'Система 360', module: 'birdview', state: 'одно устройство' },
    { slot: 'neural', label: 'Техническое зрение', module: 'neural', state: 'по умолчанию' },
    { slot: 'krsps', label: 'АС КРСПС', module: 'krsps', state: 'по умолчанию' },
];

export const CAMERA_ROWS: RoutingRow[] = [
    { slot: 'cameras', label: 'Новые камеры создаются на', module: null, state: 'по умолчанию' },
];

export const routingCandidates = (devices: Device[], row: RoutingRow): Device[] =>
    row.module ? devices.filter(d => d.modules.includes(row.module!)) : devices;

export const sameRouting = (a: RoutingTable, b: RoutingTable): boolean =>
    (Object.keys(a) as RoutingSlot[]).every(slot => a[slot] === b[slot]);
