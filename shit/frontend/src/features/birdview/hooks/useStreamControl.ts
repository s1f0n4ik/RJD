import { useCallback, useEffect, useRef, useState } from 'react';
import type { BirdviewWs } from './useBirdviewWs';
import type { CalibrationCamera } from '../api/ws-types';
import type { LogFn } from './useEventLog';

/**
 * Управление стримом калибратора.
 *
 * Живёт в BirdviewApp, а не на экране калибровки: камеру теперь выбирают и на
 * проекции, а калибратор один — стрим у обоих экранов общий. Ответ на запрос
 * ловит диспетчер экрана калибровки и отдаёт его сюда через settle().
 */

/** Сколько ждём ответа калибратора на connection, прежде чем сдаться. */
const STREAM_REQUEST_TIMEOUT_MS = 30_000;

export interface StreamControl {
    streamId: string | null;
    /**
     * Номер пересборки пайплайна. Калибратор всегда отдаёт один и тот же
     * id_stream, поэтому отличить пересобранный пайплайн от живого можно
     * только по нему — плеер пересоздаётся при изменении этого числа.
     */
    generation: number;
    /** Запрос ушёл, ответа ещё нет. Подъём пайплайна занимает секунды десять. */
    pending: boolean;
    open: (cam: CalibrationCamera) => void;
    close: () => void;
    /** Закрыть текущий стрим и поднять его заново под другую камеру. */
    restart: (cam: CalibrationCamera) => void;
    /**
     * Смена источника кадров на живом пайплайне. Сервер сам решает, хватит ли
     * подмены слота в хранилище или разрешение вынуждает пересобрать пайплайн.
     */
    switchCamera: (cam: CalibrationCamera) => void;
    /** Пришёл ответ connection: id стрима либо null при отказе. */
    settle: (id: string | null) => void;
    /** Пришёл ответ switch_camera. */
    settleSwitch: (ok: boolean, pipelineRestarted: boolean) => void;
    /** Сессия калибратора кончилась — забыть всё. */
    reset: () => void;
}

interface Options {
    ws: BirdviewWs;
    clientId: string;
    log: LogFn;
    onToast: (title: string, desc: string, type: 'ok' | 'err' | 'info') => void;
    /** Стрим сменился — сбросить состояние плеера. */
    onStreamReset: () => void;
}

export function useStreamControl({ ws, clientId, log, onToast, onStreamReset }: Options): StreamControl {
    const [streamId, setStreamId] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [generation, setGeneration] = useState(0);

    const timerRef = useRef<number | null>(null);
    const streamIdRef = useRef<string | null>(null);
    streamIdRef.current = streamId;

    const logRef = useRef(log);
    logRef.current = log;
    const toastRef = useRef(onToast);
    toastRef.current = onToast;
    const resetPlayerRef = useRef(onStreamReset);
    resetPlayerRef.current = onStreamReset;

    const clearTimer = useCallback(() => {
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    useEffect(() => clearTimer, [clearTimer]);

    const sendClose = useCallback(() => {
        const id = streamIdRef.current;
        if (!id) return;
        ws.send({
            type: 'close',
            client_id: clientId,
            camera: id,
            meta: { description: `close from ${clientId}` },
            ret: 'none',
        });
    }, [ws, clientId]);

    const open = useCallback(
        (cam: CalibrationCamera) => {
            const { id, width, height, fps } = cam;
            logRef.current(`Запрос стрима: ${id} @ ${width}×${height} / ${fps}fps`);

            const sent = ws.send({
                type: 'connection',
                client_id: clientId,
                meta: { camera_id: id, width, height, fps },
            });
            if (!sent) return;

            setPending(true);

            // Зависший калибратор молчит и не рвёт сокет — без таймаута ожидание
            // осталось бы вечным, а кнопка навсегда заблокированной
            clearTimer();
            timerRef.current = window.setTimeout(() => {
                timerRef.current = null;
                setPending(false);
                logRef.current('Калибратор не ответил на запрос стрима', 'err');
                toastRef.current('Калибратор не ответил', 'Ответ не пришёл за 30 секунд', 'err');
            }, STREAM_REQUEST_TIMEOUT_MS);
        },
        [ws, clientId, clearTimer],
    );

    const close = useCallback(() => {
        sendClose();
        clearTimer();
        setPending(false);
        setStreamId(null);
        streamIdRef.current = null;
        resetPlayerRef.current();
    }, [sendClose, clearTimer]);

    const restart = useCallback(
        (cam: CalibrationCamera) => {
            close();
            open(cam);
        },
        [close, open],
    );

    const switchCamera = useCallback(
        (cam: CalibrationCamera) => {
            const { id, width, height, fps } = cam;
            logRef.current(`Смена источника на ${id} @ ${width}×${height}`);

            const sent = ws.send({
                type: 'switch_camera',
                client_id: clientId,
                camera: streamIdRef.current,
                meta: { camera_id: id, width, height, fps },
            });
            if (!sent) return;

            setPending(true);

            clearTimer();
            timerRef.current = window.setTimeout(() => {
                timerRef.current = null;
                setPending(false);
                logRef.current('Калибратор не ответил на смену источника', 'err');
                toastRef.current('Калибратор не ответил', 'Ответ не пришёл за 30 секунд', 'err');
            }, STREAM_REQUEST_TIMEOUT_MS);
        },
        [ws, clientId, clearTimer],
    );

    const settleSwitch = useCallback(
        (ok: boolean, pipelineRestarted: boolean) => {
            clearTimer();
            setPending(false);
            // Пайплайн пересобран — прежняя WebRTC-сессия мертва, плеер надо поднять заново.
            // При горячей смене сессия жива, и трогать её нельзя: в этом весь смысл
            if (ok && pipelineRestarted) {
                setGeneration(g => g + 1);
                resetPlayerRef.current();
            }
        },
        [clearTimer],
    );

    const settle = useCallback(
        (id: string | null) => {
            clearTimer();
            setPending(false);
            setStreamId(id);
            streamIdRef.current = id;
            setGeneration(g => g + 1);
            if (!id) resetPlayerRef.current();
        },
        [clearTimer],
    );

    const reset = useCallback(() => {
        clearTimer();
        setPending(false);
        setStreamId(null);
        streamIdRef.current = null;
        resetPlayerRef.current();
    }, [clearTimer]);

    return {
        streamId,
        generation,
        pending,
        open,
        close,
        restart,
        switchCamera,
        settle,
        settleSwitch,
        reset,
    };
}
