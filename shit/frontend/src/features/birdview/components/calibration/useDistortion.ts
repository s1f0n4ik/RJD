import { useCallback, useRef, useState } from 'react';
import type { BirdviewWs } from '../../hooks/useBirdviewWs';
import type { SliderKey, WsMessage } from '../../api/ws-types';

/**
 * Слайдеры коррекции искажений. Порт distortion.js.
 *
 * Слайдеры контролируемые, но с защитой от перебивания: пока пользователь
 * держит слайдер, ответ сервера для этого конкретного ключа игнорируется,
 * остальные синхронизируются как обычно. Иначе значение прыгает под пальцем.
 *
 * На сервер отправляем только по коммиту (нативное событие change —
 * отпускание мыши), а не на каждое движение: undistort_compute тяжёлый.
 */

export interface SliderConfig {
    min: number;
    max: number;
    mid: number;
    decimals: number;
}

export const SLIDER_KEYS: SliderKey[] = [
    'alpha',
    'zoom',
    'shift_x',
    'shift_y',
    'k1',
    'k2',
    'k3',
    'k4',
];

const DEFAULT_CONFIGS: Record<SliderKey, SliderConfig> = {
    alpha: { min: 0, max: 1, mid: 0.5, decimals: 3 },
    zoom: { min: 0, max: 2, mid: 1, decimals: 3 },
    shift_x: { min: 0, max: 2, mid: 1, decimals: 0 },
    shift_y: { min: 0, max: 2, mid: 1, decimals: 0 },
    k1: { min: -1, max: 1, mid: 0, decimals: 4 },
    k2: { min: -1, max: 1, mid: 0, decimals: 4 },
    k3: { min: -1, max: 1, mid: 0, decimals: 4 },
    k4: { min: -0.5, max: 0.5, mid: 0, decimals: 4 },
    radius: { min: 1, max: 1, mid: 1, decimals: 0 },
};

const DEFAULT_VALUES: Record<SliderKey, number> = {
    alpha: 0,
    zoom: 1,
    shift_x: 0,
    shift_y: 0,
    k1: 0,
    k2: 0,
    k3: 0,
    k4: 0,
    radius: 1,
};

export interface Distortion {
    values: Record<SliderKey, number>;
    configs: Record<SliderKey, SliderConfig>;
    visible: boolean;
    showUndistort: boolean;
    panorama: boolean;
    /** Пользователь держит этот слайдер — синхронизацию для него не применяем. */
    held: SliderKey | null;
    setHeld: (key: SliderKey | null) => void;
    setValue: (key: SliderKey, value: number) => void;
    commit: (key: SliderKey) => void;
    setVisible: (v: boolean) => void;
    syncSlider: (key: SliderKey, value: number) => void;
    setSliderConfig: (key: SliderKey, cfg: Partial<SliderConfig> & { value?: number }) => void;
    requestCompute: (useK: boolean) => void;
    toggleShowUndistort: () => void;
    togglePanorama: () => void;
    handleCompute: (msg: WsMessage) => void;
    handleShowUndistort: (msg: WsMessage) => void;
    handlePanoramaToggle: (msg: WsMessage) => void;
}

interface Options {
    ws: BirdviewWs;
    clientId: string;
    onError: (title: string, desc: string) => void;
    log: (msg: string, level?: 'info' | 'ok' | 'warn' | 'err') => void;
}

