/**
 * Плеер ячейки: видео плюс слои, доступные конкретной камере.
 *
 * Типа камеры нет — есть назначения потоков. Поток neural даёт слой
 * обнаружений, поток birdview с настроенным сопоставлением — тумблер
 * коррекции. Сам выбор потока приходит сверху: на проводе это одно поле
 * stream, где коррекция — такой же ключ, как stream_2.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTransient, type ErrorInfo } from '../../components/webrtc/error-codes';
import {
    useWebRTCPlayer,
    type PlayerMessage,
    type PlayerStats,
    type PlayerStatus,
} from '../../components/webrtc/useWebRTCPlayer';
import { drawDetections, type Detection, type Track } from '../../components/webrtc/detections';
import { formatDeviceDate, formatDeviceTime } from '../../app/useDeviceClock';
import { Icon } from '../../app/Icons';
import { CellFlash, CellState, useFlash } from './CellOverlays';
import type { Overlays } from './model';

// Ключ потока коррекции: надстройка камеры перехватывает сессию по нему
const CORRECTION_STREAM = 'correction';

// Сколько ждём ответа камеры на запрос коррекции
const CORRECTION_TIMEOUT_MS = 5000;

// Камера отказала: коррекцию просили, а пайплайна нет
const CODE_CORRECTION_MISSING = 4003;

interface CellPlayerProps {
    cameraId: string;
    cameraName: string;
    signalingUrl: string;
    /** Ключ обычного потока; пусто — сервер возьмёт первый смотрибельный */
    streamKey?: string;
    /** У камеры есть поток с назначением neural */
    canDetect: boolean;
    /** Коррекция применима: есть поток birdview и настроено сопоставление */
    canCorrect: boolean;
    corrected: boolean;
    onCorrectedChange: (value: boolean) => void;
    showDetections: boolean;
    onDetectionsChange: (value: boolean) => void;
    overlays: Overlays;
    deviceTimeMs: number | null;
    collectStats: boolean;
    onStatus?: (status: PlayerStatus) => void;
    /** Измеренные показатели наружу — их показывает блок «Ячейка N» */
    onStats?: (stats: PlayerStats | null) => void;
    /** Какие кнопки слоёв показывать в самой ячейке */
    controls?: 'none' | 'correction' | 'all';
    /** Запрос коррекции извне: правая колонка идёт тем же путём, что кнопка */
    correctionRequest?: { enable: boolean; nonce: number };
    /** Идёт запрос: пока он не завершён, переключать нечего */
    onCorrectionBusy?: (busy: boolean) => void;
}

function num(value: number | null | undefined, digits: number): string {
    return value === null || value === undefined ? '—' : value.toFixed(digits).replace('.', ',');
}

