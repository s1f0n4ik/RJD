import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSystem } from '../../app/SystemContext';
import { getRouting, type Device } from '../../services/devices';

const STORAGE_KEY = 'neural-device';

const readStored = (): string | null => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
};
const writeStored = (id: string) => {
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* хранилище браузера недоступно */ }
};

export type DeviceProblem = 'none' | 'notfound' | 'nomod' | 'offline';

export interface NeuralDevicePick {
    device: Device | null;
    // Устройства с neural в последнем известном списке модулей, не в сети — тоже
    candidates: Device[];
    problem: DeviceProblem | null;
    // id из ?device=, если он есть
    asked: string | null;
    select: (id: string) => void;
}

/** Устройство подразделов техзрения: ?device= → запомненное в браузере → устройство по умолчанию */
export function useNeuralDevice(): NeuralDevicePick {
    const { devices } = useSystem();
    const [params, setParams] = useSearchParams();
    const asked = params.get('device');
    const [stored, setStored] = useState(readStored);

    const candidates = devices.filter(d => d.modules.includes('neural'));
    const fallback = candidates.find(d => d.id === getRouting().neural) ?? candidates[0] ?? null;
    // Явный адрес не подменяется; запомненное пропало — тихо берётся устройство по умолчанию
    const device = asked ? devices.find(d => d.id === asked) ?? null : candidates.find(d => d.id === stored) ?? fallback;
    const usable = !!device && device.modules.includes('neural');

    const problem: DeviceProblem | null =
        asked && !device ? 'notfound'
            : asked && !usable ? 'nomod'
                : !device ? 'none'
                    : device.status !== 'online' ? 'offline'
                        : null;

    // Явный ?device= с модулем запоминается: рельса и соседние подразделы его не теряют
    useEffect(() => {
        if (asked && usable) {
            writeStored(asked);
            setStored(asked);
        }
    }, [asked, usable]);

    const select = (id: string) => {
        writeStored(id);
        setStored(id);
        if (asked) {
            const next = new URLSearchParams(params);
            next.delete('device');
            setParams(next, { replace: true });
        }
    };

    return { device, candidates, problem, asked, select };
}
