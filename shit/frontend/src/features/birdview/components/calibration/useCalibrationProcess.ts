import { useCallback, useState } from 'react';
import type { BirdviewWs } from '../../hooks/useBirdviewWs';
import type { WsMessage } from '../../api/ws-types';
import type { LogFn } from '../../hooks/useEventLog';
import type { Distortion } from './useDistortion';
import type { Snapshots } from './useSnapshots';

/**
 * Ход калибровки и оверлей поверх кадра. Порт процессной части calibration.js.
 *
 * В no-react оверлей был набором из десяти элементов, которым руками
 * выставляли style.display. Здесь это размеченное объединение — состояний
 * ровно четыре, и невозможных комбинаций больше не существует.
 */

export type CalOverlayState =
    | {
          kind: 'step';
          label: string;
          desc: string;
          step: number | null;
          totalSteps: number | null;
          progress: number | null;
          itemCurrent: number | null;
          itemTotal: number | null;
      }
    | { kind: 'indeterminate'; label: string; desc: string }
    | { kind: 'result'; ok: boolean; title: string; desc: string };

export interface CalibrationProcess {
    overlay: CalOverlayState | null;
    dismiss: () => void;
    start: () => void;
    handleStart: (msg: WsMessage) => void;
    handleProgress: (msg: WsMessage) => void;
    handlePostProcess: (msg: WsMessage) => void;
    handleCompute: (msg: WsMessage) => void;
    handleResult: (msg: WsMessage) => void;
}

interface Options {
    ws: BirdviewWs;
    clientId: string;
    log: LogFn;
    onToast: (title: string, desc: string, type: 'ok' | 'err' | 'info') => void;
    distortion: Distortion;
    snapshots: Snapshots;
}

export function useCalibrationProcess({
    ws,
    clientId,
    log,
    onToast,
    distortion,
    snapshots,
}: Options): CalibrationProcess {
    const [overlay, setOverlay] = useState<CalOverlayState | null>(null);

    const dismiss = useCallback(() => setOverlay(null), []);

    const start = useCallback(() => {
        ws.send({ type: 'calibration_start', client_id: clientId, meta: {} });
    }, [ws, clientId]);

    const handleStart = useCallback(
        (msg: WsMessage) => {
            if (!msg.ret) {
                log(`Ошибка: ${msg.meta?.description ?? ''}`, 'err');
                onToast('Ошибка калибровки', msg.meta?.description ?? '', 'err');
                return;
            }
            const total = msg.meta?.total ?? 0;
            setOverlay({
                kind: 'step',
                label: 'Обработка снимков',
                desc: 'Обнаружение шахматной доски',
                step: 1,
                totalSteps: total,
                progress: 0,
                itemCurrent: null,
                itemTotal: null,
            });
        },
        [log, onToast],
    );

    const handleProgress = useCallback(
        (msg: WsMessage) => {
            if (!msg.ret) {
                log(`Шаг: ${msg.meta?.description ?? ''}`, 'err');
                return;
            }
            const { id, current_count = 0, total = 0, corners_found = false } = msg.meta ?? {};

            setOverlay(prev => {
                if (!prev || prev.kind !== 'step') return prev;
                return {
                    ...prev,
                    step: current_count,
                    totalSteps: total,
                    progress: total ? (current_count / total) * 100 : 0,
                    itemCurrent: current_count,
                    itemTotal: total,
                };
            });

            snapshots.setUsed(id, corners_found);
        },
        [log, snapshots],
    );

    const handlePostProcess = useCallback(
        (msg: WsMessage) => {
            if (!msg.ret) return;
            snapshots.setUsed(msg.meta?.id ?? -1, msg.meta?.corners_found ?? false);
        },
        [snapshots],
    );

    const handleCompute = useCallback((msg: WsMessage) => {
        if (!msg.ret) return;
        setOverlay({
            kind: 'indeterminate',
            label: 'Вычисление',
            desc: 'Вычисление матрицы коррекции...',
        });
    }, []);

    const handleResult = useCallback(
        (msg: WsMessage) => {
            const { width = -1, height = -1, rms = -1, used_images = -1, total = -1 } = msg.meta ?? {};

            if (!msg.ret) {
                setOverlay({
                    kind: 'result',
                    ok: false,
                    title: 'Ошибка калибровки',
                    desc: msg.meta?.description ?? '',
                });
            } else if (rms > 1.0) {
                setOverlay({
                    kind: 'result',
                    ok: false,
                    title: 'Калибровка завершена',
                    desc: `Погрешность: ${rms}px — слишком высокая!\nОбработано: ${total}, использовано ${used_images}`,
                });
            } else {
                setOverlay({
                    kind: 'result',
                    ok: true,
                    title: 'Калибровка завершена',
                    desc: `Погрешность: ${rms}px\nОбработано: ${total}, использовано ${used_images}`,
                });
            }

            distortion.setSliderConfig('alpha', { value: 0, min: 0, max: 1, decimals: 2 });
            distortion.setSliderConfig('zoom', { value: 1, min: 0.1, max: 2.0, mid: 1.0, decimals: 2 });
            distortion.setSliderConfig('shift_x', { value: 0, min: -width, max: width, decimals: 0 });
            distortion.setSliderConfig('shift_y', { value: 0, min: -height, max: height, decimals: 0 });
            distortion.requestCompute(false);
        },
        [distortion],
    );

    return {
        overlay,
        dismiss,
        start,
        handleStart,
        handleProgress,
        handlePostProcess,
        handleCompute,
        handleResult,
    };
}
