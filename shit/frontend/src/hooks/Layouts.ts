/**
 * src/hooks/useLayouts.ts
 */

import { useState, useEffect, useCallback, useRef } from 'react';

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
    // Камеры birdview с включённой коррекцией дисторсии на момент сохранения
    corrections?: Record<string, boolean>;
    // Показываемый поток камеры: { cameraId: 'stream_2' }
    streams?: Record<string, string>;
    // Рамки обнаружений поверх кадра: { cameraId: true }
    detections?: Record<string, boolean>;
    // Наложения на всё отображение: имя камеры, время, рамки
    overlays?: Record<string, boolean>;
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

async function apiGetLayouts() {
    let res: Response;
    try {
        res = await fetch('/api/layouts');
    } catch {
        throw new Error('Нет связи с сервером при загрузке сеток');
    }
    if (!res.ok) throw new Error(httpMsg(res.status, 'загрузке сеток'));
    const profileId = res.headers.get('X-Profile-Id');
    const context = res.headers.get('X-Layout-Context');
    const phase = res.headers.get('X-Profile-Phase');
    if (profileId === null || !context || !phase)
        throw new Error('Для работы с отображениями профиля нужно обновить сервер.');
    const data = await res.json();
    return { data: (Array.isArray(data) ? data : []) as SavedLayout[], profileId, context, blocked: phase !== 'complete' };
}

async function apiUpsertLayout(layout: SavedLayout, context: string): Promise<{ data: SavedLayout | null; error: string | null }> {
    try {
        const res = await fetch(`/api/layouts?context=${encodeURIComponent(context)}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(layout),
        });
        if (!res.ok) return { data: null, error: res.status === 409 ? 'Профиль изменился или переключается. Обновите раскладки перед сохранением.' : httpMsg(res.status, 'сохранении сетки') };
        return { data: await res.json(), error: null };
    } catch {
        return { data: null, error: 'Не удалось сохранить сетку — нет связи с сервером' };
    }
}

async function apiDeleteLayout(name: string, context: string): Promise<{ error: string | null }> {
    try {
        const res = await fetch(`/api/layouts/${encodeURIComponent(name)}?context=${encodeURIComponent(context)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404)
            return { error: res.status === 409 ? 'Профиль изменился или переключается. Обновите раскладки перед удалением.' : httpMsg(res.status, 'удалении сетки') };
        return { error: null };
    } catch {
        return { error: 'Не удалось удалить сетку — нет связи с сервером' };
    }
}

// ── Hook ──────────────────────────────────────────────────────

export function useLayouts() {
    const [layouts, setLayouts] = useState<SavedLayout[]>([]);
    const [loading, setLoading] = useState(true);
    const [identity, setIdentity] = useState({ profileId: '', context: '' });
    const [blocked, setBlocked] = useState(false);
    const generation = useRef(0);
    const current = useRef({ context: '', blocked: true });
    // loadError — ошибка начальной загрузки (показывается в UI как предупреждение)
    const [loadError, setLoadError] = useState<string>('');
    // opError — ошибка save/remove (показывается кратко рядом с действием)
    const [opError, setOpError] = useState<string>('');

    const load = useCallback(async () => {
        const request = ++generation.current;
        try {
            const result = await apiGetLayouts();
            if (request !== generation.current) return;
            current.current.blocked = result.blocked;
            setBlocked(result.blocked);
            setLoadError(result.blocked ? 'Идёт смена профиля. Раскладки обновятся после её завершения.' : '');
            if (!result.blocked) {
                current.current.context = result.context;
                setIdentity(prev => prev.context === result.context ? prev : { profileId: result.profileId, context: result.context });
                setLayouts(prev => JSON.stringify(prev) === JSON.stringify(result.data) ? prev : result.data);
            }
        } catch (error) {
            if (request !== generation.current) return;
            setLoadError(error instanceof Error ? error.message : 'Ошибка загрузки раскладок');
            setBlocked(true);
            current.current.blocked = true;
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        void load();
        const timer = window.setInterval(load, 2000);
        return () => { window.clearInterval(timer); generation.current += 1; };
    }, [load]);

    const save = useCallback(async (layout: SavedLayout, context = identity.context): Promise<boolean> => {
        setOpError('');
        if (blocked || !identity.profileId || context !== identity.context) {
            setOpError('Профиль изменился или переключается. Черновик остался в прежнем профиле.');
            return false;
        }
        generation.current += 1;
        const { data, error } = await apiUpsertLayout(layout, context);
        if (current.current.context !== context || current.current.blocked) {
            setOpError('Профиль изменился во время сохранения. Откройте его для проверки результата.');
            return false;
        }
        if (error) { setOpError(error); return false; }
        if (!data) return false;
        setLayouts(prev => {
            const idx = prev.findIndex(l => l.name === data.name);
            if (idx >= 0) { const next = [...prev]; next[idx] = data; return next; }
            return [...prev, data];
        });
        return true;
    }, [identity, blocked]);

    const remove = useCallback(async (name: string, context = identity.context): Promise<boolean> => {
        setOpError('');
        if (blocked || !identity.profileId || context !== identity.context) {
            setOpError('Профиль изменился или переключается. Удаление отменено.');
            return false;
        }
        generation.current += 1;
        const { error } = await apiDeleteLayout(name, context);
        if (current.current.context !== context || current.current.blocked) {
            setOpError('Профиль изменился во время удаления. Откройте его для проверки результата.');
            return false;
        }
        if (error) { setOpError(error); return false; }
        setLayouts(prev => prev.filter(l => l.name !== name));
        return true;
    }, [identity, blocked]);

    const clearOpError = useCallback(() => setOpError(''), []);

    return { layouts, loading, ...identity, blocked, loadError, opError, clearOpError, reload: load, save, remove };
}

export const lastLayoutKey = (profileId: string) => `live.layout.${profileId}`;
