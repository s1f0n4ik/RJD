import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerStatusInfo } from '../../../../components/WebRTCPlayer';
import { Icon } from '../../../../app/Icons';
import type { BirdviewWs } from '../../hooks/useBirdviewWs';
import type { EventLog } from '../../hooks/useEventLog';
import type { CalibrationCamera, SliderKey, WsMessage } from '../../api/ws-types';
import type { StreamControl } from '../../hooks/useStreamControl';
import type { Correction } from '../../hooks/useCorrection';
import type { ConnState } from '../../types';
import { useToast } from '../common/Toast';
import { CameraPanel } from './CameraPanel';
import { CalibrationBlock } from './CalibrationBlock';
import type { PatternInfo } from './CalibrationBlock';
import { DistortionPanel } from './DistortionPanel';
import { CalibrationViewer } from './CalibrationViewer';
import { ConfigModal } from './ConfigModal';
import type { ConfigSummary } from './ConfigModal';
import { SaveConfigModal } from './SaveConfigModal';
import { useDistortion } from './useDistortion';
import { useSnapshots } from './useSnapshots';
import { useCalibrationProcess } from './useCalibrationProcess';
import '../../../../screens/surround/calibration.css';

// Экран «Калибровка». Здесь же диспетчер основного WS: подписки на 16 типов
// сообщений одним эффектом; projection_configuration забирает проекция

interface CalibrationScreenProps {
    active: boolean;
    ws: BirdviewWs;
    wsState: ConnState;
    rtcState: ConnState;
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
    wsState,
    rtcState,
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
    // Последний undistort_compute вернул ошибку
    const [undistortionErr, setUndistortionErr] = useState(false);
    const [saveEnabled, setSaveEnabled] = useState(false);

