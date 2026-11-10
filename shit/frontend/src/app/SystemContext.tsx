import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { wsService } from '../services/websocket';
import { applyDevices, getDevices, loadDevices, type Device } from '../services/devices';
import type { GatewaySummary, NeuralSummary } from '../screens/home/useHomeData';
import type { CPPCamera, LinkerSnapshot, SystemState } from '../types';

/**
 * Живое состояние системы для новой оболочки: камеры, устройства и сводки
 * приходят одним потоком по WebSocket. Один источник на всё приложение —
 * иначе каждый экран поднимал бы свой сокет.
 */
interface SystemContextValue {
    connected: boolean;
    // Связь была и оборвалась: всё ниже — последние известные данные
    lost: boolean;
    cameras: CPPCamera[];
    devices: Device[];
    // undefined — сводка ещё не приходила, null — источник не ответил
    neural: NeuralSummary | null | undefined;
    gateway: GatewaySummary | null | undefined;
    linker: LinkerSnapshot | null | undefined;
    // Внеочередное чтение реестра: после правки устройства ждать следующего сообщения незачем
    refreshDevices: () => Promise<void>;
}

const SystemContext = createContext<SystemContextValue>({
    connected: false,
    lost: false,
    cameras: [],
    devices: [],
    neural: undefined,
    gateway: undefined,
    linker: undefined,
    refreshDevices: async () => {},
});

export const useSystem = () => useContext(SystemContext);

export function SystemProvider({ children }: { children: React.ReactNode }) {
    const [connected, setConnected] = useState(false);
    const [lost, setLost] = useState(false);
    const everConnected = useRef(false);
    const [state, setState] = useState<SystemState>({ cameras: [], loaders: [] });
    const [devices, setDevices] = useState<Device[]>(getDevices());

    const onConnection = useCallback((up: boolean) => {
        setConnected(up);
        if (up) {
            everConnected.current = true;
            setLost(false);
        } else if (everConnected.current) {
            setLost(true);
        }
    }, []);

    const onState = useCallback((next: SystemState) => {
        if (next.devices) {
            applyDevices(next.devices, next.routing);
            setDevices(getDevices());
        }
        setState(next);
    }, []);

    useEffect(() => {
        wsService.connect(onState, onConnection);
        return () => wsService.disconnect();
    }, [onState, onConnection]);

    const refreshDevices = useCallback(async () => {
        await loadDevices().catch(() => {});
        setDevices(getDevices());
    }, []);

    // Первое чтение до первого сообщения сокета
    useEffect(() => {
        void refreshDevices();
    }, [refreshDevices]);

    const value = useMemo(
        () => ({
            connected,
            lost,
            cameras: state.cameras ?? [],
            devices,
            neural: state.neural,
            gateway: state.gateway,
            linker: state.linker,
            refreshDevices,
        }),
        [connected, lost, state.cameras, state.neural, state.gateway, state.linker, devices, refreshDevices],
    );

    return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}
