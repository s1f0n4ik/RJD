import { useEffect, useState } from 'react';
import { moduleDeviceId, storagePath, type Device } from '../../services/devices';
import { journalApi } from '../../features/neural/api/journal';
import type { JournalDetection } from '../../features/neural/api/journal-types';

/** Диск устройства как его отдаёт storage-service; null — служба не ответила. */
export interface DiskState {
    path: string;
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

/**
 * Последние обнаружения. Модуль технического зрения может быть не поднят —
 * тогда список пуст и блок на экран не попадает.
 */
export function useLastDetections(limit = 4) {
    const [items, setItems] = useState<JournalDetection[]>([]);
    const [available, setAvailable] = useState(false);

    useEffect(() => {
        let alive = true;

        const load = async () => {
            if (!moduleDeviceId('neural')) {
                if (alive) { setAvailable(false); setItems([]); }
                return;
            }
            try {
                const res = await journalApi.list({}, { limit });
                if (alive) { setItems(res.detections ?? []); setAvailable(true); }
            } catch {
                if (alive) { setAvailable(false); setItems([]); }
            }
        };

        load();
        const timer = window.setInterval(load, JOURNAL_POLL_MS);
        return () => { alive = false; window.clearInterval(timer); };
    }, [limit]);

    return { items, available };
}
