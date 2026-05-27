import React, { useRef, useEffect } from 'react';
import { Box, LinearProgress, Typography } from '@mui/material';
import { currentTimeBus } from '../utils/currentTimeBus';
import { throttle } from '../utils/throttle';

interface RecordingsPlayerProps {
    camera: string;
    displayName?: string;
    file: { filename: string; created: string };
    onEnded?: () => void;
}

const RecordingsPlayer: React.FC<RecordingsPlayerProps> = ({
                                                               camera,
                                                               displayName,
                                                               file,
                                                               onEnded,
                                                           }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState(false);
    const [overlayVisible, setOverlayVisible] = React.useState(true);

    // Скрываем оверлей по той же логике, что браузер прячет controls:
    // если мышь не двигалась пару секунд — гасим.
    const hideTimerRef = useRef<number | null>(null);
    const scheduleHide = () => {
        if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = window.setTimeout(() => {
            setOverlayVisible(false);
        }, 2500);
    };

    const handleMouseActivity = () => {
        setOverlayVisible(true);
        scheduleHide();
    };

    useEffect(() => {
        scheduleHide();
        return () => {
            if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
        };
    }, []);

    // throttled-публикация в шину. Создаётся один раз на жизнь компонента.
    const publishCurrentTime = useRef(
        throttle((minutes: number) => currentTimeBus.set(minutes), 500)
    ).current;

    useEffect(() => {
        if (videoRef.current) {
            setLoading(true);
            setError(false);
            videoRef.current.load();
        }
    }, [camera, file.filename]);

    // Сбрасываем currentTime при размонтировании, чтобы timeline убрал playhead
    useEffect(() => {
        return () => {
            currentTimeBus.set(undefined);
        };
    }, []);

    const handleCanPlay = () => setLoading(false);
    const handleError = () => {
        setLoading(false);
        setError(true);
    };

    const handleTimeUpdate = () => {
        if (!videoRef.current) return;
        const fileStart = new Date(file.created);
        const fileStartMinutes =
            fileStart.getHours() * 60 +
            fileStart.getMinutes() +
            fileStart.getSeconds() / 60;
        const offsetMinutes = videoRef.current.currentTime / 60;
        publishCurrentTime(fileStartMinutes + offsetMinutes);
    };

    const effectiveDisplayName = displayName || camera;
    const showCameraId = displayName && displayName !== camera;

    return (
        <Box
            ref={containerRef}
            onMouseMove={handleMouseActivity}
            onMouseEnter={handleMouseActivity}
            onMouseLeave={() => setOverlayVisible(false)}
            sx={{ width: '100%', height: '100%', bgcolor: 'black', position: 'relative' }}
        >
            {loading && (
                <Box sx={{
                    position: 'absolute', top: '50%', left: '50%',
                    transform: 'translate(-50%, -50%)', zIndex: 10, textAlign: 'center',
                }}>
                    <LinearProgress sx={{ width: 200, mb: 2 }} />
                    <Typography color="white">Загрузка видео...</Typography>
                </Box>
            )}

            {error && (
                <Box sx={{
                    position: 'absolute', top: '50%', left: '50%',
                    transform: 'translate(-50%, -50%)', zIndex: 10, textAlign: 'center',
                }}>
                    <Typography color="error" variant="h6">Ошибка загрузки видео</Typography>
                    <Typography color="grey.500" variant="body2">{file.filename}</Typography>
                </Box>
            )}

            <video
                ref={videoRef}
                controls
                autoPlay
                style={{
                    width: '100%', height: '100%', objectFit: 'contain',
                    display: loading ? 'none' : 'block',
                }}
                src={`/api/recordings/stream/${camera}/${file.filename}`}
                onCanPlay={handleCanPlay}
                onError={handleError}
                onEnded={onEnded}
                onTimeUpdate={handleTimeUpdate}
            />

            <Box sx={{
                position: 'absolute', bottom: 60, left: 10,
                bgcolor: 'rgba(0,0,0,0.8)', color: 'white',
                px: 1.5, py: 0.5, borderRadius: 1,
                fontSize: '0.75rem',                          // ← уменьшен с 0.9rem
                opacity: overlayVisible ? 1 : 0,              // ← синхронно с активностью
                transition: 'opacity 0.3s ease',              // ← плавно
                pointerEvents: 'none',                        // ← не мешает клику по видео
            }}>
                <Box sx={{ fontWeight: 'bold' }}>
                    {effectiveDisplayName} • {new Date(file.created).toLocaleTimeString('ru-RU')}
                </Box>
                {showCameraId && (
                    <Box sx={{ fontSize: '0.65rem', color: 'grey.400', fontWeight: 'normal' }}>
                        {camera}
                    </Box>
                )}
            </Box>
        </Box>
    );
};

export default RecordingsPlayer;