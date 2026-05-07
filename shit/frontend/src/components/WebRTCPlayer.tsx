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
            sx={{
                position: 'relative',
                bgcolor: 'black',
                overflow: 'hidden',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
            }}
        >
            <Box
                sx={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bgcolor: 'rgba(0,0,0,0.7)',
                    color: 'white',
                    px: 2,
                    py: 1,
                    zIndex: 10,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                }}
            >
                <Typography variant="body2" fontWeight="bold">
                    {cameraId}
                </Typography>
                {status === 'connected' && (
                    <IconButton size="small" onClick={handleFullscreen} sx={{ color: 'white' }}>
                        <Fullscreen />
                    </IconButton>
                )}
            </Box>

            <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    display: status === 'connected' ? 'block' : 'none'
                }}
            />

            {status === 'connecting' && (
                <Box
                    display="flex"
                    flexDirection="column"
                    alignItems="center"
                    justifyContent="center"
                    sx={{ flexGrow: 1, color: 'white' }}
                >
                    <CircularProgress size={40} sx={{ mb: 2 }} />
                    <Typography>Подключение...</Typography>
                </Box>
            )}

            {status === 'error' && (
                <Box
                    display="flex"
                    flexDirection="column"
                    alignItems="center"
                    justifyContent="center"
                    sx={{ flexGrow: 1, color: 'white' }}
                >
                    <ErrorIcon sx={{ fontSize: 48, mb: 2, color: 'error.main' }} />
                    <Typography>{errorMsg}</Typography>
                </Box>
            )}
        </Paper>
    );
};

export default WebRTCPlayer;