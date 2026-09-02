import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { useSystem } from './SystemContext';
import type { ExportRequest, JobProgress } from '../screens/archive/model';
import {
    fetchJobs, jobCancelUrl, jobDownloadUrl, jobProgressUrl, startCut, startZip,
} from '../screens/archive/model';

// Выгрузка, идущая на устройстве, вместе с ходом скачивания результата
export interface Download {
    id: string;
    deviceId: string;
    title: string;
    subtitle: string;
    status: string;
    progress: number;
    message: string;
    error?: string | null;
    filesTotal: number;
    filesDone: number;
    bytes: number;
    filename: string;
    saving: boolean;
    savingProgress: number;
}

interface DownloadsValue {
    items: Download[];
    // Доля от нуля до единицы по всем незавершённым задачам
    overall: number;
    start: (deviceId: string, kind: 'cut' | 'zip', request: ExportRequest) => Promise<void>;
    cancel: (id: string) => void;
    dismiss: (id: string) => void;
    save: (id: string) => Promise<void>;
}

const DownloadsContext = createContext<DownloadsValue>({
    items: [],
    overall: 0,
    start: async () => undefined,
    cancel: () => undefined,
    dismiss: () => undefined,
    save: async () => undefined,
});

export const useDownloads = () => useContext(DownloadsContext);

const DONE = ['ready', 'failed', 'cancelled'];

export const isFinished = (item: Download) => DONE.includes(item.status);

function blank(id: string, deviceId: string, title: string, subtitle: string): Download {
    return {
        id, deviceId, title, subtitle,
        status: 'queued', progress: 0, message: '',
        filesTotal: 0, filesDone: 0, bytes: 0, filename: '',
        saving: false, savingProgress: 0,
    };
}

export function DownloadsProvider({ children }: { children: React.ReactNode }) {
    const { devices } = useSystem();
    const [items, setItems] = useState<Download[]>([]);
    const restored = useRef(false);
    const sockets = useRef(new Map<string, WebSocket>());

    const patch = useCallback((id: string, next: Partial<Download>) => {
        setItems(list => list.map(item => (item.id === id ? { ...item, ...next } : item)));
    }, []);

    const apply = useCallback((id: string, event: JobProgress) => {
        patch(id, {
            status: event.status,
            progress: event.progress ?? 0,
            message: event.message ?? '',
            error: event.error,
            filesTotal: event.files_total ?? 0,
            filesDone: event.files_processed ?? 0,
            bytes: event.bytes_total ?? 0,
            filename: event.result_filename ?? '',
        });
    }, [patch]);

    const listen = useCallback((id: string, deviceId: string) => {
        if (sockets.current.has(id)) return;

        const socket = new WebSocket(jobProgressUrl(deviceId, id));
        sockets.current.set(id, socket);

        socket.onmessage = event => apply(id, JSON.parse(event.data) as JobProgress);
        socket.onerror = () => patch(id, { status: 'failed', error: 'связь с устройством потеряна' });
        socket.onclose = () => sockets.current.delete(id);
    }, [apply, patch]);

    // Задача живёт на устройстве и переживает перезагрузку страницы
    useEffect(() => {
        if (restored.current || !devices.length) return;
        restored.current = true;

        let alive = true;

        Promise.all(devices.map(device =>
            fetchJobs(device.id)
                .then(data => data.jobs.map(job => ({ device: device.id, job })))
                .catch(() => []),
        )).then(found => {
            if (!alive) return;

            const list = found.flat().map(({ device, job }) => ({
                ...blank(job.id, device, job.title || 'Выгрузка', job.subtitle || ''),
                status: job.status,
                progress: job.progress ?? 0,
                message: job.message ?? '',
                filesTotal: job.files_total ?? 0,
                filesDone: job.files_processed ?? 0,
                bytes: job.bytes_total ?? 0,
                filename: job.result_filename ?? '',
            }));

            setItems(list);
            list.forEach(item => listen(item.id, item.deviceId));
        });

        return () => { alive = false; };
    }, [devices, listen]);

    useEffect(() => () => {
        sockets.current.forEach(socket => socket.close());
        sockets.current.clear();
    }, []);

    const start = useCallback(async (
        deviceId: string,
        kind: 'cut' | 'zip',
        request: ExportRequest,
    ) => {
        const { job_id } = await (kind === 'cut' ? startCut : startZip)(deviceId, request);
        setItems(list => [...list, blank(job_id, deviceId, request.title, request.subtitle)]);
        listen(job_id, deviceId);
    }, [listen]);

    const dismiss = useCallback((id: string) => {
        sockets.current.get(id)?.close();
        sockets.current.delete(id);
        setItems(list => list.filter(item => item.id !== id));
    }, []);

    const cancel = useCallback((id: string) => {
        const item = items.find(value => value.id === id);
        if (item) fetch(jobCancelUrl(item.deviceId, id), { method: 'DELETE' }).catch(() => undefined);
        dismiss(id);
    }, [dismiss, items]);

    // Результат тянется потоком: архив на гигабайты едет с платы заметное время
    const save = useCallback(async (id: string) => {
        const item = items.find(value => value.id === id);
        if (!item) return;

        patch(id, { saving: true, savingProgress: 0 });

        try {
            const response = await fetch(jobDownloadUrl(item.deviceId, id));
            if (!response.ok || !response.body) throw new Error(String(response.status));

            const total = Number(response.headers.get('content-length')) || 0;
            const reader = response.body.getReader();
            const chunks: BlobPart[] = [];
            let read = 0;

            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                read += value.length;
                if (total) patch(id, { savingProgress: read / total });
            }

            const url = URL.createObjectURL(new Blob(chunks));
            const link = document.createElement('a');
            link.href = url;
            link.download = item.filename || 'archive.zip';
            link.click();
            URL.revokeObjectURL(url);

            dismiss(id);
        } catch (e) {
            patch(id, { saving: false, error: String(e) });
        }
    }, [dismiss, items, patch]);

    const running = items.filter(item => !isFinished(item));
    const overall = running.length
        ? running.reduce((sum, item) => sum + item.progress, 0) / running.length
        : items.length ? 1 : 0;

    return (
        <DownloadsContext.Provider value={{ items, overall, start, cancel, dismiss, save }}>
            {children}
        </DownloadsContext.Provider>
    );
}
