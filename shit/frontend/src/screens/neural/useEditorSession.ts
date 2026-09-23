import { useCallback, useEffect, useRef, useState } from 'react';
import { moduleDeviceId, signalingWsUrl } from '../../services/devices';
import type { TilePlacement, VideoStream } from '../../features/neural/api/types';
import { withCamerasOnly } from './stream-geometry';

// Сессия редактора видеопотока в media-center (neural/input-editor.cpp) через пару брокера

/** Поток полотна, который отдаёт редактор */
export const EDITOR_STREAM_ID = 'neural_editor';

// Правки при перетаскивании уходят не чаще этого, итог — сразу по отпусканию
const UPDATE_INTERVAL_MS = 100;
// Редактор гасит сессию после 30 с тишины
const PING_INTERVAL_MS = 10_000;

export type EditorPhase =
    | 'connecting' // сокет открывается или брокер ещё не выдал сессию
    | 'busy'       // редактором пользуется другой клиент, брокер спрашивает о перехвате
    | 'opening'    // сессия наша, ждём ответа на open
    | 'open'       // полотно собирается, правки принимаются
    | 'closed';    // сокет закрыт или редактор погасил сессию

export interface EditorSession {
    phase: EditorPhase;
    /** Причина последнего отказа или закрытия; null — всё в порядке */
    error: string | null;
    /** Размер полотна от редактора; null — сессия не открыта */
    size: { width: number; height: number } | null;
    /** Размещение тайлов последнего тика */
    tiles: TilePlacement[];
    /** Кто держит редактор, когда phase === 'busy' */
    holder: string | null;
    update: (stream: VideoStream, final?: boolean) => void;
    /** Переоткрыть под другую конфигурацию: размер полотна пересчитывается */
    reopen: (stream: VideoStream) => void;
    takeover: () => void;
    reconnect: () => void;
}

interface EditorMessage {
    type: string;
    ret?: boolean;
    meta?: Record<string, unknown>;
}

export function useEditorSession(initial: VideoStream): EditorSession {
    const [phase, setPhase] = useState<EditorPhase>('connecting');
    const [error, setError] = useState<string | null>(null);
    const [size, setSize] = useState<{ width: number; height: number } | null>(null);
    const [tiles, setTiles] = useState<TilePlacement[]>([]);
    const [holder, setHolder] = useState<string | null>(null);
    const [generation, setGeneration] = useState(0);

    const clientId = useRef(`neural_editor_${Math.random().toString(36).slice(2, 10)}`).current;
    const wsRef = useRef<WebSocket | null>(null);
    // Последняя раскладка: с ней открывается сессия и уходит отложенная правка
    const latestRef = useRef<VideoStream>(initial);
    const lastSentRef = useRef(0);
    const pendingRef = useRef<number | null>(null);

    const sendRaw = useCallback((type: string, meta: Record<string, unknown> = {}) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify({ type, client_id: clientId, meta }));
        return true;
    }, [clientId]);

    const sendOpen = useCallback(() => {
        const s = latestRef.current;
        setPhase('opening');
        sendRaw('open', { stream: withCamerasOnly(s), stream_id: s.id, config_id: s.config_id });
    }, [sendRaw]);

    useEffect(() => {
        let deviceId: string;
        try {
            deviceId = moduleDeviceId('neural');
        } catch (e) {
            setPhase('closed');
            setError(e instanceof Error ? e.message : String(e));
            return;
        }

        setPhase('connecting');
        setError(null);
        const ws = new WebSocket(signalingWsUrl(deviceId, `/cal-client/neural-editor?client=${clientId}`));
        wsRef.current = ws;
        const current = () => wsRef.current === ws;

        ws.onmessage = event => {
            if (!current() || typeof event.data !== 'string') return;
            let msg: EditorMessage;
            try { msg = JSON.parse(event.data); } catch { return; }
            const meta = msg.meta ?? {};

            switch (msg.type) {
                case 'session_ready':
                    setHolder(null);
                    sendOpen();
                    return;
                case 'session_busy':
                    setPhase('busy');
                    setHolder(typeof meta.holder === 'string' ? meta.holder : null);
                    return;
                case 'session_error':
                    setError(meta.code === 1005 ? 'Редактор не подключён к брокеру — media-center не запущен' : String(meta.description ?? 'Брокер отказал'));
                    return;
                case 'session_revoked':
                    setPhase('closed');
                    setError(`Редактор перехватил другой клиент${meta.taken_by ? ` (${meta.taken_by})` : ''}`);
                    return;
                case 'open':
                    if (msg.ret === false) { setPhase('closed'); setError(String(meta.description ?? 'Редактор не открылся')); return; }
                    if (typeof meta.width === 'number' && typeof meta.height === 'number') setSize({ width: meta.width, height: meta.height });
                    if (Array.isArray(meta.tiles)) setTiles(meta.tiles as TilePlacement[]);
                    setError(null);
                    setPhase('open');
                    return;
                case 'update':
                    if (msg.ret === false) setError(String(meta.description ?? 'Раскладку не приняли'));
                    else setError(null);
                    return;
                case 'tiles':
                    if (Array.isArray(meta.tiles)) setTiles(meta.tiles as TilePlacement[]);
                    return;
                case 'close':
                    // Редактор погасил сессию сам: сторож тишины или уход клиента
                    if (meta.description) { setPhase('closed'); setError('Сессия редактора закрыта: ' + String(meta.description)); }
                    return;
            }
        };

        ws.onclose = () => {
            if (!current()) return;
            wsRef.current = null;
            setPhase(p => (p === 'closed' ? p : 'closed'));
            setError(e => e ?? 'Соединение с редактором потеряно');
        };

        const ping = window.setInterval(() => sendRaw('ping'), PING_INTERVAL_MS);

        return () => {
            window.clearInterval(ping);
            if (pendingRef.current) { window.clearTimeout(pendingRef.current); pendingRef.current = null; }
            wsRef.current = null;
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'close', client_id: clientId, meta: { description: 'editor left' } }));
            ws.close();
        };
    }, [clientId, generation, sendOpen, sendRaw]);

    const flush = useCallback(() => {
        pendingRef.current = null;
        lastSentRef.current = performance.now();
        sendRaw('update', { stream: withCamerasOnly(latestRef.current) });
    }, [sendRaw]);

    const update = useCallback((stream: VideoStream, final = false) => {
        latestRef.current = stream;
        if (final) {
            if (pendingRef.current) window.clearTimeout(pendingRef.current);
            flush();
            return;
        }
        const wait = UPDATE_INTERVAL_MS - (performance.now() - lastSentRef.current);
        if (wait <= 0) flush();
        else if (!pendingRef.current) pendingRef.current = window.setTimeout(flush, wait);
    }, [flush]);

    const reopen = useCallback((stream: VideoStream) => {
        latestRef.current = stream;
        setSize(null);
        sendOpen();
    }, [sendOpen]);

    const takeover = useCallback(() => {
        setPhase('connecting');
        sendRaw('session_takeover');
    }, [sendRaw]);

    const reconnect = useCallback(() => setGeneration(g => g + 1), []);

    return { phase, error, size, tiles, holder, update, reopen, takeover, reconnect };
}
