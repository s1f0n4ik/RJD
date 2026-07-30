import React, { useEffect, useRef, useState } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import { AutoFixHigh as CorrectionIcon } from '@mui/icons-material';
import WebRTCPlayer, { type SignalingSender } from './WebRTCPlayer';
import { fetchCalibrationLinks } from '../features/birdview/api/links';

/**
 * Плеер birdview-камеры: обычный поток плюс тумблер коррекции дисторсии.
 *
 * Значок появляется только у камер с настроенным сопоставлением калибровки
 * (вкладка 360 → Сопоставление). Сессия WebRTC стартует строго после ответа
 * REST — как и у остальных плееров.
 *
 * Включение: по WS камеры уходит {type:"correction", meta:{enable:true}} —
 * камера валидирует карты и поднимает пайплайн коррекции, основной поток и
 * запись не трогаются. После success внутренний плеер пересоздаётся и его
 * connection несёт correction:true — камера маршрутизирует сессию на
 * коррекционный поток. Выключение — просто пересоздание на обычный поток;
 * пайплайн коррекции на камере умирает вместе с последней своей сессией.
 * Отказ — временная плашка поверх живого видео, кнопка снова активна.
 */

interface BirdviewWebRTCPlayerProps {
    cameraId: string;
    cameraName?: string;
    signalingUrl: string;
    onError?: (error: string) => void;
    /** Включить коррекцию после первого подключения — из сохранённого отображения. */
    initialCorrected?: boolean;
    /** Текущее состояние коррекции наружу — для сохранения отображения. */
    onCorrectionChange?: (corrected: boolean) => void;
}

const SWITCH_TIMEOUT_MS = 15_000;
const NOTE_HIDE_MS = 6_000;

