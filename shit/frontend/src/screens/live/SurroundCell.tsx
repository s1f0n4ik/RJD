/**
 * Ячейка виртуального потока 360.
 *
 * Поверх видео — жестовый слой ровно по кадру: горизонталь ведёт по орбите,
 * вертикаль наклоняет взгляд, колесо и щипок приближают. Дельты нормируются
 * на размер кадра и уходят в сигналинг сообщениями type=orbit с троттлингом;
 * слушается ли ручное вращение — решает устройство.
 *
 * Кнопок режима вывода (сверху / круговой) здесь нет: это настройка модуля,
 * ей место на вкладке «Система 360».
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    useWebRTCPlayer,
    type PlayerMessage,
    type PlayerStats,
    type PlayerStatus,
} from '../../components/webrtc/useWebRTCPlayer';
import { useOrbitGesture } from '../../components/webrtc/useOrbitGesture';
import { Icon } from '../../app/Icons';
import { formatDeviceDate, formatDeviceTime } from '../../app/useDeviceClock';
import { describeError } from '../../components/webrtc/error-codes';
import { CellFlash, CellState, useFlash } from './CellOverlays';
import type { Overlays } from './model';

// Сколько ждём подтверждения смены режима вращения
const ORBIT_TIMEOUT_MS = 5000;

interface SurroundCellProps {
    streamId: string;
    name: string;
    signalingUrl: string;
    overlays: Overlays;
    deviceTimeMs: number | null;
    collectStats: boolean;
    /** Режим орбиты из сохранённого отображения */
    initialManual?: boolean;
    onManualChange?: (manual: boolean) => void;
    /** Жест начался: пока он идёт, ячейку нельзя перетаскивать */
    onGestureLock?: (locked: boolean) => void;
    onStatus?: (status: PlayerStatus) => void;
    onStats?: (stats: PlayerStats | null) => void;
}

function num(value: number | null | undefined, digits: number): string {
    return value === null || value === undefined ? '—' : value.toFixed(digits).replace('.', ',');
}

export function SurroundCell({
    streamId,
    name,
    signalingUrl,
    overlays,
    deviceTimeMs,
    collectStats,
    initialManual,
    onManualChange,
    onGestureLock,
    onStatus,
    onStats,
}: SurroundCellProps) {
    const boxRef = useRef<HTMLDivElement>(null);

    // Последнее подтверждённое устройством состояние: к нему откатываемся при отказе
    const confirmedRef = useRef(Boolean(initialManual));
    const initialAppliedRef = useRef(false);

    const [manual, setManual] = useState(Boolean(initialManual));
    // Ответ ещё не пришёл: кнопка ждёт устройство, а не гадает
    const [pending, setPending] = useState(false);
    const pendingTimerRef = useRef<number | null>(null);

    const { flash, show: showFlash, hide: hideFlash } = useFlash();

    const settleOrbit = useCallback(() => {
        setPending(false);
        if (pendingTimerRef.current) {
            window.clearTimeout(pendingTimerRef.current);
            pendingTimerRef.current = null;
        }
    }, []);

    const handleMessage = useCallback((msg: PlayerMessage) => {
        if (msg.type !== 'orbit') return;

        if (msg.ret === 'success') {
            const description = String(msg.description ?? '');
            if (description.startsWith('mode=')) {
                const on = description === 'mode=manual';
                confirmedRef.current = on;
                settleOrbit();
                setManual(on);
                onManualChange?.(on);
            }
            return;
        }

        // Отказ ничего не переключает: показываем причину и оставляем как было
        settleOrbit();
        const info = describeError(msg);
        showFlash(info.text, info.code);
    }, [onManualChange, settleOrbit, showFlash]);

    const { status, errorInfo, attempt, videoRef, stats, send } = useWebRTCPlayer({
        cameraId: streamId,
        signalingUrl,
        collectStats,
        onMessage: handleMessage,
    });

    useEffect(() => {
        onStatus?.(status);
    }, [status, onStatus]);

    useEffect(() => {
        onStats?.(stats);
    }, [stats, onStats]);

    // При живом кадре причина показывается плашкой, а не занимает центр
    useEffect(() => {
        if (status !== 'streaming' || !errorInfo) return;
        showFlash(errorInfo.text, errorInfo.code);
    }, [status, errorInfo, showFlash]);

    useEffect(() => () => {
        if (pendingTimerRef.current) window.clearTimeout(pendingTimerRef.current);
    }, []);

    const gesture = useOrbitGesture({
        videoRef,
        send,
        enabled: true,
        onGestureLock,
    });

    // Режим из сохранённого отображения применяется один раз, когда пошло видео
    useEffect(() => {
        if (initialManual === undefined || initialAppliedRef.current) return;
        if (status !== 'streaming') return;
        if (send({ type: 'orbit', mode: initialManual ? 'manual' : 'auto' })) {
            initialAppliedRef.current = true;
        }
    }, [initialManual, status, send]);

    // Состояние меняется только по ответу устройства
    const toggleManual = () => {
        if (pending) return;

        if (!send({ type: 'orbit', mode: manual ? 'auto' : 'manual' })) {
            showFlash('Нет связи с устройством');
            return;
        }

        setPending(true);
        pendingTimerRef.current = window.setTimeout(() => {
            pendingTimerRef.current = null;
            setPending(false);
            showFlash('Устройство не ответило на смену режима вращения');
        }, ORBIT_TIMEOUT_MS);
    };

    const live = status === 'streaming';

    return (
        <div className="cellv" ref={boxRef}>
            <video ref={videoRef} autoPlay playsInline muted className="cellv-video" />

            <div
                ref={gesture.layerRef}
                className={`orbit-gest${gesture.dragging ? ' is-drag' : ''}`}
                onPointerDown={gesture.onPointerDown}
                onPointerMove={gesture.onPointerMove}
                onPointerUp={gesture.onPointerUp}
                onPointerCancel={gesture.onPointerUp}
            />

            {(overlays.name || (live && overlays.stats)) && (
                <div className="cell-bar">
                    {overlays.name && <span className="nm">{name}</span>}
                    {live && overlays.stats && (
                        <span className="num seps">
                            <span>{num(stats?.fps, 1)} fps</span>
                            <span>{num(stats?.mbits, 1)} Мбит/с</span>
                        </span>
                    )}
                </div>
            )}

            {!live && <CellState status={status} error={errorInfo} attempt={attempt} />}
            {live && flash && <CellFlash flash={flash} onClose={hideFlash} />}

            {overlays.time && (
                <span className="cellv-time seps">
                    <span>{formatDeviceDate(deviceTimeMs)}</span>
                    <span>{formatDeviceTime(deviceTimeMs)}</span>
                </span>
            )}

            <div className="cellv-tools" onDoubleClick={event => event.stopPropagation()}>
                <button
                    className={`cellv-btn${manual ? ' is-on' : ''}`}
                    title={manual ? 'Выключить ручное вращение' : 'Включить ручное вращение'}
                    disabled={pending}
                    onClick={event => { event.stopPropagation(); toggleManual(); }}
                >
                    <Icon name="360" />
                </button>
            </div>
        </div>
    );
}
