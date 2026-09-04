import { useRef, useState } from 'react';
import WebRTCPlayer from '../../../../components/WebRTCPlayer';
import type { PlayerStatusInfo } from '../../../../components/WebRTCPlayer';
import { Icon } from '../../../../app/Icons';
import { Switch } from '../../../../app/Modal';
import { wsUrl } from '../../constants';
import type { CalibrationCamera } from '../../api/ws-types';
import type { EventLog } from '../../hooks/useEventLog';
import type { ConnState } from '../../types';
import type { SessionReason } from '../../hooks/useBirdviewWs';
import { CalibrationOverlay } from './CalibrationOverlay';
import { EventLogPanel } from './EventLogPanel';
import type { CalOverlayState } from './useCalibrationProcess';
import type { Snapshots } from './useSnapshots';

// Полоса над кадром, кадр с оверлеями и шторка снимков/журнала.
// Кадр снимка лежит непрозрачным слоем поверх плеера: video не размонтируется

const WS_WORDS: Record<ConnState, string> = {
    connected: 'подключён',
    connecting: 'подключение',
    disconnected: 'нет связи',
};

// Причина обрыва вместо глухого «нет связи»
const REASON_WORDS: Record<SessionReason, string> = {
    'no-calibrator': 'не запущен',
    busy: 'занят другим',
    revoked: 'сессию перехватили',
    declined: 'перехват отклонён',
    timeout: 'время вышло',
    manual: 'отключён',
    closed: 'нет связи',
};

const STATE_CLASS: Record<ConnState, string> = {
    connected: 'ok',
    connecting: 'warn',
    disconnected: 'err',
};

interface CalibrationViewerProps {
    wsState: ConnState;
    // Причина последнего отказа брокера; уточняет слово в подсказке
    wsReason: SessionReason | null;
    onToggleWs: () => void;
    rtcState: ConnState;
    camera: CalibrationCamera | null;
    streamId: string | null;
    // Номер пересборки пайплайна: id_stream у калибратора константа
    streamGeneration: number;
    // Запрос стрима отправлен, ответа калибратора ещё нет
    pendingStream: boolean;
    playerInfo: PlayerStatusInfo;
    onPlayerStatus: (info: PlayerStatusInfo) => void;
    overlay: CalOverlayState | null;
    onDismissOverlay: () => void;
    snapshots: Snapshots;
    log: EventLog;
    streaming: boolean;
    chessboard: boolean;
    onToggleChessboard: () => void;
    showUndistort: boolean;
    canShowUndistort: boolean;
    onToggleUndistort: () => void;
    hasCalibration: boolean;
    undistortionOk: boolean;
    undistortionErr: boolean;
}

