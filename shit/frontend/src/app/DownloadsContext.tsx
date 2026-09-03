import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { useSystem } from './SystemContext';
import type { ExportRequest, JobProgress } from '../screens/archive/model';
import {
    browserDownload, fetchJobs, jobCancelUrl, jobDownloadUrl, jobProgressUrl, startCut,
} from '../screens/archive/model';

// Склейка, идущая на устройстве; результат скачивает сам браузер
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
}

interface DownloadsValue {
    items: Download[];
    // Доля от нуля до единицы по всем незавершённым задачам
    overall: number;
    start: (deviceId: string, request: ExportRequest) => Promise<void>;
    cancel: (id: string) => void;
    dismiss: (id: string) => void;
    save: (id: string) => void;
}

const DownloadsContext = createContext<DownloadsValue>({
    items: [],
    overall: 0,
    start: async () => undefined,
    cancel: () => undefined,
    dismiss: () => undefined,
    save: () => undefined,
});

export const useDownloads = () => useContext(DownloadsContext);

const DONE = ['ready', 'failed', 'cancelled'];

export const isFinished = (item: Download) => DONE.includes(item.status);

function blank(id: string, deviceId: string, title: string, subtitle: string): Download {
    return {
        id, deviceId, title, subtitle,
        status: 'queued', progress: 0, message: '',
        filesTotal: 0, filesDone: 0, bytes: 0, filename: '',
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

    const start = useCallback(async (deviceId: string, request: ExportRequest) => {
        const { job_id } = await startCut(deviceId, request);
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

    // Файл забирает браузер; устройство удалит результат само после отдачи
    const save = useCallback((id: string) => {
        const item = items.find(value => value.id === id);
        if (!item) return;
        browserDownload(jobDownloadUrl(item.deviceId, id));
        dismiss(id);
    }, [dismiss, items]);

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
