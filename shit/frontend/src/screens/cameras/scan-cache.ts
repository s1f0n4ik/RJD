// Находка ONVIF-опроса
export interface OnvifFound {
    ip: string;
    port: number;
    name?: string;
    model?: string;
    manufacturer?: string;
}

// Находка порт-скана
export interface PortFound {
    ip: string;
    open_ports: number[];
    has_rtsp: boolean;
    vendor?: string;
}

// Законченный поиск: подсеть, время и обе выдачи
export interface ScanSnapshot {
    subnet: string;
    at: number;
    onvif: OnvifFound[];
    ports: PortFound[];
}

const STORAGE_KEY = 'cameras.last-scan';

const isSnapshot = (value: unknown): value is ScanSnapshot => {
    const v = value as ScanSnapshot | null;
    return !!v && typeof v.subnet === 'string' && typeof v.at === 'number'
        && Array.isArray(v.onvif) && Array.isArray(v.ports);
};

export function loadScan(): ScanSnapshot | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        return isSnapshot(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function saveScan(snapshot: ScanSnapshot): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch { /* хранилище браузера недоступно */ }
}

/** «14:32» для сегодняшнего поиска, «6 нояб., 14:32» для прежнего. */
export function scanTimeLabel(at: number): string {
    const date = new Date(at);
    const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (date.toDateString() === new Date().toDateString()) return time;
    return `${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${time}`;
}
