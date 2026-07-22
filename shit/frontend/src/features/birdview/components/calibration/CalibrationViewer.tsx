import { useRef, useState } from 'react';
import WebRTCPlayer from '../../../../components/WebRTCPlayer';
import type { PlayerStatusInfo } from '../../../../components/WebRTCPlayer';
import { wsUrl } from '../../constants';
import { CalibrationOverlay } from './CalibrationOverlay';
import type { CalOverlayState } from './useCalibrationProcess';
import type { Snapshots } from './useSnapshots';

/**
 * Область просмотра калибровки. Порт viewer-area.
 *
 * Кадром владеет WebRTCPlayer; всё остальное — оверлеи поверх него.
 * Кадр снимка кладётся непрозрачным слоем, а не подменяет video: иначе
 * возврат к стриму стоил бы полного переподключения WebRTC.
 */

interface CalibrationViewerProps {
    streamId: string | null;
    /** Запрос стрима отправлен, ответа калибратора ещё нет. */
    pendingStream: boolean;
    playerInfo: PlayerStatusInfo;
    onPlayerStatus: (info: PlayerStatusInfo) => void;
    overlay: CalOverlayState | null;
    onDismissOverlay: () => void;
    snapshots: Snapshots;
    calibrationState: 'installed' | 'none';
    undistortionState: 'success' | 'failed';
    frameInfo: string;
}

export function CalibrationViewer({
    streamId,
    pendingStream,
    playerInfo,
    onPlayerStatus,
    overlay,
    onDismissOverlay,
    snapshots,
    calibrationState,
    undistortionState,
    frameInfo,
}: CalibrationViewerProps) {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);

    const toggleFullscreen = () => {
        const el = wrapperRef.current;
        if (!el) return;
        if (!document.fullscreenElement) el.requestFullscreen?.();
        else document.exitFullscreen?.();
    };

    return (
        <section className="viewer-area">
            <div className="viewer-header">
                <span className="viewer-label">LIVE STREAM — Этап 1: Калибровка</span>
                <div className="viewer-meta">
                    <span className="meta-tag">stream: {streamId ?? '—'}</span>
                    <span className="meta-tag">{frameInfo}</span>
                </div>
            </div>

            <div ref={wrapperRef} className="video-wrapper">
                {streamId ? (
                    <div className="video-player-slot">
                        <WebRTCPlayer
                            key={streamId}
                            cameraId={streamId}
                            signalingUrl={wsUrl(`/signaling/client/${streamId}`)}
                            onStatusChange={onPlayerStatus}
                        />
                    </div>
                ) : pendingStream ? (
                    <div className="no-signal">
                        <div className="cal-spinner" />
                        <div className="no-signal-text">Ожидание подключения</div>
                        <div className="no-signal-sub">Калибратор поднимает поток, это занимает время</div>
                    </div>
                ) : (
                    <div className="no-signal">
                        <div className="no-signal-icon">⊘</div>
                        <div className="no-signal-text">Нет сигнала</div>
                        <div className="no-signal-sub">Подключитесь к серверу и запустите стрим</div>
                    </div>
                )}

                {snapshots.frame && (
                    <>
                        <img className="snapshot-frame" src={snapshots.frame.url} alt="" />
                        <div className="snapshot-indicator">
                            <span className="snapshot-indicator-icon">⊙</span>
                            <span>snapshot # {String(snapshots.frame.id).padStart(3, '0')}</span>
                        </div>
                    </>
                )}

                {overlay && <CalibrationOverlay state={overlay} onDismiss={onDismissOverlay} />}
            </div>

            <div className="viewer-footer">
                <div className="footer-left">
                    <div className={`state-badge ${badgeClass(playerInfo.ice)}`}>ICE: {playerInfo.ice}</div>
                    <div className={`state-badge ${badgeClass(playerInfo.conn)}`}>CONN: {playerInfo.conn}</div>
                    <div className={`state-badge ${calibrationState === 'installed' ? 'ok' : 'err'}`}>
                        Калибровка: {calibrationState}
                    </div>
                    <div className={`state-badge ${undistortionState === 'success' ? 'ok' : 'err'}`}>
                        Коррекция: {undistortionState}
                    </div>
                </div>
                <div className="footer-right">
                    <button
                        className="btn btn-accent btn-sm"
                        onClick={snapshots.resumeStream}
                        disabled={!snapshots.frame}
                    >
                        <span>▶ Вернуться к стриму</span>
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={toggleFullscreen}>
                        ⛶ Fullscreen
                    </button>
                </div>
            </div>

            <div className={`snapshot-drawer${drawerOpen ? ' open' : ''}`}>
                <button
                    className="snapshot-drawer-tab"
                    onClick={() => setDrawerOpen(o => !o)}
                    title="Снимки"
                >
                    <span className="drawer-arrow">‹</span>
                    <span className="drawer-tab-label">Снимки</span>
                    <span className="drawer-count">{snapshots.items.length}</span>
                </button>

                <div className="snapshot-drawer-body">
                    <div
                        className="block-header"
                        style={{ padding: '14px 14px 8px', borderBottom: '1px solid var(--bv-border)' }}
                    >
                        <span className="block-icon">⊟</span>
                        <span className="block-title">Снимки</span>
                        <button className="btn-icon" onClick={snapshots.requestClear} title="Очистить всё">
                            ✕
                        </button>
                    </div>
                    <div className="snapshot-list" style={{ padding: '8px 14px', flex: 1, minHeight: 0 }}>
                        {snapshots.items.map(s => (
                            <div
                                key={s.id}
                                className="snapshot-item"
                                onClick={() => snapshots.requestFrame(s.id)}
                            >
                                <span className="snapshot-item-id">
                                    # {String(s.id).padStart(3, '0')}
                                </span>
                                <span
                                    className={`snapshot-used${s.used ? ' used' : ''}`}
                                    title={s.used ? 'использован' : 'не использован'}
                                />
                                <button
                                    className="btn-icon"
                                    title="Удалить"
                                    onClick={e => {
                                        e.stopPropagation();
                                        snapshots.requestRemove(s.id);
                                    }}
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}

function badgeClass(state: string): string {
    if (state === 'connected' || state === 'completed') return 'ok';
    if (state === 'failed' || state === 'disconnected' || state === 'closed') return 'err';
    if (state === '—') return '';
    return 'warn';
}
