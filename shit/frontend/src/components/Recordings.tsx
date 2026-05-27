import React, { useState, useEffect } from 'react';
import {
    Container, Paper, Typography, Box, Accordion, AccordionSummary,
    AccordionDetails, List, ListItem, ListItemText, IconButton, Chip,
    CircularProgress, Alert, Dialog, DialogContent,
} from '@mui/material';
import {
    ExpandMore, Download, PlayArrow, Folder, VideoLibrary,
    DeleteForever,
} from '@mui/icons-material';
import { RZD_COLORS } from '../theme';
import { type CPPCamera } from '../types'
import { api, MediaCenterError } from '../services/api';

interface Recording {
    filename: string;
    size: number;
    created: string;
    modified: string;
}

const Recordings: React.FC = () => {
    const [recordings, setRecordings] = useState<Record<string, Recording[]>>({});
    const [cameras, setCameras] = useState<Map<string, CPPCamera>>(new Map());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [playingVideo, setPlayingVideo] = useState<string | null>(null);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        setLoading(true);
        try {
            // Грузим параллельно — записи и камеры независимы
            const [recordingsRes, camerasList] = await Promise.all([
                fetch('/api/recordings').then(r => {
                    if (!r.ok) throw new Error('Failed to load recordings');
                    return r.json();
                }),
                api.getCameras().catch((err) => {
                    // Если C++ Media Center недоступен — не валим всю страницу,
                    // просто покажем без display_name
                    console.warn('Could not load cameras list:', err);
                    return [] as CPPCamera[];
                }),
            ]);

            setRecordings(recordingsRes.recordings || {});

            // Мап id → camera для быстрого лукапа
            const camerasMap = new Map<string, CPPCamera>();
            for (const c of camerasList) {
                camerasMap.set(c.id, c);
            }
            setCameras(camerasMap);

            setError('');
        } catch (err) {
            const msg = err instanceof MediaCenterError
                ? err.message
                : err instanceof Error ? err.message : String(err);
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    const formatBytes = (bytes: number): string => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
    };

    const formatDate = (isoDate: string): string => {
        return new Date(isoDate).toLocaleString('ru-RU');
    };

    const handleDownload = (cameraName: string, filename: string) => {
        window.open(`/api/recordings/download/${cameraName}/${filename}`, '_blank');
    };

    const handlePlay = (cameraName: string, filename: string) => {
        setPlayingVideo(`/api/recordings/stream/${cameraName}/${filename}`);
    };

    const totalCameras = Object.keys(recordings).length;
    const totalFiles = Object.values(recordings).reduce((sum, files) => sum + files.length, 0);

    if (loading) {
        return (
            <Container maxWidth="lg">
                <Box display="flex" justifyContent="center" alignItems="center" minHeight="60vh">
                    <CircularProgress size={60} />
                </Box>
            </Container>
        );
    }

    return (
        <Container maxWidth="lg">
            <Paper sx={{ p: 3, mb: 3 }}>
                <Box display="flex" alignItems="center" gap={2}>
                    <VideoLibrary sx={{ fontSize: 40, color: RZD_COLORS.primary }} />
                    <Box>
                        <Typography variant="h5" fontWeight="bold">
                            Архив видеозаписей
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                            Камер: {totalCameras} | Файлов: {totalFiles}
                        </Typography>
                    </Box>
                </Box>
            </Paper>

            {error && (
                <Alert severity="error" sx={{ mb: 3 }}>
                    {error}
                </Alert>
            )}

            {totalCameras === 0 ? (
                <Paper sx={{ p: 8, textAlign: 'center' }}>
                    <Typography variant="h5" color="text.secondary" gutterBottom>
                        Нет записей
                    </Typography>
                    <Typography color="text.secondary">
                        Записи появятся после активации камер
                    </Typography>
                </Paper>
            ) : (
                Object.entries(recordings).map(([cameraId, files]) => {
                    const camera = cameras.get(cameraId);
                    const isDeleted = !camera;
                    const displayName = camera?.display_name || cameraId;

                    return (
                        <Accordion
                            key={cameraId}
                            defaultExpanded={files.length > 0}
                            sx={{
                                opacity: isDeleted ? 0.7 : 1,
                            }}
                        >
                            <AccordionSummary expandIcon={<ExpandMore />}>
                                <Box display="flex" alignItems="center" gap={2} width="100%">
                                    {isDeleted ? (
                                        <DeleteForever sx={{ color: 'grey.500' }} />
                                    ) : (
                                        <Folder sx={{ color: RZD_COLORS.primary }} />
                                    )}
                                    <Box>
                                        <Typography
                                            variant="h6"
                                            fontWeight="bold"
                                            sx={{ color: isDeleted ? 'grey.600' : 'inherit' }}
                                        >
                                            {displayName}
                                        </Typography>
                                        {!isDeleted && displayName !== cameraId && (
                                            <Typography variant="caption" color="text.secondary">
                                                {cameraId}
                                            </Typography>
                                        )}
                                    </Box>
                                    {isDeleted && (
                                        <Chip
                                            label="Камера удалена"
                                            size="small"
                                            sx={{
                                                ml: 1,
                                                bgcolor: 'grey.300',
                                                color: 'grey.700',
                                            }}
                                        />
                                    )}
                                    <Chip
                                        label={`${files.length} файлов`}
                                        size="small"
                                        sx={{ ml: 'auto', mr: 2 }}
                                    />
                                </Box>
                            </AccordionSummary>
                            <AccordionDetails>
                                {files.length === 0 ? (
                                    <Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
                                        Нет записей
                                    </Typography>
                                ) : (
                                    <List>
                                        {files.map((file, index) => (
                                            <ListItem
                                                key={index}
                                                sx={{
                                                    borderBottom: index < files.length - 1
                                                        ? `1px solid ${RZD_COLORS.grey[200]}`
                                                        : 'none',
                                                    py: 2,
                                                }}
                                                secondaryAction={
                                                    <Box display="flex" gap={1}>
                                                        <IconButton
                                                            edge="end"
                                                            onClick={() => handlePlay(cameraId, file.filename)}
                                                            sx={{ color: RZD_COLORS.primary }}
                                                        >
                                                            <PlayArrow />
                                                        </IconButton>
                                                        <IconButton
                                                            edge="end"
                                                            onClick={() => handleDownload(cameraId, file.filename)}
                                                            sx={{ color: RZD_COLORS.secondary }}
                                                        >
                                                            <Download />
                                                        </IconButton>
                                                    </Box>
                                                }
                                            >
                                                <ListItemText
                                                    primary={
                                                        <Typography variant="body1" fontWeight={600}>
                                                            {file.filename}
                                                        </Typography>
                                                    }
                                                    secondary={
                                                        <Typography variant="caption" color="text.secondary">
                                                            Дата: {formatDate(file.created)} | Размер:{formatBytes(file.size)}
                                                        </Typography>
                                                    }
                                                />
                                            </ListItem>
                                        ))}
                                    </List>
                                )}
                            </AccordionDetails>
                        </Accordion>
                    );
                })
            )}

            <Dialog
                open={!!playingVideo}
                onClose={() => setPlayingVideo(null)}
                maxWidth="lg"
                fullWidth
            >
                <DialogContent sx={{ p: 0, bgcolor: 'black' }}>
                    {playingVideo && (
                        <video
                            src={playingVideo}
                            controls
                            autoPlay
                            style={{ width: '100%', height: 'auto', display: 'block' }}
                        />
                    )}
                </DialogContent>
            </Dialog>
        </Container>
    );
};

export default Recordings;