const BirdviewWebRTCPlayer: React.FC<BirdviewWebRTCPlayerProps> = ({
    cameraId,
    cameraName,
    signalingUrl,
    onError,
    initialCorrected,
    onCorrectionChange,
}) => {
    // Сессия не стартует, пока REST не ответил про сопоставление
    const [linksLoaded, setLinksLoaded] = useState(false);
    const [available, setAvailable] = useState(false);

    const [corrected, setCorrected] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [reconnectNonce, setReconnectNonce] = useState(0);
    const [note, setNote] = useState<string | null>(null);
    const [connected, setConnected] = useState(false);

    const signalingRef = useRef<SignalingSender | null>(null);
    const pendingEnableRef = useRef(false);
    const switchTimeoutRef = useRef<number | null>(null);
    const noteTimeoutRef = useRef<number | null>(null);
    const correctedRef = useRef(corrected);
    correctedRef.current = corrected;
    const switchingRef = useRef(switching);
    switchingRef.current = switching;
    const availableRef = useRef(available);
    availableRef.current = available;
    const onCorrectionChangeRef = useRef(onCorrectionChange);
    onCorrectionChangeRef.current = onCorrectionChange;
    const initialAppliedRef = useRef(false);

    useEffect(() => {
        onCorrectionChangeRef.current?.(corrected);
    }, [corrected]);

    useEffect(() => {
        let alive = true;
        fetchCalibrationLinks()
            .then(data => {
                if (!alive) return;
                setAvailable(Boolean(data.links[cameraId]));
            })
            .catch(() => {
                if (alive) setAvailable(false);
            })
            .finally(() => {
                if (alive) setLinksLoaded(true);
            });
        return () => {
            alive = false;
        };
    }, [cameraId]);

    useEffect(() => () => {
        if (switchTimeoutRef.current) clearTimeout(switchTimeoutRef.current);
        if (noteTimeoutRef.current) clearTimeout(noteTimeoutRef.current);
    }, []);

    const showNote = (text: string) => {
        setNote(text);
        if (noteTimeoutRef.current) clearTimeout(noteTimeoutRef.current);
        noteTimeoutRef.current = window.setTimeout(() => setNote(null), NOTE_HIDE_MS);
    };

    const settleSwitch = () => {
        setSwitching(false);
        if (switchTimeoutRef.current) {
            clearTimeout(switchTimeoutRef.current);
            switchTimeoutRef.current = null;
        }
    };

    const handleExtraMessage = (msg: Record<string, unknown>) => {
        if (msg.type !== 'correction' || !pendingEnableRef.current) return;
        pendingEnableRef.current = false;

        if (msg.ret === 'success') {
            // Пайплайн готов — переподключаемся на него, switching держится до кадра
            setCorrected(true);
            setConnected(false);
            setReconnectNonce(n => n + 1);
            return;
        }

        settleSwitch();
        showNote(
            typeof msg.description === 'string' && msg.description
                ? `Невозможно включить коррекцию: ${msg.description}`
                : 'Невозможно переключиться в режим коррекции',
        );
    };

    const handleStatusChange = (info: { status: 'connecting' | 'connected' | 'error' }) => {
        setConnected(info.status === 'connected');

        if (info.status === 'connected' && switchingRef.current && !pendingEnableRef.current) {
            settleSwitch();
            return;
        }

        // Сохранённое отображение включает коррекцию после первого подключения
        if (
            info.status === 'connected'
            && initialCorrected
            && availableRef.current
            && !correctedRef.current
            && !switchingRef.current
            && !initialAppliedRef.current
        ) {
            initialAppliedRef.current = true;
            toggleCorrection();
            return;
        }

        // Коррекционная сессия не поднялась — возвращаемся на обычный поток
        if (info.status === 'error' && switchingRef.current && correctedRef.current) {
            settleSwitch();
            setCorrected(false);
            setReconnectNonce(n => n + 1);
            showNote('Поток коррекции недоступен — возврат к обычному режиму');
        }
    };

    const toggleCorrection = () => {
        if (switching) return;
        setSwitching(true);

        if (switchTimeoutRef.current) clearTimeout(switchTimeoutRef.current);
        switchTimeoutRef.current = window.setTimeout(() => {
            pendingEnableRef.current = false;
            settleSwitch();
            showNote('Камера не ответила на запрос коррекции');
        }, SWITCH_TIMEOUT_MS);

        if (!corrected) {
            pendingEnableRef.current = true;
            const sent = signalingRef.current?.send({ type: 'correction', meta: { enable: true } });
            if (!sent) {
                pendingEnableRef.current = false;
                settleSwitch();
                showNote('Нет соединения с камерой');
            }
            return;
        }

        // Выключение: сообщений не нужно, connection уйдёт без correction
        setCorrected(false);
        setConnected(false);
        setReconnectNonce(n => n + 1);
    };

    return (
        <Box sx={{ position: 'relative', width: '100%', height: '100%', bgcolor: 'black' }}>
            {linksLoaded && (
                <WebRTCPlayer
                    key={`inner-${cameraId}-${reconnectNonce}`}
                    cameraId={cameraId}
                    cameraName={cameraName}
                    signalingUrl={signalingUrl}
                    onError={onError}
                    signalingRef={signalingRef}
                    onExtraMessage={handleExtraMessage}
                    onStatusChange={handleStatusChange}
                    connectionExtras={corrected ? { correction: true } : undefined}
                />
            )}

            {note && (
                <Box
                    sx={{
                        position: 'absolute',
                        top: 8,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        zIndex: 30,
                        maxWidth: '90%',
                        px: 1.5,
                        py: 0.75,
                        borderRadius: 1,
                        bgcolor: 'rgba(0,0,0,0.75)',
                        border: '1px solid rgba(236,95,118,0.6)',
                    }}
                >
                    <Typography variant="caption" sx={{ color: '#f0b9c3' }}>
                        {note}
                    </Typography>
                </Box>
            )}

            {available && (
                <Box sx={{ position: 'absolute', bottom: 6, right: 44, zIndex: 20 }}>
                    <Tooltip
                        title={corrected ? 'Выключить коррекцию дисторсии' : 'Коррекция дисторсии'}
                        placement="top"
                        arrow
                    >
                        <span>
                            <IconButton
                                size="small"
                                onClick={toggleCorrection}
                                disabled={switching || !connected}
                                sx={{
                                    bgcolor: 'rgba(0,0,0,0.55)',
                                    color: corrected
                                        ? 'success.light'
                                        : switching || !connected
                                          ? 'grey.600'
                                          : 'grey.300',
                                    width: 32,
                                    height: 32,
                                    '&:hover': { bgcolor: 'rgba(0,0,0,0.8)' },
                                }}
                            >
                                <CorrectionIcon fontSize="small" />
                            </IconButton>
                        </span>
                    </Tooltip>
                </Box>
            )}
        </Box>
    );
};

export default BirdviewWebRTCPlayer;
