import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { wsService } from '../services/websocket';
import { getDevices, loadDevices, type Device } from '../services/devices';
import type { CPPCamera, SystemState } from '../types';

/**
 * Живое состояние системы для новой оболочки: камеры приходят по WebSocket,
 * реестр устройств опрашивается по таймеру. Один источник на всё приложение —
 * иначе каждый экран поднимал бы свой сокет.
 */
interface SystemContextValue {
    connected: boolean;
    cameras: CPPCamera[];
    devices: Device[];
}

const DEVICES_POLL_MS = 10_000;

const SystemContext = createContext<SystemContextValue>({
    connected: false,
    cameras: [],
    devices: [],
});

export const useSystem = () => useContext(SystemContext);

export function SystemProvider({ children }: { children: React.ReactNode }) {
    const [connected, setConnected] = useState(false);
    const [state, setState] = useState<SystemState>({ cameras: [], loaders: [] });
    const [devices, setDevices] = useState<Device[]>(getDevices());

    useEffect(() => {
        wsService.connect(setState, setConnected);
        return () => wsService.disconnect();
    }, []);

    useEffect(() => {
        let alive = true;
        const refresh = () => {
            loadDevices()
                .then(() => { if (alive) setDevices(getDevices()); })
                .catch(() => {});
        };
        refresh();
        const timer = window.setInterval(refresh, DEVICES_POLL_MS);
        return () => { alive = false; window.clearInterval(timer); };
    }, []);

    const value = useMemo(
        () => ({ connected, cameras: state.cameras ?? [], devices }),
        [connected, state.cameras, devices],
    );

    return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}
