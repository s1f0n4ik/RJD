/**
 * src/hooks/useLayouts.ts
 *
 * Хук для работы с сетками через серверный API (/api/layouts).
 * Полностью заменяет localStorage.
 */

import { useState, useEffect, useCallback } from 'react';

// ── Types (дублируем здесь, чтобы не тащить из компонентов) ──

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
    timestamp: number;
}

// ── API helpers ───────────────────────────────────────────────

async function apiGetLayouts(): Promise<SavedLayout[]> {
    const res = await fetch('/api/layouts');
    if (!res.ok) throw new Error(`GET /api/layouts → ${res.status}`);
    return res.json();
}

async function apiUpsertLayout(layout: SavedLayout): Promise<SavedLayout> {
    const res = await fetch('/api/layouts', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(layout),
    });
    if (!res.ok) throw new Error(`POST /api/layouts → ${res.status}`);
    return res.json();
}

async function apiDeleteLayout(name: string): Promise<void> {
    const res = await fetch(`/api/layouts/${encodeURIComponent(name)}`, {
        method: 'DELETE',
    });
    if (!res.ok && res.status !== 404)
        throw new Error(`DELETE /api/layouts/${name} → ${res.status}`);
}

// ── Hook ──────────────────────────────────────────────────────

export function layouts() {
    const [layouts, setLayouts]   = useState<SavedLayout[]>([]);
    const [loading, setLoading]   = useState(true);
    const [error, setError]       = useState<string>('');

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await apiGetLayouts();
            setLayouts(data);
            setError('');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const save = useCallback(async (layout: SavedLayout): Promise<void> => {
        const updated = await apiUpsertLayout(layout);
        setLayouts(prev => {
            const idx = prev.findIndex(l => l.name === updated.name);
            if (idx >= 0) {
                const next = [...prev];
                next[idx] = updated;
                return next;
            }
            return [...prev, updated];
        });
    }, []);

    const remove = useCallback(async (name: string): Promise<void> => {
        await apiDeleteLayout(name);
        setLayouts(prev => prev.filter(l => l.name !== name));
    }, []);

    return { layouts, loading, error, reload: load, save, remove };
}