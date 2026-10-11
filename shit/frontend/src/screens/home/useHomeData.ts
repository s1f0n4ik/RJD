import { useEffect, useMemo, useState } from 'react';
import { useNeuralStatus } from '../../app/neuralStatus';
import { modulePath, storagePath, type Device } from '../../services/devices';
import { journalApi } from '../../features/neural/api/journal';
import type { JournalDetection } from '../../features/neural/api/journal-types';

/** Диск устройства как его отдаёт storage-service; null — служба не ответила. */
export interface DiskState {
    path: string;
    total_bytes: number;
    used_bytes: number;
    records_bytes: number;
    /** Кадры и база журнала обнаружений; резерв — их лимиты, 0 без нейронного модуля */
    journal_bytes: number;
    journal_reserve_bytes: number;
    total_gb: number;
    used_gb: number;
    free_gb: number;
    records_gb: number;
    used_percent: number;
    max_used_percent: number;
}

const DISK_POLL_MS = 20_000;
const JOURNAL_POLL_MS = 15_000;

/** Диски всех устройств: ключ — id устройства. */
export function useDisks(devices: Device[]) {
    const [disks, setDisks] = useState<Record<string, DiskState | null>>({});

    const ids = devices.map(d => d.id).join(',');
    useEffect(() => {
        if (!ids) return;
        let alive = true;

        const load = async () => {
            const result: Record<string, DiskState | null> = {};
            await Promise.all(ids.split(',').map(async id => {
                try {
                    const res = await fetch(storagePath(id, '/api/recordings/disk'));
                    if (!res.ok) throw new Error(String(res.status));
                    result[id] = await res.json();
                } catch {
                    result[id] = null;
                }
            }));
            if (alive) setDisks(result);
        };

        load();
        const timer = window.setInterval(load, DISK_POLL_MS);
        return () => { alive = false; window.clearInterval(timer); };
    }, [ids]);

    return disks;
}

// Последние обнаружения журнала мастера; мастер не ответил — блок на экран не попадает
export function useLastDetections(limit = 4) {
    const [items, setItems] = useState<JournalDetection[]>([]);
    const [available, setAvailable] = useState(false);
    // Первый ответ журнала получен, каким бы он ни был
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let alive = true;

        const load = async () => {
            try {
                const res = await journalApi.list({}, { limit });
                if (alive) { setItems(res.detections ?? []); setAvailable(true); }
            } catch {
                if (alive) { setAvailable(false); setItems([]); }
            }
            if (alive) setLoaded(true);
        };

        load();
        const timer = window.setInterval(load, JOURNAL_POLL_MS);
        return () => { alive = false; window.clearInterval(timer); };
    }, [limit]);

    return { items, available, loaded };
}

/** Сводка шлюза КРСПС для плитки: null — шлюз не ответил. */
export interface GatewaySummary {
    modules: number;
    connected: number;
}

export function useGatewayStatus() {
    const [summary, setSummary] = useState<GatewaySummary | null>(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await fetch('/api/gateway/status');
                if (!res.ok) throw new Error(String(res.status));
                const data = await res.json() as { modules?: Array<{ connection?: { connected?: boolean } }> };
                const modules = data.modules ?? [];
                if (alive) setSummary({ modules: modules.length, connected: modules.filter(m => m.connection?.connected).length });
            } catch {
                if (alive) setSummary(null);
            }
        })();
        return () => { alive = false; };
    }, []);

    return summary;
}

/** Сводка слотов техзрения по всем платам с neural */
export interface NeuralSummary {
    devices: number;
    // Платы, ответившие слотами
    ok: number;
    slots: number;
    running: number;
    failed: number;
    offline: number;
    missing: number;
}

// undefined — ответа ещё не было, null — мастер не ответил
export function useNeuralSummary(): NeuralSummary | null | undefined {
    const status = useNeuralStatus();
    return useMemo(() => {
        if (!status) return status;
        const slots = status.flatMap(d => d.slots ?? []);
        return {
            devices: status.length,
            ok: status.filter(d => d.state === 'ok').length,
            slots: slots.length,
            running: slots.filter(s => s.running).length,
            failed: slots.filter(s => s.code !== 0).length,
            offline: status.filter(d => d.state === 'offline').length,
            missing: status.filter(d => d.state === 'no_module').length,
        };
    }, [status]);
}

const plural = (n: number, one: string, few: string, many: string) => {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
};

/** Подпись плитки техзрения: части с нулём не пишутся */
export function neuralSummaryParts(s: NeuralSummary | null | undefined): string[] {
    if (!s) return ['модуль не отвечает'];
    if (!s.devices) return ['модуль не назначен'];
    const parts = [
        s.running ? `${s.running} ${plural(s.running, 'слот', 'слота', 'слотов')} в работе` : '',
        s.failed ? `${s.failed} с ошибкой` : '',
        s.offline ? `${s.offline} ${plural(s.offline, 'плата', 'платы', 'плат')} не в сети` : '',
        s.missing ? `${s.missing} без модуля` : '',
    ].filter(Boolean);
    return parts.length ? parts : [s.slots ? 'обработка остановлена' : 'слотов нет'];
}

/** Плитка гаснет, только если не ответила ни одна плата */
export const neuralSummaryOff = (s: NeuralSummary | null | undefined) => !s || !s.devices || !s.ok;

/** Сводка вывода 360 для плитки: null — устройство модуля не ответило */
export interface LinkerSummary {
    running: boolean;
    viewMode: string;
    /** Оба вида идут своими потоками */
    dualOutput: boolean;
}

export function useLinkerStatus() {
    // undefined — ответа ещё не было, null — устройство модуля не ответило
    const [summary, setSummary] = useState<LinkerSummary | null | undefined>(undefined);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await fetch(modulePath('birdview', '/linker/status'));
                if (!res.ok) throw new Error(String(res.status));
                type Raw = { running?: boolean; view_mode?: string; dual_output?: boolean };
                const json = await res.json() as { data?: Raw } & Raw;
                const data = json.data ?? json;
                if (alive) {
                    setSummary({
                        running: Boolean(data.running),
                        viewMode: data.view_mode ?? 'top',
                        dualOutput: Boolean(data.dual_output),
                    });
                }
            } catch {
                if (alive) setSummary(null);
            }
        })();
        return () => { alive = false; };
    }, []);

    return summary;
}
