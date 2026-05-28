import React from 'react';
import {
    Box, Paper, Typography, LinearProgress, Button, IconButton, Stack, Chip,
} from '@mui/material';
import { Close, ExpandLess, ExpandMore, Cancel as CancelIcon } from '@mui/icons-material';

export interface MergeJobInfo {
    id: string;
    status: string;
    progress: number;
    message: string;
    files_total: number;
    files_processed: number;
    bytes_total: number;
    duration_seconds: number;
    result_filename?: string;
    result_media_type?: string;
}

interface MergeJobPanelProps {
    job: MergeJobInfo;
    minimized: boolean;
    onMinimize: () => void;
    onMaximize: () => void;
    onCancel: () => void;
    onSaveAs: () => Promise<void>;  // вызов диалога «куда сохранить»
    downloading: boolean;
    downloadProgress: number;        // 0..1
}

const formatBytes = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
    return `${(b / 1024 ** 3).toFixed(2)} GB`;
};

const formatDuration = (s: number) => {
    if (s < 60) return `${Math.round(s)} сек`;
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return `${m} мин ${sec} сек`;
};

const STATUS_LABELS: Record<string, string> = {
    pending: 'Ожидание',
    parsing: 'Подбор файлов',
    merging: 'Склейка',
    archiving: 'Архивация',
    ready: 'Готово',
    failed: 'Ошибка',
    cancelled: 'Отменено',
    downloaded: 'Скачано',
};

const MergeJobPanel: React.FC<MergeJobPanelProps> = ({
                                                         job, minimized, onMinimize, onMaximize, onCancel, onSaveAs,
                                                         downloading, downloadProgress,
                                                     }) => {
    const isReady = job.status === 'ready';
    const isTerminal = ['failed', 'cancelled'].includes(job.status);
    const inProgress = !isReady && !isTerminal;

    const overallProgress = downloading
        ? downloadProgress
        : job.progress;

    const operationLabel = downloading
        ? 'Загрузка'
        : job.result_media_type === 'application/zip'
            ? 'Архивация'
            : job.result_media_type === 'video/mp4'
                ? 'Склейка'
                : 'Обработка';

    // === Свёрнутый вид: маленькая плашка в углу ===
    if (minimized) {
        return (
            <Paper
                elevation={6}
                sx={{
                    position: 'fixed',
                    bottom: 16, right: 16,
                    minWidth: 280,
                    p: 1.5,
                    zIndex: 1300,
                    cursor: 'pointer',
                }}
                onClick={onMaximize}
            >
                <Box display="flex" alignItems="center" gap={1} mb={0.5}>
                    <Typography variant="subtitle1" fontWeight="bold" sx={{ flexGrow: 1 }}>
                        {operationLabel}
                    </Typography>
                    <Typography variant="caption" fontWeight="bold" sx={{ flexGrow: 1 }}>
                        {downloading ? 'Скачивание...' : STATUS_LABELS[job.status]}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                        {Math.round(overallProgress * 100)}%
                    </Typography>
                    <IconButton size="small" onClick={(e) => { e.stopPropagation(); onMaximize(); }}>
                        <ExpandLess fontSize="small" />
                    </IconButton>
                </Box>
                <LinearProgress
                    variant="determinate"
                    value={overallProgress * 100}
                    color={isTerminal ? 'error' : 'primary'}
                />
            </Paper>
        );
    }

    // === Развёрнутый вид ===
    return (
        <Paper
            elevation={8}
            sx={{
                position: 'fixed',
                bottom: 16, right: 16,
                width: 420,
                zIndex: 1300,
                overflow: 'hidden',
            }}
        >
            {/* Header */}
            <Box
                sx={{
                    px: 2, py: 1.5,
                    bgcolor: 'primary.main', color: 'white',
                    display: 'flex', alignItems: 'center', gap: 1,
                }}
            >
                {(() => {
                    let title = 'Склейка видео';
                    if (downloading) title = 'Загрузка';
                    else if (job.result_media_type === 'application/zip') title = 'Архивация';
                    return (
                        <Typography variant="subtitle1" fontWeight="bold" sx={{ flexGrow: 1 }}>
                            {title}
                        </Typography>
                    );
                })()}
                <IconButton size="small" onClick={onMinimize} sx={{ color: 'white' }}>
                    <ExpandMore fontSize="small" />
                </IconButton>
                {isTerminal && (
                    <IconButton size="small" onClick={onCancel} sx={{ color: 'white' }}>
                        <Close fontSize="small" />
                    </IconButton>
                )}
            </Box>

            {/* Body */}
            <Box sx={{ p: 2 }}>
                <Typography variant="body2" sx={{ mb: 1 }}>
                    {downloading
                        ? `Скачивание... ${Math.round(downloadProgress * 100)}%`
                        : job.message || STATUS_LABELS[job.status]}
                </Typography>

                <LinearProgress
                    variant="determinate"
                    value={overallProgress * 100}
                    color={isTerminal ? 'error' : 'primary'}
                    sx={{ mb: 2, height: 8, borderRadius: 1 }}
                />

                {/* Метрики */}
                <Stack spacing={0.5} sx={{ mb: 2 }}>
                    {job.files_total > 0 && (
                        <Box display="flex" justifyContent="space-between">
                            <Typography variant="caption" color="text.secondary">Файлов</Typography>
                            <Typography variant="caption" fontWeight={600}>
                                {job.files_processed} / {job.files_total}
                            </Typography>
                        </Box>
                    )}
                    {job.duration_seconds > 0 && (
                        <Box display="flex" justifyContent="space-between">
                            <Typography variant="caption" color="text.secondary">Длительность</Typography>
                            <Typography variant="caption" fontWeight={600}>
                                {formatDuration(job.duration_seconds)}
                            </Typography>
                        </Box>
                    )}
                    {job.bytes_total > 0 && (
                        <Box display="flex" justifyContent="space-between">
                            <Typography variant="caption" color="text.secondary">
                                {isReady ? 'Размер архива' : 'Текущий размер'}
                            </Typography>
                            <Typography variant="caption" fontWeight={600}>
                                {formatBytes(job.bytes_total)}
                            </Typography>
                        </Box>
                    )}
                    <Box display="flex" justifyContent="space-between">
                        <Typography variant="caption" color="text.secondary">Статус</Typography>
                        <Chip
                            label={STATUS_LABELS[job.status]}
                            size="small"
                            sx={{ height: 18, fontSize: '0.7rem' }}
                            color={isReady ? 'success' : isTerminal ? 'error' : 'default'}
                        />
                    </Box>
                </Stack>

                {/* Actions */}
                <Stack direction="row" spacing={1}>
                    {isReady && !downloading && (
                        <>
                            <Button
                                variant="contained" color="success" fullWidth
                                onClick={onSaveAs}
                            >
                                Загрузить
                            </Button>
                            <Button
                                variant="outlined" color="error" fullWidth
                                onClick={onCancel}
                            >
                                Отменить
                            </Button>
                        </>
                    )}
                    {inProgress && (
                        <>
                            <Button variant="outlined" onClick={onMinimize} fullWidth>
                                В фон
                            </Button>
                            <Button
                                variant="outlined" color="error" startIcon={<CancelIcon />}
                                onClick={onCancel} fullWidth
                            >
                                Отменить
                            </Button>
                        </>
                    )}
                    {isTerminal && (
                        <Button variant="outlined" onClick={onCancel} fullWidth>
                            Закрыть
                        </Button>
                    )}
                </Stack>
            </Box>
        </Paper>
    );
};

export default MergeJobPanel;