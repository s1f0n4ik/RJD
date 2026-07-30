/**
 * src/hooks/useLayouts.ts
 */

import { useState, useEffect, useCallback } from 'react';

export interface CustomCell {
    id: string;
    row: number;
    col: number;
    rowSpan: number;
    colSpan: number;
}

export interface SavedLayout {
    name: string;
    gridSize: number | 'custom' | 'single';
    customCells?: CustomCell[];
    customGridRows?: number;
    customGridCols?: number;
    activeCells: Record<string, string>;
    // Состояние вывода 360 на момент сохранения; киоск применяет при загрузке
    surround?: { viewMode: 'top' | 'surround'; manual: boolean };
    timestamp: number;
}

// Человекочитаемое сообщение по статусу ответа
function httpMsg(status: number, action: string): string {
    if (status === 404) return `Эндпоинт ${action} не найден (404) — роутер layouts не подключён?`;
    if (status === 422) return `Ошибка валидации данных (422)`;
    if (status === 503) return `Сервер недоступен (503)`;
    return `Ошибка ${status} при ${action}`;
}

// ── API helpers — никогда не бросают, возвращают { data | null, error | null } ──

async function apiGetLayouts(): Promise<{ data: SavedLayout[] | null; error: string | null }> {
    try {
        const res = await fetch('/api/layouts');
        if (!res.ok) return { data: null, error: httpMsg(res.status, 'загрузке сеток') };
        const data = await res.json();
        return { data: Array.isArray(data) ? data : [], error: null };
    } catch {
        return { data: null, error: 'Нет связи с сервером при загрузке сеток' };
    }
}

async function apiUpsertLayout(layout: SavedLayout): Promise<{ data: SavedLayout | null; error: string | null }> {
    try {
        const res = await fetch('/api/layouts', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(layout),
        });
        if (!res.ok) return { data: null, error: httpMsg(res.status, 'сохранении сетки') };
        return { data: await res.json(), error: null };
    } catch {
        return { data: null, error: 'Не удалось сохранить сетку — нет связи с сервером' };
    }
}

async function apiDeleteLayout(name: string): Promise<{ error: string | null }> {
    try {
        const res = await fetch(`/api/layouts/${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404)
            return { error: httpMsg(res.status, 'удалении сетки') };
        return { error: null };
    } catch {
        return { error: 'Не удалось удалить сетку — нет связи с сервером' };
    }
}

// ── Hook ──────────────────────────────────────────────────────

export function useLayouts() {
    const [layouts, setLayouts] = useState<SavedLayout[]>([]);
    const [loading, setLoading] = useState(true);
    // loadError — ошибка начальной загрузки (показывается в UI как предупреждение)
    const [loadError, setLoadError] = useState<string>('');
    // opError — ошибка save/remove (показывается кратко рядом с действием)
    const [opError, setOpError] = useState<string>('');

    const load = useCallback(async () => {
        setLoading(true);
        setLoadError('');
        const { data, error } = await apiGetLayouts();
        if (error) {
            setLoadError(error);
            setLayouts([]);          // пустой список — не крашимся
        } else {
            setLayouts(data ?? []);
        }
        setLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    const save = useCallback(async (layout: SavedLayout): Promise<boolean> => {
        setOpError('');
        const { data, error } = await apiUpsertLayout(layout);
        if (error) { setOpError(error); return false; }
        if (!data) return false;
        setLayouts(prev => {
            const idx = prev.findIndex(l => l.name === data.name);
            if (idx >= 0) { const next = [...prev]; next[idx] = data; return next; }
            return [...prev, data];
        });
        return true;
    }, []);

    const remove = useCallback(async (name: string): Promise<boolean> => {
        setOpError('');
        const { error } = await apiDeleteLayout(name);
        if (error) { setOpError(error); return false; }
        setLayouts(prev => prev.filter(l => l.name !== name));
        return true;
    }, []);

    const clearOpError = useCallback(() => setOpError(''), []);

    return { layouts, loading, loadError, opError, clearOpError, reload: load, save, remove };
}