export function useDistortion({ ws, clientId, onError, log }: Options): Distortion {
    const [values, setValues] = useState<Record<SliderKey, number>>({ ...DEFAULT_VALUES });
    const [configs, setConfigs] = useState<Record<SliderKey, SliderConfig>>({ ...DEFAULT_CONFIGS });
    const [visible, setVisible] = useState(false);
    const [showUndistort, setShowUndistort] = useState(false);
    const [panorama, setPanorama] = useState(false);
    const [held, setHeld] = useState<SliderKey | null>(null);

    // Актуальные значения для сборки сообщения и для проверки held в обработчиках
    const valuesRef = useRef(values);
    valuesRef.current = values;
    const heldRef = useRef(held);
    heldRef.current = held;

    const setValue = useCallback((key: SliderKey, value: number) => {
        setValues(prev => ({ ...prev, [key]: value }));
    }, []);

    /** Приходит от сервера. Слайдер под пальцем не трогаем. */
    const syncSlider = useCallback((key: SliderKey, value: number) => {
        if (heldRef.current === key) return;
        setValues(prev => ({ ...prev, [key]: value }));
    }, []);

    const setSliderConfig = useCallback(
        (key: SliderKey, cfg: Partial<SliderConfig> & { value?: number }) => {
            setConfigs(prev => {
                const min = cfg.min ?? prev[key].min;
                const max = cfg.max ?? prev[key].max;
                return {
                    ...prev,
                    [key]: {
                        min,
                        max,
                        mid: cfg.mid ?? (min + max) / 2,
                        decimals: cfg.decimals ?? prev[key].decimals,
                    },
                };
            });
            if (cfg.value !== undefined && heldRef.current !== key) {
                setValues(prev => ({ ...prev, [key]: cfg.value as number }));
            }
        },
        [],
    );

    const requestCompute = useCallback(
        (useK: boolean) => {
            const v = valuesRef.current;
            ws.send({
                type: 'undistort_compute',
                client_id: clientId,
                meta: {
                    alpha: v.alpha,
                    zoom: v.zoom,
                    shift_x: v.shift_x,
                    shift_y: v.shift_y,
                    ...(useK ? { k1: v.k1, k2: v.k2, k3: v.k3, k4: v.k4 } : {}),
                },
            });
        },
        [ws, clientId],
    );

    /** Коммит по отпусканию: радиус панорамы уходит своим сообщением. */
    const commit = useCallback(
        (key: SliderKey) => {
            if (key === 'radius') {
                ws.send({
                    type: 'compute_panorama_remap',
                    client_id: clientId,
                    meta: { radius: Math.round(valuesRef.current.radius) },
                });
                return;
            }
            requestCompute(true);
        },
        [ws, clientId, requestCompute],
    );

    const toggleShowUndistort = useCallback(() => {
        // Состояние меняем не сами — ждём подтверждения сервера
        ws.send({
            type: 'view_undistort',
            client_id: clientId,
            meta: { show: !showUndistort },
        });
    }, [ws, clientId, showUndistort]);

    const togglePanorama = useCallback(() => {
        ws.send({
            type: 'panorama_toggle',
            client_id: clientId,
            meta: { use_panorama_remap: !panorama },
        });
    }, [ws, clientId, panorama]);

    const handleCompute = useCallback(
        (msg: WsMessage) => {
            if (!msg.ret) {
                onError('Ошибка', msg.meta?.description ?? '');
                return;
            }
            if (!msg.meta) return;
            for (const key of Object.keys(msg.meta) as SliderKey[]) {
                if (key in DEFAULT_VALUES) syncSlider(key, Number(msg.meta[key]));
            }
        },
        [onError, syncSlider],
    );

    const handleShowUndistort = useCallback(
        (msg: WsMessage) => {
            if (!msg.ret) {
                requestCompute(false);
                return;
            }
            setShowUndistort(Boolean(msg.meta?.show));
        },
        [requestCompute],
    );

    const handlePanoramaToggle = useCallback(
        (msg: WsMessage) => {
            if (!msg.ret) {
                log(`Панорама: ${msg.meta?.description ?? ''}`, 'err');
                return;
            }
            const use = Boolean(msg.meta?.use_panorama_remap);
            setPanorama(use);
            if (use) {
                const maxR = Math.max(1, Math.floor((msg.meta?.height ?? 2) / 2));
                setSliderConfig('radius', { value: maxR, min: 1, max: maxR, decimals: 0 });
            } else {
                requestCompute(false);
            }
        },
        [log, setSliderConfig, requestCompute],
    );

    return {
        values,
        configs,
        visible,
        showUndistort,
        panorama,
        held,
        setHeld,
        setValue,
        commit,
        setVisible,
        syncSlider,
        setSliderConfig,
        requestCompute,
        toggleShowUndistort,
        togglePanorama,
        handleCompute,
        handleShowUndistort,
        handlePanoramaToggle,
    };
}
