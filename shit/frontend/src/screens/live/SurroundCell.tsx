/**
 * Ячейка виртуального потока 360.
 *
 * Поверх видео — жестовый слой ровно по кадру: горизонталь ведёт по орбите,
 * вертикаль наклоняет взгляд, колесо и щипок приближают. Дельты нормируются
 * на размер кадра и уходят в сигналинг сообщениями type=orbit с троттлингом;
 * слушается ли ручное вращение — решает устройство.
 *
 * Режим вывода (сверху / объём). При одиночном выводе бадж дёргает ту же
 * ручку, что сегмент в разделе «Система 360», и вывод перезапускается для
 * всех экранов. При двойном выводе ячейка держит оба соединения, а бадж
 * лишь меняет видимое видео — мгновенно и только у этого экрана.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
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
import { linkerApi, type ViewMode } from '../../features/birdview/api/linker';
import { CellFlash, CellState, useFlash } from './CellOverlays';
import type { Overlays } from './model';

// Сколько ждём подтверждения смены режима вращения
const ORBIT_TIMEOUT_MS = 5000;
// Опрос режима вывода; после клика — чаще, пока статус не подтвердит смену
const VIEW_POLL_MS = 5000;
const VIEW_POLL_FAST_MS = 1000;
// Перезапуск вывода с другим размером кадра занимает секунды
const VIEW_TIMEOUT_MS = 20000;

/** Второй поток той же конфигурации при двойном выводе */
export interface SecondaryStream {
    streamId: string;
    viewMode: ViewMode;
    signalingUrl: string;
}

