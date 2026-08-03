import { useCallback, useEffect, useRef, useState } from 'react';
import type { BirdviewWs } from './useBirdviewWs';
import type { CalibrationCamera, WsMessage } from '../api/ws-types';
import type { LogFn } from './useEventLog';
import type { ConfigSummary } from '../components/calibration/ConfigModal';

/**
 * Выбор конфигурации коррекции, общий для калибровки и проекции.
 *
 * Порядок задаёт клиент. Сервер принимает load только когда разрешение
 * конфигурации совпадает с текущим кадром ([calibrator.cpp] load configuration).
 * На живом стриме load уходит прямо из select; до подъёма выбор запоминается
 * как намерение, и load отправляет applyPending после успешного connection.
 *
 * Готовность, показ и ключ загруженной конфигурации — состояние сервера из
 * сообщений status (is_undistortion / show_undistortion / loaded_config_key):
 * их он шлёт и после load, и по запросу. Так лампа, тумблер и селект честны,
 * кем бы коррекция ни была загружена. Ручной пересчёт карт инвалидирует ключ
 * на сервере — успешный undistort_compute снимает его и здесь.
 */

export interface Correction {
    /** Список конфигураций калибровки: config_key, id камеры, разрешение. */
    configs: ConfigSummary[];
    /** Выбранная конфигурация — намерение оператора. */
    selectedKey: string | null;
    /** Конфигурация, которую калибратор подтвердил загрузкой. */
    loadedKey: string | null;
    /** Коррекция на сервере готова к показу — из status.is_undistortion. */
    ready: boolean;
    /** Коррекция показывается в кадре. */
    enabled: boolean;

    requestList: () => void;
    select: (key: string | null) => void;
    setEnabled: (on: boolean) => void;
    /** Разрешение выбранной конфигурации. */
    selectedSize: () => { width: number; height: number } | null;
    /** Камера подходит под выбранную конфигурацию. Без выбора подходит любая. */
    fits: (cam: CalibrationCamera | null) => boolean;
    /** Отправить отложенный load. Зовётся диспетчером после ответа connection. */
    applyPending: (cam: CalibrationCamera | null) => void;
    reset: () => void;
}

interface Options {
    ws: BirdviewWs;
    log: LogFn;
    onToast: (title: string, desc: string, type: 'ok' | 'err' | 'info') => void;
    /** Текущая камера: load сверяется с её разрешением до отправки. */
    getCamera: () => CalibrationCamera | null;
    /** Стрим поднят — load можно слать сразу, не дожидаясь connection. */
    isStreamLive: () => boolean;
}

