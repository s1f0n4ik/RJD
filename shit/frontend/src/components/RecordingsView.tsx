import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
    Container, Paper, Box, Grid, Typography, CircularProgress, Alert,
    FormControl, InputLabel, Select, MenuItem, Chip, Button, Dialog,
    DialogTitle, DialogContent, LinearProgress,
} from '@mui/material';
import {
    VideoLibrary, FiberManualRecord, CloudDownload, ContentCut, Cancel,
    DeleteForever,
} from '@mui/icons-material';
import { RZD_COLORS } from '../theme';
import RecordingsCalendar from './RecordingsCalendar';
import RecordingsPlayer from './RecordingsPlayer';
import RecordingsTimeline from './RecordingsTimeline';
import { isProbeCamera } from '../utils/probeFilter';
import type { CPPCamera } from '../types';
import { api, MediaCenterError} from '../services/api';

interface Recording {
    filename: string;
    size: number;
    created: string;
    modified: string;
}

const RecordingsView: React.FC = () => {
    const [recordings, setRecordings] = useState<Record<string, Recording[]>>({});
    const [cameras, setCameras] = useState<Map<string, CPPCamera>>(new Map());
    const [selectedCamera, setSelectedCamera] = useState<string>('');
    const [selectedDate, setSelectedDate] = useState<Date>(new Date());
    const [currentFile, setCurrentFile] = useState<Recording | null>(null);
    const [currentFileIndex, setCurrentFileIndex] = useState<number>(-1);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedRange, setSelectedRange] = useState<{ start: number; end: number } | null>(null);
    const [merging, setMerging] = useState(false);
    const [_, setMergeProgress] = useState(0);

    useEffect(() => {
        loadData();
    }, []);

    useEffect(() => {
        if (!selectedCamera && Object.keys(recordings).length > 0) {
            const firstCamera = Object.keys(recordings)[0];
            setSelectedCamera(firstCamera);
            autoPlayLatestVideo(firstCamera);
        }
    }, [recordings]);

    useEffect(() => {
        if (selectedCamera && selectedDate) {
            const files = getFilesForSelectedDate();
            if (files.length > 1) {
                playFile(files[files.length - 2], files.length - 2);
            } else if (files.length === 1) {
                playFile(files[0], 0);
            }
        }
    }, [selectedCamera, selectedDate]);

    const loadData = async () => {
        setLoading(true);
        try {
            const [recordingsRes, camerasList] = await Promise.all([
                fetch('/api/recordings').then(r => {
                    if (!r.ok) throw new Error('Failed to load recordings');
                    return r.json();
                }),
                api.getCameras().catch((err) => {
                    console.warn('[RecordingsView] could not load cameras list:', err);
                    return [] as CPPCamera[];
                }),
            ]);

            // Архив: убираем probe-камеры
            const raw: Record<string, Recording[]> = recordingsRes.recordings || {};
            const filtered: Record<string, Recording[]> = {};
            for (const [name, files] of Object.entries(raw)) {
                if (!isProbeCamera(name)) {
                    filtered[name] = files;
                }
            }
            setRecordings(filtered);

            // Мап id → camera для O(1) лукапа имени
            const camerasMap = new Map<string, CPPCamera>();
            for (const c of camerasList) {
                camerasMap.set(c.id, c);
            }
            setCameras(camerasMap);

            // Диагностика — пока разбираемся
            console.log('[RecordingsView] camera IDs from C++:', Array.from(camerasMap.keys()));
            console.log('[RecordingsView] folder IDs from disk:', Object.keys(filtered));

            setError('');
        } catch (err) {
            const msg =
                err instanceof MediaCenterError ? err.message :
                    err instanceof Error ? err.message : String(err);
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    // Унифицированный лукап
    const getCameraDisplay = (cameraId: string) => {
        const camera = cameras.get(cameraId);
        return {
            displayName: camera?.display_name || cameraId,
            isDeleted: !camera,
        };
    };

    const autoPlayLatestVideo = (camera: string) => {
        const files = recordings[camera];
        if (files && files.length > 1) {
            const secondLast = files[files.length - 2];
            setCurrentFile(secondLast);
            setCurrentFileIndex(files.length - 2);
        } else if (files && files.length === 1) {
            setCurrentFile(files[0]);
            setCurrentFileIndex(0);
        }
    };

    const handleCameraChange = (cameraName: string) => {
        setSelectedCamera(cameraName);
        setCurrentFile(null);
        setSelectedRange(null);
        setSelectionMode(false);
    };

    const handleDateChange = useCallback((date: Date) => {
        setSelectedDate(date);
        setCurrentFile(null);
        setSelectedRange(null);
        setSelectionMode(false);
    }, []);

    const handleRangeSelected = useCallback((range: { start: number; end: number }) => {
        setSelectedRange(range);
    }, []);

    const playFile = (file: Recording, index: number) => {
        setCurrentFile(file);
        setCurrentFileIndex(index);
    };

    const handleVideoEnded = () => {
        const files = getFilesForSelectedDate();
        const nextIndex = currentFileIndex + 1;
        if (nextIndex < files.length) {
            playFile(files[nextIndex], nextIndex);
        }
    };

    const handleTimelineSeek = (file: Recording) => {
        const files = getFilesForSelectedDate();
        const index = files.findIndex(f => f.filename === file.filename);
        if (index !== -1) playFile(file, index);
    };


    const formatMinutes = (minutes: number): string => {
        const h = Math.floor(minutes / 60);
        const m = Math.floor(minutes % 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    const handleMergeVideos = async () => {
        if (!selectedRange || !selectedCamera) return;
        setMerging(true);
        setMergeProgress(0);

        try {
            const dateStr = selectedDate.toISOString().split('T')[0];
            const response = await fetch('/api/recordings/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    camera: selectedCamera,
                    date: dateStr,
                    start_minutes: selectedRange.start,
                    end_minutes: selectedRange.end,
                }),
            });
            if (!response.ok) {
                const e = await response.json();
                throw new Error(e.detail || 'Merge failed');
            }
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${selectedCamera}_${dateStr}_${formatMinutes(selectedRange.start).replace(':', '')}-${formatMinutes(selectedRange.end).replace(':', '')}.mp4`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            setMergeProgress(100);
            setTimeout(() => {
                setMerging(false);
                setSelectionMode(false);
                setSelectedRange(null);
            }, 1500);
        } catch (err: any) {
            alert(`Ошибка склейки: ${err.message}`);
            setMerging(false);
        }
    };

    const getFilesForSelectedDate = (): Recording[] => {
        if (!selectedCamera || !recordings[selectedCamera]) return [];
        const dateStr = selectedDate.toISOString().split('T')[0];
        return recordings[selectedCamera]
            .filter(f => f.created.startsWith(dateStr))
            .sort((a, b) => a.created.localeCompare(b.created));
    };

    const filesForDate = getFilesForSelectedDate();
    const cameraList = Object.keys(recordings);
    const currentCameraDisplay = selectedCamera
        ? getCameraDisplay(selectedCamera)
        : { displayName: 'Не выбрана', isDeleted: false };
    const currentFileIndexInDate = currentFile
        ? filesForDate.findIndex(f => f.filename === currentFile.filename)
        : -1;
    const isCurrentFileInSelectedDate = currentFileIndexInDate !== -1;

    const recordingCounts = useMemo(() => {
        const counts = new Map<string, number>();
        if (!selectedCamera || !recordings[selectedCamera]) return counts;
        for (const file of recordings[selectedCamera]) {
            const dateKey = file.created.split('T')[0];
            counts.set(dateKey, (counts.get(dateKey) ?? 0) + 1);
        }
        return counts;
    }, [selectedCamera, recordings]);

    const datesWithRecordings = useMemo(
        () => Array.from(recordingCounts.keys()).map(s => new Date(s + 'T00:00:00')),
        [recordingCounts]
    );

    if (loading) {
        return (
            <Container maxWidth="xl">
                <Box display="flex" justifyContent="center" alignItems="center" minHeight="60vh">
                    <CircularProgress size={60} />
                </Box>
            </Container>
        );
    }

    return (
        <Container maxWidth="xl">
            <Paper sx={{ p: 2, mb: 2 }}>
                <Box display="flex" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={2}>
                    <Box display="flex" alignItems="center" gap={2}>
                        <VideoLibrary sx={{ fontSize: 40, color: RZD_COLORS.primary }} />
                        <Box>
                            <Typography variant="h5" fontWeight="bold">
                                Архив записей
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                                {selectionMode
                                    ? 'Режим выбора диапазона • Кликните начало и конец'
                                    : 'Непрерывное воспроизведение • Кликайте на Timeline для перехода'}
                            </Typography>
                        </Box>
                    </Box>

                    <FormControl sx={{ minWidth: 320 }}>
                        <InputLabel>Выберите камеру</InputLabel>
                        <Select
                            value={selectedCamera}
                            onChange={(e) => handleCameraChange(e.target.value)}
                            label="Выберите камеру"
                            renderValue={(value) => {
                                const { displayName, isDeleted } = getCameraDisplay(value);
                                return (
                                    <Box display="flex" alignItems="center" gap={1}>
                                        {isDeleted ? (
                                            <DeleteForever sx={{ fontSize: 16, color: 'grey.500' }} />
                                        ) : (
                                            <FiberManualRecord sx={{ fontSize: 12, color: 'success.main' }} />
                                        )}
                                        <Typography sx={{ color: isDeleted ? 'grey.600' : 'inherit' }}>
                                            {displayName}
                                        </Typography>
                                        {isDeleted && (
                                            <Chip label="удалена" size="small" sx={{ ml: 0.5, height: 18 }} />
                                        )}
                                    </Box>
                                );
                            }}
                        >
                            {cameraList.map(cameraId => {
                                const { displayName, isDeleted } = getCameraDisplay(cameraId);
                                return (
                                    <MenuItem
                                        key={cameraId}
                                        value={cameraId}
                                        sx={{ opacity: isDeleted ? 0.7 : 1 }}
                                    >
                                        <Box display="flex" alignItems="center" gap={1} width="100%">
                                            {isDeleted ? (
                                                <DeleteForever sx={{ fontSize: 16, color: 'grey.500' }} />
                                            ) : (
                                                <FiberManualRecord sx={{ fontSize: 12, color: 'success.main' }} />
                                            )}
                                            <Box flexGrow={1}>
                                                <Typography variant="body2" sx={{ color: isDeleted ? 'grey.600' : 'inherit' }}>
                                                    {displayName}
                                                </Typography>
                                                {displayName !== cameraId && (
                                                    <Typography variant="caption" color="text.disabled">
                                                        {cameraId}
                                                    </Typography>
                                                )}
                                            </Box>
                                            {isDeleted && (
                                                <Chip
                                                    label="удалена"
                                                    size="small"
                                                    sx={{
                                                        height: 18,
                                                        fontSize: '0.65rem',
                                                        bgcolor: 'grey.300',
                                                        color: 'grey.700',
                                                    }}
                                                />
                                            )}
                                        </Box>
                                    </MenuItem>
                                );
                            })}
                        </Select>
                    </FormControl>
                </Box>
            </Paper>

            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

            {cameraList.length === 0 ? (
                <Paper sx={{ p: 8, textAlign: 'center' }}>
                    <Typography variant="h5" color="text.secondary" gutterBottom>
                        Нет записей
                    </Typography>
                    <Typography color="text.secondary">
                        Записи появятся после активации камер
                    </Typography>
                </Paper>
            ) : (
                <Grid container spacing={2}>
                    <Grid item xs={12} lg={9}>
                        <Paper sx={{ mb: 2, height: '65vh', bgcolor: 'black', overflow: 'hidden' }}>
                            {currentFile && selectedCamera && !selectionMode ? (
                                <RecordingsPlayer
                                    camera={selectedCamera}
                                    displayName={currentCameraDisplay.displayName}
                                    file={currentFile}
                                    onEnded={handleVideoEnded}
                                />
                            ) : (
                                <Box display="flex" alignItems="center" justifyContent="center" height="100%" textAlign="center" p={4}>
                                    <Box>
                                        {selectionMode ? (
                                            <>
                                                <Typography variant="h4" color="success.main" gutterBottom>
                                                    Режим выбора диапазона
                                                </Typography>
                                                <Typography variant="h6" color="grey.600" gutterBottom>
                                                    Кликните на Timeline: сначала начало, затем конец
                                                </Typography>
                                                {selectedRange && (
                                                    <Chip
                                                        label={`Выбрано: ${formatMinutes(selectedRange.start)} - ${formatMinutes(selectedRange.end)}`}
                                                        color="success"
                                                        sx={{ mt: 2, fontSize: '1.1rem' }}
                                                    />
                                                )}
                                            </>
                                        ) : (
                                            <>
                                                <Typography variant="h4" color="grey.600" gutterBottom>
                                                    Добро пожаловать в Архив
                                                </Typography>
                                                <Typography variant="h6" color="grey.700" gutterBottom>
                                                    Выберите камеру вверху, затем кликните на Timeline
                                                </Typography>
                                            </>
                                        )}
                                    </Box>
                                </Box>
                            )}
                        </Paper>

                        <Paper sx={{ p: 2 }}>
                            <RecordingsTimeline
                                camera={selectedCamera}
                                date={selectedDate}
                                files={filesForDate}
                                currentFileName={currentFile?.filename}
                                onSeek={handleTimelineSeek}
                                selectionMode={selectionMode}
                                selectedRange={selectedRange}
                                onRangeSelected={handleRangeSelected}
                            />
                        </Paper>
                    </Grid>

                    <Grid item xs={12} lg={3}>
                        <Paper sx={{ p: 2, mb: 2 }}>
                            <Typography variant="subtitle1" fontWeight="bold">
                                Выберите дату
                            </Typography>
                            <RecordingsCalendar
                                selectedDate={selectedDate}
                                onDateChange={handleDateChange}
                                highlightDates={datesWithRecordings}
                                recordingCounts={recordingCounts}
                            />
                            <Alert severity="info" sx={{ mt: 2 }} icon={false}>
                                <strong>Синие дни</strong> = есть записи
                            </Alert>
                        </Paper>

                        <Paper sx={{ p: 2, mb: 2 }}>
                            <Typography variant="subtitle2" fontWeight="bold" mb={1}>
                                Статистика
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                Камера:{' '}
                                <strong style={{ color: currentCameraDisplay.isDeleted ? '#888' : undefined }}>
                                    {currentCameraDisplay.displayName}
                                </strong>
                                {currentCameraDisplay.isDeleted && selectedCamera && (
                                    <Chip
                                        label="удалена"
                                        size="small"
                                        sx={{ ml: 1, height: 16, fontSize: '0.65rem' }}
                                    />
                                )}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                Дата: <strong>{selectedDate.toLocaleDateString('ru-RU')}</strong>
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                {filesForDate.length > 0
                                    ? 'Записи за этот день есть'
                                    : 'Записей за этот день нет'}
                            </Typography>

                            {/* Показываем только если: есть файлы за дату, есть текущий файл,
                                и он реально из этой даты, и не в режиме выбора диапазона */}
                            {filesForDate.length > 0 &&
                                isCurrentFileInSelectedDate &&
                                !selectionMode && (
                                    <Typography variant="body2" color="primary" sx={{ mt: 1 }}>
                                        Воспроизводится: {currentFileIndexInDate + 1}/{filesForDate.length}
                                    </Typography>
                                )}
                            {selectedRange && (
                                <Alert severity="success" sx={{ mt: 1 }} icon={false}>
                                    <Typography variant="caption" fontWeight="bold">
                                        Диапазон: {formatMinutes(selectedRange.start)} - {formatMinutes(selectedRange.end)}
                                    </Typography>
                                    <Typography variant="caption" display="block">
                                        ~{Math.round(selectedRange.end - selectedRange.start)} минут
                                    </Typography>
                                </Alert>
                            )}
                        </Paper>

                        {filesForDate.length > 0 && (
                            <Paper sx={{ p: 2 }}>
                                {!selectionMode ? (
                                    <>
                                        <Button
                                            fullWidth variant="outlined" startIcon={<CloudDownload />}
                                            onClick={() => alert('TODO: Скачать все видео за день')}
                                            sx={{ mb: 1 }}
                                        >
                                            Скачать все за день
                                        </Button>
                                        <Button
                                            fullWidth variant="contained" startIcon={<ContentCut />}
                                            onClick={() => setSelectionMode(true)}
                                        >
                                            Склеить диапазон
                                        </Button>
                                    </>
                                ) : (
                                    <>
                                        <Button
                                            fullWidth variant="contained" color="success" startIcon={<ContentCut />}
                                            disabled={!selectedRange || merging} onClick={handleMergeVideos}
                                            sx={{ mb: 1 }}
                                        >
                                            {merging ? 'Склеиваем...' : 'Склеить и скачать'}
                                        </Button>
                                        <Button
                                            fullWidth variant="outlined" color="error" startIcon={<Cancel />}
                                            onClick={() => { setSelectionMode(false); setSelectedRange(null); }}
                                        >
                                            Отменить
                                        </Button>
                                    </>
                                )}
                            </Paper>
                        )}
                    </Grid>
                </Grid>
            )}

            <Dialog open={merging} maxWidth="sm" fullWidth>
                <DialogTitle>⚙️ Склеивание видео</DialogTitle>
                <DialogContent>
                    <Typography gutterBottom>
                        Обрабатываем видео с {selectedRange && formatMinutes(selectedRange.start)} до {selectedRange && formatMinutes(selectedRange.end)}...
                    </Typography>
                    <LinearProgress variant="indeterminate" sx={{ mt: 2 }} />
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                        Это может занять несколько минут в зависимости от длительности
                    </Typography>
                </DialogContent>
            </Dialog>
        </Container>
    );
};

export default RecordingsView;