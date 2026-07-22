import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerStatusInfo } from '../../../../components/WebRTCPlayer';
import type { BirdviewWs } from '../../hooks/useBirdviewWs';
import type { EventLog } from '../../hooks/useEventLog';
import type { CalibrationCamera, SliderKey, WsMessage } from '../../api/ws-types';
import type { StreamControl } from '../../hooks/useStreamControl';
import type { Correction } from '../../hooks/useCorrection';
import { useToast } from '../common/Toast';
import { ConnectionPanel } from './ConnectionPanel';
import { CameraPanel } from './CameraPanel';
import { CalibrationBlock } from './CalibrationBlock';
import type { PatternInfo } from './CalibrationBlock';
import { DistortionPanel } from './DistortionPanel';
import { EventLogPanel } from './EventLogPanel';
import { CalibrationViewer } from './CalibrationViewer';
import { ConfigModal } from './ConfigModal';
import type { ConfigSummary } from './ConfigModal';
import { useDistortion } from './useDistortion';
import { useSnapshots } from './useSnapshots';
import { useCalibrationProcess } from './useCalibrationProcess';

/**
 * Экран «Калибровка». Порт page-1.
 *
 * Здесь же живёт диспетчер основного WS для этого экрана: подписки на 16
 * типов сообщений регистрируются одним эффектом, как это делал switch в
 * no-react. Семнадцатый тип, projection_configuration, заберёт проекция.
 */

interface CalibrationScreenProps {
    active: boolean;
    ws: BirdviewWs;
    clientId: string;
    log: EventLog;
    camera: CalibrationCamera | null;
    onSelectCamera: (cam: CalibrationCamera) => void;
    stream: StreamControl;
    correction: Correction;
    playerInfo: PlayerStatusInfo;
    onPlayerInfo: (info: PlayerStatusInfo) => void;
}