export function CellPlayer({
    cameraId,
    cameraName,
    signalingUrl,
    streamKey,
    canDetect,
    canCorrect,
    corrected,
    onCorrectedChange,
    showDetections,
    onDetectionsChange,
    overlays,
    deviceTimeMs,
    collectStats,
    onStatus,
    onStats,
    controls = 'all',
    correctionRequest,
    onCorrectionBusy,
}: CellPlayerProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);

    // Рамки живут в ref: перерисовка идёт по кадрам, а не по стейту
    const detectionsRef = useRef<Detection[]>([]);
    const tracksRef = useRef<Track[]>([]);

    const [switching, setSwitching] = useState(false);

    const pendingRef = useRef(false);
    const switchTimerRef = useRef<number | null>(null);
    const switchingRef = useRef(false);
    switchingRef.current = switching;

    const { flash, show: showNote, hide: hideNote } = useFlash();

    const settle = useCallback(() => {
        setSwitching(false);
        if (switchTimerRef.current) {
            window.clearTimeout(switchTimerRef.current);
            switchTimerRef.current = null;
        }
    }, []);

    const handleMessage = useCallback((msg: PlayerMessage) => {
        if (msg.type === 'neural') {
            const meta = msg.meta as { detections?: Detection[] } | undefined;
            if (Array.isArray(meta?.detections)) {
                detectionsRef.current = meta.detections;
                if (meta.detections.length) tracksRef.current = [];
            }
            return;
        }

        if (msg.type === 'neural_tracks') {
            const meta = msg.meta as { tracks?: Track[] } | undefined;
            if (Array.isArray(meta?.tracks)) {
                tracksRef.current = meta.tracks;
                if (meta.tracks.length) detectionsRef.current = [];
            }
            return;
        }

        if (msg.type === 'correction' && pendingRef.current) {
            pendingRef.current = false;
            settle();

            if (msg.ret === 'success') {
                // Пайплайн собран; сессию поднимет очередная попытка плеера
                return;
            }

            // Просьба не выполнена: намерение снимаем, чтобы интерфейс не врал
            onCorrectedChange(false);
            showNote(typeof msg.description === 'string' && msg.description
                ? `Коррекция недоступна: ${msg.description}`
                : 'Камера не смогла включить коррекцию');
        }
    }, [onCorrectedChange, settle, showNote]);

    const stream = corrected ? CORRECTION_STREAM : streamKey;

    const { status, errorInfo, attempt, grantedStream, videoRef, stats, send } = useWebRTCPlayer({
        cameraId,
        stream,
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

    useEffect(() => {
        onCorrectionBusy?.(switching);
    }, [switching, onCorrectionBusy]);

    // Камера отдала не тот поток, что просили: тумблер не должен это скрывать
    useEffect(() => {
        if (!corrected || grantedStream === null) return;
        if (grantedStream === CORRECTION_STREAM) return;

        onCorrectedChange(false);
        showNote('Камера отдала обычный поток вместо коррекции');
    }, [corrected, grantedStream, onCorrectedChange, showNote]);

    useEffect(() => () => {
        if (switchTimerRef.current) window.clearTimeout(switchTimerRef.current);
    }, []);

    // Причина, пришедшая при живом кадре (ошибка потока), показывается плашкой:
    // пока картинка есть, занимать ею центр незачем
    useEffect(() => {
        if (status !== 'streaming' || !errorInfo) return;
        showNote(errorInfo.text, errorInfo.code, isTransient(errorInfo.code) ? 'info' : 'err');
    }, [status, errorInfo, showNote]);

    // ─── Отрисовка рамок ────────────────────────────────────────

    const detectionsOn = showDetections && canDetect;

    useEffect(() => {
        if (!detectionsOn) {
            const canvas = canvasRef.current;
            canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }

        let frame = 0;
        const draw = () => {
            frame = requestAnimationFrame(draw);
            const canvas = canvasRef.current;
            const box = boxRef.current;
            if (!canvas || !box) return;

            // Канвас пересчитывается под размер ячейки: раскрытие на весь
            // экран меняет его, а рамки нормированы к кадру
            const dpr = window.devicePixelRatio || 1;
            const width = Math.round(box.clientWidth * dpr);
            const height = Math.round(box.clientHeight * dpr);
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }

            drawDetections(canvas, videoRef.current, detectionsRef.current, tracksRef.current);
        };
        frame = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(frame);
    }, [detectionsOn, videoRef]);

    // ─── Коррекция ──────────────────────────────────────────────

    // Нажатие меняет намерение: ячейка сразу просит поток коррекции
    const applyCorrection = useCallback((enable: boolean) => {
        if (switchingRef.current) return;
        onCorrectedChange(enable);
    }, [onCorrectedChange]);

    // Пайплайна коррекции на устройстве может не быть: сетку сохранили с
    // коррекцией, а камера с тех пор перезапускалась. Камера отказывает кодом
    // 4003, мы просим собрать пайплайн, сессию поднимет очередная попытка.
    // Отметка нужна, чтобы на один отказ приходилась одна просьба: причина
    // живёт до следующего успешного подключения
    const handledFaultRef = useRef<ErrorInfo | null>(null);

    useEffect(() => {
        if (!corrected || switching) return;
        if (errorInfo?.code !== CODE_CORRECTION_MISSING) return;
        if (handledFaultRef.current === errorInfo) return;

        handledFaultRef.current = errorInfo;
        setSwitching(true);
        pendingRef.current = true;
        switchTimerRef.current = window.setTimeout(() => {
            pendingRef.current = false;
            settle();
            onCorrectedChange(false);
            showNote('Камера не ответила на запрос коррекции');
        }, CORRECTION_TIMEOUT_MS);

        if (!send({ type: 'correction', meta: { enable: true } })) {
            pendingRef.current = false;
            settle();
            showNote('Нет связи с камерой');
        }
    }, [corrected, switching, errorInfo, send, settle, showNote, onCorrectedChange]);

    // Запрос из правой колонки: nonce отличает новое нажатие от перерисовки
    const lastRequestRef = useRef(correctionRequest?.nonce ?? 0);

    useEffect(() => {
        if (!correctionRequest || correctionRequest.nonce === lastRequestRef.current) return;
        lastRequestRef.current = correctionRequest.nonce;
        applyCorrection(correctionRequest.enable);
    }, [correctionRequest, applyCorrection]);

    // ─── Разметка ───────────────────────────────────────────────

    const live = status === 'streaming';

    return (
        <div className="cellv" ref={boxRef}>
            <video ref={videoRef} autoPlay playsInline muted className="cellv-video" />

            {detectionsOn && <canvas ref={canvasRef} className="cellv-canvas" />}

            {(overlays.name || (live && overlays.stats)) && (
                <div className="cell-bar">
                    {overlays.name && <span className="nm">{cameraName}</span>}
                    {live && overlays.stats && (
                        <span className="num">
                            {num(stats?.fps, 1)} fps · {num(stats?.mbits, 1)} Мбит/с
                        </span>
                    )}
                </div>
            )}

            {!live && <CellState status={status} error={errorInfo} attempt={attempt} />}

            {overlays.time && (
                <span className="cellv-time">
                    {formatDeviceDate(deviceTimeMs)} · {formatDeviceTime(deviceTimeMs)}
                </span>
            )}

            {(canCorrect || (controls === 'all' && canDetect)) && controls !== 'none' && (
                <div className="cellv-tools" onDoubleClick={event => event.stopPropagation()}>
                    {controls === 'all' && canDetect && (
                        <button
                            className={`cellv-btn${showDetections ? ' is-on' : ''}`}
                            title={showDetections ? 'Скрыть рамки обнаружений' : 'Показать рамки обнаружений'}
                            onClick={event => { event.stopPropagation(); onDetectionsChange(!showDetections); }}
                        >
                            <Icon name="eye" />
                        </button>
                    )}
                    {canCorrect && (
                        <button
                            className={`cellv-btn${corrected ? ' is-on' : ''}`}
                            title={corrected ? 'Выключить коррекцию' : 'Включить коррекцию дисторсии'}
                            disabled={switching}
                            onClick={event => { event.stopPropagation(); applyCorrection(!corrected); }}
                        >
                            <Icon name="undist" />
                        </button>
                    )}
                </div>
            )}

            {live && flash && <CellFlash flash={flash} onClose={hideNote} />}
        </div>
    );
}