interface SurroundCellProps {
    streamId: string;
    name: string;
    signalingUrl: string;
    overlays: Overlays;
    deviceTimeMs: number | null;
    collectStats: boolean;
    /** Второй поток; null — вывод одиночный, бадж перезапускает вывод */
    secondary?: SecondaryStream | null;
    /** Видимый режим из сохранённого отображения; только при двойном выводе */
    initialViewMode?: ViewMode;
    onViewModeChange?: (mode: ViewMode) => void;
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

function other(mode: ViewMode): ViewMode {
    return mode === 'top' ? 'surround' : 'top';
}

export function SurroundCell({
    streamId,
    name,
    signalingUrl,
    overlays,
    deviceTimeMs,
    collectStats,
    secondary,
    initialViewMode,
    onViewModeChange,
    initialManual,
    onManualChange,
    onGestureLock,
    onStatus,
    onStats,
}: SurroundCellProps) {
    const boxRef = useRef<HTMLDivElement>(null);
    const dual = Boolean(secondary);

    // Последнее подтверждённое устройством состояние: к нему откатываемся при отказе
    const confirmedRef = useRef(Boolean(initialManual));
    const initialAppliedRef = useRef(false);

    const [manual, setManual] = useState(Boolean(initialManual));
    // Ответ ещё не пришёл: кнопка ждёт устройство, а не гадает
    const [pending, setPending] = useState(false);
    const pendingTimerRef = useRef<number | null>(null);

    const { flash, show: showFlash, hide: hideFlash } = useFlash();

    // Режим основного потока известен только устройству; null — статус ещё не получен
    const [viewMode, setViewMode] = useState<ViewMode | null>(null);
    const [viewTarget, setViewTarget] = useState<ViewMode | null>(null);
    const viewTimerRef = useRef<number | null>(null);

    // Видимое видео при двойном выводе — выбор этого экрана
    const [shown, setShown] = useState<ViewMode | null>(initialViewMode ?? null);

    useEffect(() => {
        let alive = true;
        const poll = async () => {
            try {
                const status = await linkerApi.getStatus();
                if (alive) setViewMode(status.viewMode);
            } catch {
                /* модуль не ответил — бадж останется в прежнем состоянии */
            }
        };
        poll();
        const timer = window.setInterval(poll, viewTarget ? VIEW_POLL_FAST_MS : VIEW_POLL_MS);
        return () => { alive = false; window.clearInterval(timer); };
    }, [viewTarget]);

    // Смена подтверждена статусом — ожидание снимается
    useEffect(() => {
        if (!viewTarget || viewMode !== viewTarget) return;
        setViewTarget(null);
        if (viewTimerRef.current) {
            window.clearTimeout(viewTimerRef.current);
            viewTimerRef.current = null;
        }
    }, [viewMode, viewTarget]);

    // Режим основного соединения: при двойном выводе — противоположный второму
    const primaryMode: ViewMode | null = secondary ? other(secondary.viewMode) : viewMode;
    const visible: ViewMode | null = dual ? (shown ?? primaryMode) : viewMode;

    const toggleViewMode = async () => {
        if (dual && secondary) {
            const next = other(visible ?? primaryMode ?? 'top');
            setShown(next);
            onViewModeChange?.(next);
            return;
        }
        if (viewTarget || !viewMode) return;
        const target: ViewMode = viewMode === 'top' ? 'surround' : 'top';
        setViewTarget(target);
        viewTimerRef.current = window.setTimeout(() => {
            viewTimerRef.current = null;
            setViewTarget(null);
            showFlash('Устройство не подтвердило смену режима вывода');
        }, VIEW_TIMEOUT_MS);
        try {
            await linkerApi.setViewMode(target);
        } catch (e) {
            if (viewTimerRef.current) window.clearTimeout(viewTimerRef.current);
            viewTimerRef.current = null;
            setViewTarget(null);
            showFlash(e instanceof Error ? e.message : 'Не удалось сменить режим вывода');
        }
    };

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

    const primary = useWebRTCPlayer({
        cameraId: streamId,
        signalingUrl,
        collectStats: collectStats && (!dual || visible === primaryMode),
        onMessage: handleMessage,
    });

    // Второе соединение живёт только при двойном выводе
    const second = useWebRTCPlayer({
        cameraId: secondary?.streamId ?? '',
        signalingUrl: secondary?.signalingUrl ?? '',
        collectStats: collectStats && dual && visible === secondary?.viewMode,
        onMessage: handleMessage,
        enabled: dual,
    });

    // Орбита живёт на соединении объёма; без второго потока — на единственном
    const surroundPlayer = secondary?.viewMode === 'surround' ? second : primary;
    const shownPlayer = dual && visible === secondary?.viewMode ? second : primary;
    const { status, errorInfo, attempt, stats } = shownPlayer;

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
        if (viewTimerRef.current) window.clearTimeout(viewTimerRef.current);
    }, []);

    const gesture = useOrbitGesture({
        videoRef: surroundPlayer.videoRef,
        send: surroundPlayer.send,
        enabled: !dual || visible === 'surround',
        onGestureLock,
    });

    // Режим из сохранённого отображения применяется один раз, когда пошло видео объёма
    useEffect(() => {
        if (initialManual === undefined || initialAppliedRef.current) return;
        if (surroundPlayer.status !== 'streaming') return;
        if (surroundPlayer.send({ type: 'orbit', mode: initialManual ? 'manual' : 'auto' })) {
            initialAppliedRef.current = true;
        }
    }, [initialManual, surroundPlayer.status, surroundPlayer.send]);

    // Состояние меняется только по ответу устройства
    const toggleManual = () => {
        if (pending) return;

        if (!surroundPlayer.send({ type: 'orbit', mode: manual ? 'auto' : 'manual' })) {
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
    const primaryHidden = dual && visible !== primaryMode;

    // display:none останавливает декодирование, и сторож кадров хука рвёт сессию
    const hiddenVideo: CSSProperties = {
        position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none',
    };

    return (
        <div className="cellv" ref={boxRef}>
            <video
                ref={primary.videoRef}
                autoPlay
                playsInline
                muted
                className="cellv-video"
                style={primaryHidden ? hiddenVideo : undefined}
            />
            {dual && (
                <video
                    ref={second.videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="cellv-video"
                    style={primaryHidden ? undefined : hiddenVideo}
                />
            )}

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
                {visible && (
                    <button
                        className={`cellv-btn${visible === 'top' ? ' is-on' : ''}`}
                        title={visible === 'top' ? 'Объёмный вид' : 'Вид сверху'}
                        disabled={Boolean(viewTarget)}
                        onClick={event => { event.stopPropagation(); void toggleViewMode(); }}
                    >
                        <Icon name="map" />
                    </button>
                )}
                {/* В режиме «сверху» орбиты нет — устройство отказывает */}
                {visible !== 'top' && (
                    <button
                        className={`cellv-btn${manual ? ' is-on' : ''}`}
                        title={manual ? 'Выключить ручное вращение' : 'Включить ручное вращение'}
                        disabled={pending}
                        onClick={event => { event.stopPropagation(); toggleManual(); }}
                    >
                        <Icon name="360" />
                    </button>
                )}
            </div>
        </div>
    );
}