export function CalibrationScreen({
    active,
    ws,
    clientId,
    log,
    camera,
    onSelectCamera,
    stream,
    correction,
    playerInfo,
    onPlayerInfo,
}: CalibrationScreenProps) {
    const showToast = useToast();

    const [pattern, setPattern] = useState<PatternInfo | null>(null);
    const [patternSet, setPatternSet] = useState(false);
    const [chessboard, setChessboard] = useState(false);
    const [hasCalibration, setHasCalibration] = useState(false);
    const [undistortionOk, setUndistortionOk] = useState(false);
    const [saveEnabled, setSaveEnabled] = useState(false);
    const [frameInfo, setFrameInfo] = useState('—');

    const [configs, setConfigs] = useState<ConfigSummary[] | null>(null);
    const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null);
    const [configDetail, setConfigDetail] = useState<Record<string, any> | null>(null);

    // Ответы calibration_configuration слушает ещё и useCorrection. Разбираем
    // только те, что запросила модалка этого экрана.
    const modalRequestRef = useRef(false);

    const toast = useCallback(
        (title: string, desc: string, type: 'ok' | 'err' | 'info') => showToast(title, desc, type),
        [showToast],
    );

    const distortion = useDistortion({
        ws,
        clientId,
        onError: (title, desc) => toast(title, desc, 'err'),
        log: log.log,
    });

    const snapshots = useSnapshots({ ws, clientId, log: log.log });

    const process = useCalibrationProcess({
        ws,
        clientId,
        log: log.log,
        onToast: toast,
        distortion,
        snapshots,
    });

    const streaming = playerInfo.status === 'connected';

    // Обрыв основного WS — сбрасываем всё, что зависело от сессии калибратора.
    // Стрим и коррекция общие, их сбрасывает BirdviewApp.
    useEffect(() => {
        if (ws.status !== 'disconnected') return;
        setHasCalibration(false);
        setUndistortionOk(false);
        setSaveEnabled(false);
        setChessboard(false);
        distortion.setVisible(false);
        snapshots.clear();
    }, [ws.status]);

    const handleConnection = useCallback(
        (msg: WsMessage) => {
            // Отказ окончательный: сами не повторяем, решение за оператором
            if (!msg.ret) {
                stream.settle(null);
                toast(
                    'Стрим не запущен',
                    msg.meta?.description ?? 'Калибратор отказал без объяснения',
                    'err',
                );
                return;
            }

            const id = msg.meta?.id_stream ?? null;
            if (!id) {
                stream.settle(null);
                log.log('Ошибка: сервер не вернул id_stream', 'err');
                toast('Стрим не запущен', 'Сервер не вернул id_stream', 'err');
                return;
            }

            stream.settle(String(id));
            setFrameInfo(String(id).slice(0, 8) + '...');
            log.log(`Стрим запущен: ${id}`, 'ok');

            // Статус калибровки запрашиваем сразу, не дожидаясь RTC: он про
            // калибратор, а не про видеопоток. В no-react висел на onWsOpen
            // сигналингового сокета — привязка была случайной.
            ws.send({ type: 'status', client_id: clientId, meta: {} });

            // Кадр появился — только теперь сервер примет конфигурацию коррекции:
            // load сверяет её разрешение с текущим кадром
            correction.applyPending(camera);
        },
        [ws, clientId, log, stream, correction, camera, toast],
    );

    const handleGetPattern = useCallback(
        (msg: WsMessage) => {
            if (!msg.ret) {
                log.log(`Паттерн: ${msg.meta?.description ?? ''}`, 'err');
                setHasCalibration(false);
                return;
            }
            setPattern({
                width: msg.meta?.width ?? '—',
                height: msg.meta?.height ?? '—',
                size: msg.meta?.size ?? '—',
            });
            setPatternSet(true);
        },
        [log],
    );

    const handleChessboard = useCallback(
        (msg: WsMessage) => {
            if (!msg.ret) {
                log.log(`Шахматка: ${msg.meta?.description ?? ''}`, 'err');
                return;
            }
            setChessboard(Boolean(msg.meta?.show));
        },
        [log],
    );

    const handleStatus = useCallback(
        (msg: WsMessage) => {
            if (!msg.ret) {
                log.log(`Статус: ${msg.meta?.description ?? ''}`, 'err');
                return;
            }
            const meta = msg.meta ?? {};

            if (meta.width != null) {
                distortion.setSliderConfig('shift_x', {
                    value: 0,
                    min: -meta.width,
                    max: meta.width,
                    decimals: 0,
                });
            }
            if (meta.height != null) {
                distortion.setSliderConfig('shift_y', {
                    value: 0,
                    min: -meta.height,
                    max: meta.height,
                    decimals: 0,
                });
            }

            if (meta.is_pattern) {
                setPatternSet(true);
                setPattern({
                    width: meta.pattern_width ?? '—',
                    height: meta.pattern_height ?? '—',
                    size: meta.pattern_size ?? '—',
                });
            } else {
                setPatternSet(false);
            }

            const hasCal = Boolean(meta.is_calibration);
            setHasCalibration(hasCal);

            if (hasCal) {
                const keys: SliderKey[] = ['alpha', 'zoom', 'shift_x', 'shift_y', 'k1', 'k2', 'k3', 'k4'];
                for (const k of keys) {
                    if (meta[k] !== undefined) distortion.syncSlider(k, Number(meta[k]));
                }
                distortion.setVisible(true);
            } else {
                distortion.setVisible(false);
            }

            const hasUndist = Boolean(meta.is_undistortion);
            setUndistortionOk(hasUndist);
            if (hasUndist) setSaveEnabled(true);

            setChessboard(Boolean(meta.show_chessboard));
        },
        [log, distortion],
    );

    const handleUndistortCompute = useCallback(
        (msg: WsMessage) => {
            distortion.handleCompute(msg);
            if (msg.ret && msg.meta) {
                setUndistortionOk(true);
                setHasCalibration(true);
                setSaveEnabled(true);
            }
        },
        [distortion],
    );

    const handleConfiguration = useCallback(
        (msg: WsMessage) => {
            if (!msg.meta) {
                toast('Ошибка', 'Нет meta', 'err');
                return;
            }

            switch (msg.meta.method) {
                case 'save':
                    if (msg.ret) toast('Сохранено', '', 'ok');
                    else toast('Ошибка', msg.meta.description ?? '', 'err');
                    break;

                case 'get_list':
                    if (!modalRequestRef.current) return;
                    modalRequestRef.current = false;
                    if (!msg.ret) {
                        toast('Ошибка', msg.meta.description ?? '', 'err');
                        return;
                    }
                    setConfigs(msg.meta.configs ?? []);
                    setSelectedConfigId(null);
                    setConfigDetail(null);
                    break;

                case 'get_item':
                    setConfigDetail(msg.meta.config_item ?? {});
                    break;

                case 'load':
                    // Загрузку с панели камеры и коррекции разбирает useCorrection
                    if (configs === null) return;
                    if (!msg.ret) {
                        toast('Ошибка', msg.meta.description ?? '', 'err');
                    } else {
                        toast('Загружено', selectedConfigId ?? '', 'ok');
                        setConfigs(null);
                    }
                    break;

                default:
                    log.log(`Неизвестный метод: ${msg.meta.method}`, 'warn');
            }
        },
        [toast, log, selectedConfigId, configs],
    );

    // Регистрация обработчиков — аналог switch по msg.type в no-react
    useEffect(() => {
        const unsubs = [
            ws.subscribe('connection', handleConnection),
            ws.subscribe('get_pattern', handleGetPattern),
            ws.subscribe('chessboard', handleChessboard),
            ws.subscribe('status', handleStatus),
            ws.subscribe('add_image', snapshots.handleAdd),
            ws.subscribe('delete_image', snapshots.handleRemove),
            ws.subscribe('get_image', snapshots.handleFrame),
            ws.subscribe('calibration_start', process.handleStart),
            ws.subscribe('calibration_progress', process.handleProgress),
            ws.subscribe('calibration_post_process', process.handlePostProcess),
            ws.subscribe('calibration_compute', process.handleCompute),
            ws.subscribe('calibration_result', process.handleResult),
            ws.subscribe('undistort_compute', handleUndistortCompute),
            ws.subscribe('view_undistort', distortion.handleShowUndistort),
            ws.subscribe('panorama_toggle', distortion.handlePanoramaToggle),
            ws.subscribe('calibration_configuration', handleConfiguration),
        ];
        return () => unsubs.forEach(u => u());
    }, [
        ws,
        handleConnection,
        handleGetPattern,
        handleChessboard,
        handleStatus,
        handleUndistortCompute,
        handleConfiguration,
        snapshots.handleAdd,
        snapshots.handleRemove,
        snapshots.handleFrame,
        process.handleStart,
        process.handleProgress,
        process.handlePostProcess,
        process.handleCompute,
        process.handleResult,
        distortion.handleShowUndistort,
        distortion.handlePanoramaToggle,
    ]);

    const toggleStream = () => {
        if (stream.streamId) {
            stream.close();
            return;
        }

        if (!camera) {
            log.log('Камера не выбрана!', 'warn');
            toast('Камера не выбрана', 'Выберите камеру из списка', 'err');
            return;
        }

        stream.open(camera);
    };

    return (
        <main className={`main-layout ${active ? '' : 'hidden'}`}>
            <aside className="sidebar">
                <ConnectionPanel ws={ws} />

                <CameraPanel
                    camera={camera}
                    onSelectCamera={onSelectCamera}
                    streaming={streaming}
                    canStream={ws.status === 'connected' && !stream.pending}
                    onToggleStream={toggleStream}
                    onLoadConfiguration={() => {
                        modalRequestRef.current = true;
                        ws.sendMessage('calibration_configuration', { method: 'get_list' });
                    }}
                />

                <CalibrationBlock
                    visible={streaming}
                    patternSet={patternSet}
                    pattern={pattern}
                    onSavePattern={p =>
                        ws.send({ type: 'calibrate_pattern', client_id: clientId, meta: p })
                    }
                    chessboard={chessboard}
                    onToggleChessboard={() =>
                        ws.send({
                            type: 'chessboard',
                            client_id: clientId,
                            meta: { show: !chessboard },
                        })
                    }
                    snapshotCount={snapshots.items.length}
                    onTakeSnapshot={snapshots.take}
                    onStartCalibration={process.start}
                />

                <DistortionPanel visible={hasCalibration} distortion={distortion} />

                <button
                    className={`btn btn-save-config${saveEnabled ? ' active' : ''}`}
                    disabled={!saveEnabled}
                    onClick={() => ws.sendMessage('calibration_configuration', { method: 'save' })}
                >
                    ⊛ Сохранить конфигурацию
                </button>

                <EventLogPanel log={log} />
            </aside>

            <CalibrationViewer
                streamId={stream.streamId}
                streamGeneration={stream.generation}
                pendingStream={stream.pending}
                playerInfo={playerInfo}
                onPlayerStatus={onPlayerInfo}
                overlay={process.overlay}
                onDismissOverlay={process.dismiss}
                snapshots={snapshots}
                calibrationState={hasCalibration ? 'installed' : 'none'}
                undistortionState={undistortionOk ? 'success' : 'failed'}
                frameInfo={frameInfo}
            />

            {configs !== null && (
                <ConfigModal
                    configs={configs}
                    detail={configDetail}
                    selectedId={selectedConfigId}
                    onSelect={key => {
                        setSelectedConfigId(key);
                        setConfigDetail(null);
                        ws.sendMessage('calibration_configuration', {
                            method: 'get_item',
                            config_key: key,
                        });
                    }}
                    onLoad={() => {
                        if (!selectedConfigId) return;
                        ws.sendMessage('calibration_configuration', {
                            method: 'load',
                            config_key: selectedConfigId,
                        });
                    }}
                    onClose={() => setConfigs(null)}
                />
            )}
        </main>
    );
}
