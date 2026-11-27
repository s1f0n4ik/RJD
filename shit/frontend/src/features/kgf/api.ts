import type { PeripheralSnapshot, PeripheralStatus, PeripheralValue } from './types';

const BASE = '/api/peripherals';

async function read<T>(path: string): Promise<T> {
    const response = await fetch(`${BASE}${path}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<T>;
}

export async function getPeripheralSnapshot(): Promise<PeripheralSnapshot> {
    const [status, values] = await Promise.all([
        read<PeripheralStatus>('/status'),
        read<PeripheralValue[]>('/values'),
    ]);
    return { status, values };
}

export function createPeripheralScanSocket(deviceId: string): WebSocket {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = `${BASE}/ws/scans/${encodeURIComponent(deviceId)}`;
    return new WebSocket(`${scheme}//${window.location.host}${path}`);
}
