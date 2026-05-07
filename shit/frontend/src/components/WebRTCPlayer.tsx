import React from 'react';
import { Box, Typography, CircularProgress, IconButton, Paper } from '@mui/material';
import { Fullscreen, Error as ErrorIcon, SignalWifi4Bar, SignalWifiOff } from '@mui/icons-material';
import { useWebRTCPlayer, PlayerStatus } from './webrtc/useWebRTCPlayer';

interface WebRTCPlayerProps {
    cameraId: string;
    signalingUrl: string;
    onError?: (error: string) => void;
}

// ─── Статусная метка в углу ─────────────────────────────────────────────────

const STATUS_LABELS: Record<PlayerStatus, string> = {
    connecting: 'Подключение...',
    signaling: 'Согласование...',
    streaming: '',          // скрываем метку при активном стриме
    reconnecting: 'Переподключение...',
    error: 'Ошибка',
};

const STATUS_COLOR: Record<PlayerStatus, string> = {
    connecting: '#facc15',
    signaling: '#60a5fa',
    streaming: '#4ade80',
    reconnecting: '#f97316',
    error: '#f87171',
};

// ─── Компонент ──────────────────────────────────────────────────────────────

const WebRTCPlayer: React.FC<WebRTCPlayerProps> = ({ cameraId, signalingUrl, onError }) => {
    const { status, errorMsg, videoRef } = useWebRTCPlayer({ cameraId, signalingUrl });

    const isStreaming = status === 'streaming';
    const isOverlayVisible = !isStreaming;

    const handleFullscreen = () => {
        videoRef.current?.requestFullscreen?.();
    };

    return (
        <Paper
            elevation={3}
            sx={{
                position: 'relative',
                bgcolor: '#0a0a0a',
                overflow: 'hidden',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 1,
            }}
        >
            {/* ── Шапка ───────────────────────────────────────────────────────── */}
            <Box
                sx={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bgcolor: 'rgba(0,0,0,0.65)',
                    backdropFilter: 'blur(4px)',
                    color: 'white',
                    px: 1.5,
                    py: 0.75,
                    zIndex: 10,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                }}
            >
                {/* Название камеры + индикатор статуса */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Box
                        sx={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            bgcolor: STATUS_COLOR[status],
                            boxShadow: `0 0 6px ${STATUS_COLOR[status]}`,
                            flexShrink: 0,
                        }}
                    />
                    <Typography variant="body2" fontWeight="bold" fontSize={13}>
                        {cameraId}
                    </Typography>
                    {STATUS_LABELS[status] && (
                        <Typography
                            variant="caption"
                            sx={{ color: STATUS_COLOR[status], fontSize: 11, opacity: 0.9 }}
                        >
                            {STATUS_LABELS[status]}
                        </Typography>
                    )}
                </Box>

                {/* Кнопки управления */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    {isStreaming && (
                        //<IconButton size="small" onClick={handleFullscreen} sx={{ color: 'white' }}>
                        //    <Fullscreen fontSize="small" />
                        //</IconButton>
                    )}
                </Box>
            </Box>

            {/* ── Видео ────────────────────────────────────────────────────────── */}
            <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    display: isStreaming ? 'block' : 'none',
                }}
            />

            {/* ── Оверлей при не-стриминге ──────────────────────────────────── */}
            {isOverlayVisible && (
                <Box
                    display="flex"
                    flexDirection="column"
                    alignItems="center"
                    justifyContent="center"
                    gap={2}
                    sx={{ flexGrow: 1, color: 'white', px: 2 }}
                >
                    {(status === 'connecting' || status === 'signaling') && (
                        <>
                            <CircularProgress size={36} sx={{ color: STATUS_COLOR[status] }} />
                            <Typography variant="body2" color="grey.400">
                                {STATUS_LABELS[status]}
                            </Typography>
                        </>
                    )}

                    {status === 'reconnecting' && (
                        <>
                            <SignalWifiOff sx={{ fontSize: 40, color: STATUS_COLOR.reconnecting }} />
                            <Typography variant="body2" color="grey.300" textAlign="center">
                                {errorMsg || 'Переподключение...'}
                            </Typography>
                        </>
                    )}

                    {status === 'error' && (
                        <>
                            <ErrorIcon sx={{ fontSize: 40, color: 'error.main' }} />
                            <Typography variant="body2" color="grey.300" textAlign="center">
                                {errorMsg}
                            </Typography>
                        </>
                    )}
                </Box>
            )}
        </Paper>
    );
};

export default WebRTCPlayer;