    const [configs, setConfigs] = useState<ConfigSummary[] | null>(null);
    const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null);
    const [configDetail, setConfigDetail] = useState<Record<string, any> | null>(null);

    // Ответы calibration_configuration слушает ещё и useCorrection: разбираем только свои
    const modalRequestRef = useRef(false);

    // Сохранение под своим ключом: список нужен для свободного ключа и распознавания перезаписи
    const [saveOpen, setSaveOpen] = useState(false);
    const [saveKnown, setSaveKnown] = useState<ConfigSummary[]>([]);
    const [saving, setSaving] = useState(false);
    const saveRequestRef = useRef(false);

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

    // Обрыв основного WS сбрасывает всё, что зависело от сессии калибратора
    useEffect(() => {
        if (ws.status !== 'disconnected') return;
        setHasCalibration(false);
        setUndistortionOk(false);
        setUndistortionErr(false);
        setSaveEnabled(false);
        setChessboard(false);
        distortion.setVisible(false);
        snapshots.clear();
    }, [ws.status]);

    const handleConnection = useCallback(
        (msg: WsMessage) => {
            // Отказ окончательный: повтор за оператором
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
            log.log(`Стрим запущен: ${id}`, 'ok');

            // Статус калибровки запрашиваем сразу, не дожидаясь RTC
            ws.send({ type: 'status', client_id: clientId, meta: {} });

            // Кадр появился: сервер сверяет разрешение конфигурации с ним
            correction.applyPending(camera);
        },
        [ws, clientId, log, stream, correction, camera, toast],
    );

    const handleGetPattern = useCallback(
        (msg: WsMessage) => {
            if (!msg.ret) {
                log.log(`Шаблон: ${msg.meta?.description ?? ''}`, 'err');
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
            if (hasUndist) {
                setSaveEnabled(true);
                setUndistortionErr(false);
            }

            setChessboard(Boolean(meta.show_chessboard));
        },
        [log, distortion],
    );

    const handleUndistortCompute = useCallback(
        (msg: WsMessage) => {
            distortion.handleCompute(msg);
            setUndistortionErr(!msg.ret);
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
                    setSaving(false);
                    if (msg.ret) {
                        setSaveOpen(false);
                        toast('Сохранено', msg.meta.config_key ?? '', 'ok');
                    } else {
                        toast('Ошибка', msg.meta.description ?? '', 'err');
                    }
                    break;

                case 'get_list':
                    // Список могли запросить и ради подстановки ключа при сохранении
                    if (saveRequestRef.current) {
                        saveRequestRef.current = false;
                        if (msg.ret) {
                            setSaveKnown(msg.meta.configs ?? []);
                            setSaveOpen(true);
                        } else {
                            toast('Ошибка', msg.meta.description ?? '', 'err');
                        }
                        return;
                    }
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
                    // Все загрузки идут через useCorrection
                    break;

                default:
                    log.log(`Неизвестный метод: ${msg.meta.method}`, 'warn');
            }
        },
        [toast, log],
    );

    // Регистрация обработчиков по msg.type
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

    const toggleWs = () => {
        if (ws.status === 'disconnected') ws.connect();
        else ws.disconnect();
    };

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
        <div className={`sv sv-calib${active ? '' : ' is-hidden'}`}>
            <div className="sv-main">
                <CalibrationViewer
                    wsState={wsState}
                    wsReason={ws.reason}
                    onToggleWs={toggleWs}
                    rtcState={rtcState}
                    camera={camera}
                    streamId={stream.streamId}
                    streamGeneration={stream.generation}
                    pendingStream={stream.pending}
                    playerInfo={playerInfo}
                    onPlayerStatus={onPlayerInfo}
                    overlay={process.overlay}
                    onDismissOverlay={process.dismiss}
                    snapshots={snapshots}
                    log={log}
                    streaming={streaming}
                    chessboard={chessboard}
                    onToggleChessboard={() =>
                        ws.send({
                            type: 'chessboard',
                            client_id: clientId,
                            meta: { show: !chessboard },
                        })
                    }
                    showUndistort={distortion.showUndistort}
                    canShowUndistort={undistortionOk}
                    onToggleUndistort={distortion.toggleShowUndistort}
                    hasCalibration={hasCalibration}
                    undistortionOk={undistortionOk}
                    undistortionErr={undistortionErr}
                />
            </div>

            <aside className="mod-side">
                <CameraPanel
                    camera={camera}
                    onSelectCamera={onSelectCamera}
                    fits={correction.fits}
                    loadedKey={correction.loadedKey}
                    streamOpen={Boolean(stream.streamId)}
                    pending={stream.pending}
                    wsReady={ws.status === 'connected'}
                    onToggleStream={toggleStream}
                    onLoadConfiguration={() => {
                        modalRequestRef.current = true;
                        ws.sendMessage('calibration_configuration', { method: 'get_list' });
                    }}
                />

                {streaming && (
                    <CalibrationBlock
                        patternSet={patternSet}
                        pattern={pattern}
                        onSavePattern={p =>
                            ws.send({ type: 'calibrate_pattern', client_id: clientId, meta: p })
                        }
                        snapshotCount={snapshots.items.length}
                        onTakeSnapshot={snapshots.take}
                        onClearSnapshots={snapshots.requestClear}
                        onStartCalibration={process.start}
                    />
                )}

                {hasCalibration && <DistortionPanel distortion={distortion} rms={process.rms} />}

                {saveEnabled && (
                    <>
                        <div className="blk-h">
                            <h3>Сохранение</h3>
                        </div>
                        <div className="blk-b pad">
                            <button
                                className="btn btn--save btn--wide"
                                onClick={() => {
                                    // Список тянем перед окном: по нему подставляется свободный ключ
                                    saveRequestRef.current = true;
                                    ws.sendMessage('calibration_configuration', { method: 'get_list' });
                                }}
                            >
                                <Icon name="save" className="ico" />
                                Сохранить конфигурацию
                            </button>
                        </div>
                    </>
                )}
            </aside>

            {saveOpen && camera && (
                <SaveConfigModal
                    existing={saveKnown}
                    cameraId={camera.id}
                    cameraName={camera.displayName}
                    width={camera.width}
                    height={camera.height}
                    pattern={patternSet ? pattern : null}
                    rms={process.rms}
                    saving={saving}
                    onClose={() => setSaveOpen(false)}
                    onSubmit={(key, name) => {
                        setSaving(true);
                        ws.sendMessage('calibration_configuration', {
                            method: 'save',
                            config_key: key,
                            name,
                        });
                    }}
                />
            )}

            {configs !== null && (
                <ConfigModal
                    configs={configs}
                    detail={configDetail}
                    selectedId={selectedConfigId}
                    loadedKey={correction.loadedKey}
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
                        // Общий путь загрузки: fits() и авто-показ в useCorrection
                        correction.select(selectedConfigId);
                        setConfigs(null);
                    }}
                    onClose={() => setConfigs(null)}
                />
            )}
        </div>
    );
}
