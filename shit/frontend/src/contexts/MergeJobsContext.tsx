import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import type { MergeJobInfo } from '../components/MergeJobPanel';
import { getDevices, storagePath } from '../services/devices';

interface MergeJobsContextValue {
    activeJob: MergeJobInfo | null;
    minimized: boolean;
    downloading: boolean;
    downloadProgress: number;

    // Запуск новой джобы на storage-service устройства камеры
    startJob: (deviceId: string, endpoint: string, body: any) => Promise<void>;
    cancelJob: () => Promise<void>;
    saveAs: () => Promise<void>;

    setMinimized: (v: boolean) => void;
    cancelDownload: () => void;
}

const MergeJobsContext = createContext<MergeJobsContextValue | null>(null);

export const useMergeJobs = () => {
    const ctx = useContext(MergeJobsContext);
    if (!ctx) throw new Error('useMergeJobs must be used inside MergeJobsProvider');
    return ctx;
};

export const MergeJobsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [activeJob, setActiveJob] = useState<MergeJobInfo | null>(null);
    const [minimized, setMinimized] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);

    const wsRef = useRef<WebSocket | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    // Устройство активной джобы — все её ручки живут на его storage-service
    const jobDeviceRef = useRef<string | null>(null);

    const attachToJob = useCallback((deviceId: string, jobId: string) => {
        if (wsRef.current) {
            try { wsRef.current.close(); } catch {}
        }
        jobDeviceRef.current = deviceId;
        const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(
            `${wsProto}//${location.host}${storagePath(deviceId, `/api/recordings/jobs/${jobId}/progress`)}`
        );
        wsRef.current = ws;

        ws.onmessage = (e) => {
            const ev = JSON.parse(e.data);
            setActiveJob({
                id: jobId,
                status: ev.status,
                progress: ev.progress,
                message: ev.message,
                files_total: ev.files_total ?? 0,
                files_processed: ev.files_processed ?? 0,
                bytes_total: ev.bytes_total ?? 0,
                duration_seconds: ev.duration_seconds ?? 0,
                result_filename: ev.result_filename,
                result_media_type: ev.result_media_type,
            });
        };
        ws.onclose = () => { wsRef.current = null; };
    }, []);

    // Восстановление активной задачи при загрузке приложения: джоба могла
    // остаться на storage-service любого устройства
    useEffect(() => {
        const restore = async () => {
            for (const device of getDevices()) {
                try {
                    const res = await fetch(storagePath(device.id, '/api/recordings/jobs'));
                    if (!res.ok) continue;
                    const data = await res.json();
                    const active = data.jobs?.[0];
                    if (active) {
                        setActiveJob({
                            id: active.id,
                            status: active.status,
                            progress: active.progress,
                            message: active.message,
                            files_total: active.files_total ?? 0,
                            files_processed: active.files_processed ?? 0,
                            bytes_total: active.bytes_total ?? 0,
                            duration_seconds: 0,
                        });
                        attachToJob(device.id, active.id);
                        return;
                    }
                } catch {}
            }
        };
        restore();
        return () => {
            if (wsRef.current) wsRef.current.close();
        };
    }, [attachToJob]);

    const startJob = useCallback(async (deviceId: string, endpoint: string, body: any) => {
        const res = await fetch(storagePath(deviceId, endpoint), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { job_id } = await res.json();

        setActiveJob({
            id: job_id, status: 'pending', progress: 0, message: 'Запуск...',
            files_total: 0, files_processed: 0, bytes_total: 0, duration_seconds: 0,
        });
        setMinimized(false);
        attachToJob(deviceId, job_id);
    }, [attachToJob]);

    const jobPath = (jobId: string, suffix = '') =>
        storagePath(jobDeviceRef.current ?? '', `/api/recordings/jobs/${jobId}${suffix}`);

    const cancelJob = useCallback(async () => {
        if (!activeJob) return;
        try {
            await fetch(jobPath(activeJob.id), { method: 'DELETE' });
        } catch {}
        if (wsRef.current) wsRef.current.close();
        setActiveJob(null);
        setDownloading(false);
        setDownloadProgress(0);
    }, [activeJob]);

    const saveAs = useCallback(async () => {
        if (!activeJob || activeJob.status !== 'ready') return;
        setDownloading(true);
        setDownloadProgress(0);

        const controller = new AbortController();
        abortControllerRef.current = controller;

        try {
            const { downloadWithProgress } = await import('../utils/downloadWithProgress');
            const filename = activeJob.result_filename || `result_${activeJob.id.slice(0, 8)}`;
            const mime = activeJob.result_media_type || 'application/octet-stream';
            await downloadWithProgress(
                jobPath(activeJob.id, '/download'),
                filename,
                mime,
                (p) => setDownloadProgress(p),
                controller.signal,           // ← новый параметр
            );
            setActiveJob(null);
        } catch (err: any) {
            if (err.name === 'AbortError' || err.message === 'Загрузка отменена') {
                // Тихое отмена пользователем — удаляем job на сервере
                try {
                    await fetch(jobPath(activeJob.id), { method: 'DELETE' });
                } catch {}
                setActiveJob(null);
            } else {
                alert(`Ошибка скачивания: ${err.message}`);
            }
        } finally {
            setDownloading(false);
            setDownloadProgress(0);
            abortControllerRef.current = null;
        }
    }, [activeJob]);

    const cancelDownload = useCallback(() => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
    }, []);

    return (
        <MergeJobsContext.Provider value={{
            activeJob, minimized, downloading, downloadProgress,
            startJob, cancelJob, saveAs, setMinimized,
            cancelDownload,                                    // ← новое
        }}>
            {children}
        </MergeJobsContext.Provider>
    );
};