export function useCorrection({ ws, log, onToast, getCamera, isStreamLive }: Options): Correction {
    const [configs, setConfigs] = useState<ConfigSummary[]>([]);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [loadedKey, setLoadedKey] = useState<string | null>(null);
    const [ready, setReady] = useState(false);
    const [enabled, setEnabledState] = useState(false);

    // Ответы calibration_configuration слушает ещё и экран калибровки со своей
    // модалкой. Чтобы не разбирать чужие ответы, помечаем собственные запросы.
    const awaitingListRef = useRef(false);
    const awaitingLoadRef = useRef<string | null>(null);

    const selectedKeyRef = useRef(selectedKey);
    selectedKeyRef.current = selectedKey;
    const configsRef = useRef(configs);
    configsRef.current = configs;
    const loadedKeyRef = useRef(loadedKey);
    loadedKeyRef.current = loadedKey;
    const readyRef = useRef(ready);
    readyRef.current = ready;

    const logRef = useRef(log);
    logRef.current = log;
    const toastRef = useRef(onToast);
    toastRef.current = onToast;

    const findConfig = useCallback(
        (key: string | null) => (key ? configsRef.current.find(c => (c.config_key ?? c.id) === key) : undefined),
        [],
    );

    const selectedSize = useCallback(() => {
        const cfg = findConfig(selectedKeyRef.current);
        if (!cfg || cfg.width == null || cfg.height == null) return null;
        return { width: cfg.width, height: cfg.height };
    }, [findConfig]);

    const fits = useCallback(
        (cam: CalibrationCamera | null) => {
            const size = selectedSize();
            if (!size) return true;
            if (!cam) return false;
            return cam.width === size.width && cam.height === size.height;
        },
        [selectedSize],
    );

    const requestList = useCallback(() => {
        awaitingListRef.current = true;
        ws.sendMessage('calibration_configuration', { method: 'get_list' });
    }, [ws]);

    const sendLoad = useCallback(
        (key: string) => {
            awaitingLoadRef.current = key;
            ws.sendMessage('calibration_configuration', { method: 'load', config_key: key });
        },
        [ws],
    );

    /** Показ коррекции переключаем через view_undistort — состояние ждём от сервера. */
    const setEnabled = useCallback(
        (on: boolean) => {
            if (on && !readyRef.current) {
                toastRef.current('Коррекция не загружена', 'Выберите конфигурацию и поднимите стрим', 'err');
                return;
            }
            ws.sendMessage('view_undistort', { show: on });
        },
        [ws],
    );

    // Общий шаг select и applyPending: проверка разрешения и отправка load
    const loadIfFits = useCallback(
        (key: string, cam: CalibrationCamera | null) => {
            const cfg = findConfig(key);
            if (cfg && cam && (cfg.width !== cam.width || cfg.height !== cam.height)) {
                logRef.current(
                    `Коррекция <${key}> не подходит камере ${cam.width}×${cam.height} — загрузка пропущена`,
                    'warn',
                );
                return;
            }
            sendLoad(key);
        },
        [findConfig, sendLoad],
    );

    const select = useCallback(
        (key: string | null) => {
            setSelectedKey(key);
            if (key === null) {
                setLoadedKey(null);
                return;
            }
            if (key !== loadedKeyRef.current) setLoadedKey(null);

            // Живой стрим: load сразу, connection уже не придёт.
            // Без стрима выбор остаётся намерением до applyPending
            if (isStreamLive()) loadIfFits(key, getCamera());
        },
        [isStreamLive, getCamera, loadIfFits],
    );

    const applyPending = useCallback(
        (cam: CalibrationCamera | null) => {
            const key = selectedKeyRef.current;
            if (!key || key === loadedKeyRef.current) return;
            loadIfFits(key, cam);
        },
        [loadIfFits],
    );

    const reset = useCallback(() => {
        setLoadedKey(null);
        setReady(false);
        setEnabledState(false);
        awaitingLoadRef.current = null;
    }, []);

    const handleConfiguration = useCallback(
        (msg: WsMessage) => {
            const meta = msg.meta ?? {};

            if (meta.method === 'get_list' && awaitingListRef.current) {
                awaitingListRef.current = false;
                if (msg.ret) setConfigs(meta.configs ?? []);
                return;
            }

            if (meta.method === 'load' && awaitingLoadRef.current) {
                const key = awaitingLoadRef.current;
                awaitingLoadRef.current = null;

                if (!msg.ret) {
                    setLoadedKey(null);
                    toastRef.current('Коррекция не загружена', meta.description ?? '', 'err');
                    return;
                }

                setLoadedKey(key);
                logRef.current(`Коррекция загружена: ${key}`, 'ok');
                // Загруженная коррекция без показа бессмысленна — включаем сразу
                ws.sendMessage('view_undistort', { show: true });
            }
        },
        [ws],
    );

    const handleViewUndistort = useCallback((msg: WsMessage) => {
        if (!msg.ret) return;
        setEnabledState(Boolean(msg.meta?.show));
    }, []);

    // Правда о готовности, показе и ключе — status: сервер шлёт его после load
    // и по запросу, кем бы коррекция ни была загружена
    const handleStatus = useCallback(
        (msg: WsMessage) => {
            if (!msg.ret) return;
            const meta = msg.meta ?? {};
            if (meta.is_undistortion !== undefined) setReady(Boolean(meta.is_undistortion));
            if (meta.show_undistortion !== undefined) setEnabledState(Boolean(meta.show_undistortion));

            if (typeof meta.loaded_config_key === 'string') {
                const key = meta.loaded_config_key || null;
                setLoadedKey(key);
                // Незавершённое намерение оператора статус не затирает
                const pending =
                    selectedKeyRef.current !== null && selectedKeyRef.current !== loadedKeyRef.current;
                if (!pending) setSelectedKey(key);
                if (key && !findConfig(key)) requestList();
            }
        },
        [findConfig, requestList],
    );

    // Сервер чистит ключ при ручном пересчёте карт — зеркалим
    const handleUndistortCompute = useCallback((msg: WsMessage) => {
        if (!msg.ret || !msg.meta) return;
        setLoadedKey(null);
        setSelectedKey(null);
    }, []);

    useEffect(() => {
        const unsubs = [
            ws.subscribe('calibration_configuration', handleConfiguration),
            ws.subscribe('view_undistort', handleViewUndistort),
            ws.subscribe('status', handleStatus),
            ws.subscribe('undistort_compute', handleUndistortCompute),
        ];
        return () => unsubs.forEach(u => u());
    }, [ws, handleConfiguration, handleViewUndistort, handleStatus, handleUndistortCompute]);

    return {
        configs,
        selectedKey,
        loadedKey,
        ready,
        enabled,
        requestList,
        select,
        setEnabled,
        selectedSize,
        fits,
        applyPending,
        reset,
    };
}
