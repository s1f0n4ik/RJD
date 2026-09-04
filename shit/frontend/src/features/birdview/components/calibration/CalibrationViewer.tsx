import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { Switch } from '../../../../app/Modal';
import type { CalibrationCamera } from '../../api/ws-types';
import type { EventLog } from '../../hooks/useEventLog';
import type { ConnState } from '../../types';
import type { SessionReason } from '../../hooks/useBirdviewWs';
import type { StreamPlayerState } from '../shared/StreamPlayer';
import type { PlayerStatus } from '../../../../components/webrtc/useWebRTCPlayer';
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

const RTC_WORDS: Record<PlayerStatus, string> = {
    connecting: 'подключение',
    signaling: 'согласование',
    streaming: 'идёт',
    reconnecting: 'переподключение',
    error: 'ошибка',
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
    // Запрос стрима отправлен, ответа калибратора ещё нет
    pendingStream: boolean;
    playerState: StreamPlayerState | null;
    // Узел, в который раздел переносит общий плеер
    onPlayerHost: (node: HTMLElement | null) => void;
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
    pendingStream,
    playerState,
    onPlayerHost,
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

    const loadThumbs = snapshots.loadThumbs;

    // Превью тянем только когда шторка открыта и вкладка со снимками
    useEffect(() => {
        if (!drawerOpen || tab !== 'snaps') return;
        loadThumbs();
    }, [drawerOpen, tab, snapshots.items.length, loadThumbs]);

    const toggleFullscreen = () => {
        const el = stageRef.current;
        if (!el) return;
        if (!document.fullscreenElement) el.requestFullscreen?.();
        else document.exitFullscreen?.();
    };

    const wsConnected = wsState === 'connected';

    const calibratorWord =
        wsState === 'disconnected' && wsReason ? REASON_WORDS[wsReason] : WS_WORDS[wsState];

    const stats = playerState?.stats ?? null;

    const fps = stats?.fps != null ? Math.round(stats.fps) : camera?.fps ?? null;

    // Нет сокета — отказ, нет потока при живом сокете — штатная ситуация
    const pillClass = wsState !== 'connected' ? 'err' : rtcState === 'connected' ? 'ok' : 'warn';

    const streamText =
        wsState !== 'connected'
            ? 'Нет подключения'
            : rtcState === 'connected'
              ? `Поток · ${fps ?? '—'} fps`
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
                    <span className={`pill has-tip ${pillClass}`}>
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
                                <span className="k">Поток</span>
                                <span className={`v ${STATE_CLASS[rtcState]}`}>
                                    {playerState ? RTC_WORDS[playerState.status] : 'нет'}
                                    {playerState && playerState.attempt > 0 && ` · попытка ${playerState.attempt + 1}`}
                                </span>
                            </div>
                            <div className="kv">
                                <span className="k">Кадры/с</span>
                                <span className="v">{stats?.fps != null ? Math.round(stats.fps) : '—'}</span>
                            </div>
                            <div className="kv">
                                <span className="k">Битрейт</span>
                                <span className="v">{stats?.mbits != null ? `${stats.mbits.toFixed(1)} Мбит/с` : '—'}</span>
                            </div>
                            <div className="kv">
                                <span className="k">Задержка</span>
                                <span className="v">{stats?.rttMs != null ? `${Math.round(stats.rttMs)} мс` : '—'}</span>
                            </div>
                            <div className="kv">
                                <span className="k">Потери</span>
                                <span className="v">{stats?.lossPct != null ? `${stats.lossPct.toFixed(1)} %` : '—'}</span>
                            </div>
                            <div className="kv">
                                <span className="k">Кадр</span>
                                <span className="v">
                                    {playerState?.width ? `${playerState.width}×${playerState.height}` : '—'}
                                </span>
                            </div>
                            <div className="kv">
                                <span className="k">Идентификатор</span>
                                <span className="v">{streamId ?? '—'}</span>
                            </div>
                            <div className="kv">
                                <span className="k">Камера</span>
                                <span className="v">
                                    {camera ? `${camera.id} · ${camera.width}×${camera.height}` : '—'}
                                </span>
                            </div>
                            {playerState?.error && (
                                <div className="kv">
                                    <span className="k">Причина</span>
                                    <span className="v err">
                                        {playerState.error.text}
                                        {playerState.error.code !== null && ` · ${playerState.error.code}`}
                                    </span>
                                </div>
                            )}
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
                        <div className="player" ref={onPlayerHost} />
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
                            <button className="btn btn--sm btn--ok" onClick={snapshots.resumeStream}>
                                <Icon name="play" size={13} className="ico" />
                                Вернуться к потоку
                            </button>
                        </div>
                    )}

                    {overlay && <CalibrationOverlay state={overlay} onDismiss={onDismissOverlay} />}
                </div>
            </div>

            <div className={`snap-sheet${drawerOpen ? ' is-open' : ''}`}>
                <div className="snap-sheet-h">
                    <button className="snap-anchor" onClick={() => setDrawerOpen(o => !o)}>
                        Снимки
                        <span className="n">{count}</span>
                        <Icon name="chev" size={11} className="ico" />
                    </button>
                </div>

                <div className="snap-sheet-b">
                    <div className="snap-sheet-main">
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
                                            {snapshots.thumbs[s.id] ? (
                                                <img src={snapshots.thumbs[s.id]} alt="" />
                                            ) : (
                                                <span className="ph">
                                                    <Icon name="img" className="ico" />
                                                </span>
                                            )}
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

                    <div className="snap-sheet-side">
                        <button
                            className={`vtab${tab === 'snaps' ? ' is-on' : ''}`}
                            onClick={() => setTab('snaps')}
                        >
                            <Icon name="img" size={16} className="ico" />
                            Снимки
                            <span className="c">{count}</span>
                        </button>
                        <button className={`vtab${tab === 'log' ? ' is-on' : ''}`} onClick={() => setTab('log')}>
                            <Icon name="list" size={16} className="ico" />
                            Журнал
                            <span className="c">{log.entries.length}</span>
                        </button>

                        <button
                            className="btn btn--sm btn--ghost vtab-foot"
                            onClick={tab === 'snaps' ? snapshots.requestClear : log.clear}
                            disabled={tab === 'snaps' && count === 0}
                        >
                            Очистить
                        </button>
                    </div>
                </div>
            </div>

        </>
    );
}