export function CalibrationViewer({
    wsState,
    wsReason,
    onToggleWs,
    rtcState,
    camera,
    streamId,
    streamGeneration,
    pendingStream,
    playerInfo,
    onPlayerStatus,
    overlay,
    onDismissOverlay,
    snapshots,
    log,
    streaming,
    chessboard,
    onToggleChessboard,
    showUndistort,
    canShowUndistort,
    onToggleUndistort,
    hasCalibration,
    undistortionOk,
    undistortionErr,
}: CalibrationViewerProps) {
    const stageRef = useRef<HTMLDivElement>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [tab, setTab] = useState<'snaps' | 'log'>('snaps');

    const toggleFullscreen = () => {
        const el = stageRef.current;
        if (!el) return;
        if (!document.fullscreenElement) el.requestFullscreen?.();
        else document.exitFullscreen?.();
    };

    const wsConnected = wsState === 'connected';

    const calibratorWord =
        wsState === 'disconnected' && wsReason ? REASON_WORDS[wsReason] : WS_WORDS[wsState];

    const streamText =
        rtcState === 'connected'
            ? `Поток · ${camera?.fps ?? '—'} fps`
            : rtcState === 'connecting'
              ? 'Подключение…'
              : 'Нет потока';

    const count = snapshots.items.length;

    return (
        <>
            <div className="toolbar">
                <div className={`seg${canShowUndistort ? '' : ' is-off'}`}>
                    <button
                        className={showUndistort ? '' : 'is-on'}
                        onClick={() => {
                            if (showUndistort) onToggleUndistort();
                        }}
                    >
                        Кадр
                    </button>
                    <button
                        className={showUndistort ? 'is-on' : ''}
                        onClick={() => {
                            if (!showUndistort) onToggleUndistort();
                        }}
                    >
                        С коррекцией
                    </button>
                </div>

                {streaming && (
                    <Switch on={chessboard} onToggle={onToggleChessboard}>
                        Шахматка
                    </Switch>
                )}

                <div className="pills">
                    <span className={`pill has-tip ${STATE_CLASS[rtcState]}`}>
                        <span className="dot" />
                        {streamText}
                        <div className="tipbox">
                            <div className="kv">
                                <span className="k">Калибратор</span>
                                <span className={`v ${STATE_CLASS[wsState]}`}>{calibratorWord}</span>
                                <button
                                    className="tip-btn"
                                    onClick={onToggleWs}
                                    disabled={wsState === 'connecting'}
                                    aria-label={wsConnected ? 'Отключиться от калибратора' : 'Подключиться к калибратору'}
                                    title={wsConnected ? 'Отключиться от калибратора' : 'Подключиться к калибратору'}
                                >
                                    <Icon name={wsConnected ? 'unlink' : 'link'} size={13} />
                                </button>
                            </div>
                            <div className="kv">
                                <span className="k">ICE</span>
                                <span className="v">{playerInfo.ice}</span>
                            </div>
                            <div className="kv">
                                <span className="k">Соединение</span>
                                <span className="v">{playerInfo.conn}</span>
                            </div>
                            <div className="kv">
                                <span className="k">Поток</span>
                                <span className="v">{streamId ?? '—'}</span>
                            </div>
                            <div className="kv">
                                <span className="k">Камера</span>
                                <span className="v">
                                    {camera ? `${camera.id} · ${camera.width}×${camera.height}` : '—'}
                                </span>
                            </div>
                        </div>
                    </span>
                    <span className={`pill${hasCalibration ? ' ok' : ''}`}>
                        <span className="dot" />
                        Калибровка
                    </span>
                    <span className={`pill${undistortionOk ? ' ok' : undistortionErr ? ' err' : ''}`}>
                        <span className="dot" />
                        Коррекция
                    </span>
                    <span className="tbar-sep" />
                    <button
                        className="icon-btn"
                        data-tip="Вернуться к потоку"
                        onClick={snapshots.resumeStream}
                        disabled={!snapshots.frame}
                    >
                        <Icon name="play" size={15} />
                    </button>
                    <button className="icon-btn" data-tip="Полный экран" onClick={toggleFullscreen}>
                        <Icon name="full" size={15} />
                    </button>
                </div>
            </div>

            <div className="sv-stage">
                <div ref={stageRef} className="stream">
                    {streamId ? (
                        <div className="player">
                            <WebRTCPlayer
                                key={`${streamId}-${streamGeneration}`}
                                cameraId={streamId}
                                signalingUrl={wsUrl(`/signaling/client/${streamId}`)}
                                onStatusChange={onPlayerStatus}
                            />
                        </div>
                    ) : pendingStream ? (
                        <div className="empty">
                            <span className="spin" />
                            <b>Ожидание подключения</b>
                        </div>
                    ) : (
                        <div className="empty">
                            <Icon name="empty" className="ico" />
                            <b>Нет сигнала</b>
                        </div>
                    )}

                    {snapshots.frame && <img className="snapshot" src={snapshots.frame.url} alt="" />}

                    {camera && (
                        <div className="stream-tag">
                            <span className={`pill${streaming ? ' ok' : ''}`}>
                                <span className="dot" />
                                {camera.displayName}
                            </span>
                            <span className="pill">{`${camera.width}×${camera.height}`}</span>
                        </div>
                    )}
                    {streamId && (
                        <div className="stream-tag r">
                            <span className="pill num">{streamId}</span>
                        </div>
                    )}
                    {snapshots.frame && (
                        <div className="snapmark">
                            <span className="pill">снимок {String(snapshots.frame.id).padStart(3, '0')}</span>
                        </div>
                    )}

                    {overlay && <CalibrationOverlay state={overlay} onDismiss={onDismissOverlay} />}
                </div>

                <div className={`sv-drawer${drawerOpen ? ' is-open' : ''}`}>
                    <div className="sv-anchor" onClick={() => setDrawerOpen(o => !o)}>
                        <i />
                        Снимки · {count}
                        <i />
                    </div>
                    <div className="sv-drawer-b">
                        <div className="sv-drawer-h">
                            <div className="seg seg--xs">
                                <button className={tab === 'snaps' ? 'is-on' : ''} onClick={() => setTab('snaps')}>
                                    Снимки · {count}
                                </button>
                                <button className={tab === 'log' ? 'is-on' : ''} onClick={() => setTab('log')}>
                                    Журнал
                                </button>
                            </div>
                            {tab === 'snaps' ? (
                                <button
                                    className="btn btn--sm btn--ghost spacer"
                                    onClick={snapshots.requestClear}
                                    disabled={count === 0}
                                >
                                    Удалить все
                                </button>
                            ) : (
                                <button className="btn btn--sm btn--ghost spacer" onClick={log.clear}>
                                    Очистить
                                </button>
                            )}
                        </div>

                        {tab === 'snaps' ? (
                            count === 0 ? (
                                <div className="snaps-empty">Снимков нет</div>
                            ) : (
                                <div className="snaps">
                                    {snapshots.items.map(s => (
                                        <div
                                            key={s.id}
                                            className={`snap${snapshots.frame?.id === s.id ? ' is-sel' : ''}`}
                                            onClick={() => snapshots.requestFrame(s.id)}
                                        >
                                            <Icon name="img" className="ico" />
                                            <span className="n">{String(s.id).padStart(3, '0')}</span>
                                            <span className={`dot d${s.used ? ' ok' : ''}`} />
                                            <span
                                                className="x"
                                                onClick={e => {
                                                    e.stopPropagation();
                                                    snapshots.requestRemove(s.id);
                                                }}
                                            >
                                                <Icon name="x" size={11} />
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )
                        ) : (
                            <EventLogPanel log={log} />
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}
