import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
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
    // Внеочередное чтение реестра: после правки устройства ждать опроса незачем
    refreshDevices: () => Promise<void>;
}

const DEVICES_POLL_MS = 10_000;

const SystemContext = createContext<SystemContextValue>({
    connected: false,
    cameras: [],
    devices: [],
    refreshDevices: async () => {},
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

    const refreshDevices = useCallback(async () => {
        await loadDevices().catch(() => {});
        setDevices(getDevices());
    }, []);

    useEffect(() => {
        void refreshDevices();
        const timer = window.setInterval(() => void refreshDevices(), DEVICES_POLL_MS);
        return () => window.clearInterval(timer);
    }, [refreshDevices]);

    const value = useMemo(
        () => ({ connected, cameras: state.cameras ?? [], devices, refreshDevices }),
        [connected, state.cameras, devices, refreshDevices],
    );

    return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}
