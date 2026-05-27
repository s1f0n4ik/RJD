import React from 'react';
import {
    Box,
    Typography,
    List,
    ListItem,
    ListItemButton,
    ListItemText,
    IconButton,
    Chip,
} from '@mui/material';
import { Download, PlayArrow, DeleteForever } from '@mui/icons-material';
import type { CPPCamera } from '../types';

interface Recording {
    filename: string;
    size: number;
    created: string;
    modified: string;
}

interface RecordingsFileListProps {
    recordings: Record<string, Recording[]>;
    cameras: Map<string, CPPCamera>;
    selectedCameras: string[];
    selectedDate: Date;
    onFileSelect: (camera: string, file: Recording) => void;
}

const RecordingsFileList: React.FC<RecordingsFileListProps> = ({
                                                                   recordings,
                                                                   cameras,
                                                                   selectedCameras,
                                                                   selectedDate,
                                                                   onFileSelect,
                                                               }) => {
    const formatTime = (isoDate: string) =>
        new Date(isoDate).toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
        });

    const formatBytes = (bytes: number) =>
        (bytes / 1024 / 1024).toFixed(2) + ' MB';

    const getFilesForSelectedDate = () => {
        const dateStr = selectedDate.toISOString().split('T')[0];
        const result: { cameraId: string; files: Recording[] }[] = [];

        selectedCameras.forEach(cameraId => {
            const files =
                recordings[cameraId]?.filter(f => f.created.startsWith(dateStr)) || [];
            if (files.length > 0) {
                result.push({ cameraId, files });
            }
        });

        return result;
    };

    const filesData = getFilesForSelectedDate();

    return (
        <Box>
            <Typography variant="subtitle2" fontWeight="bold" mb={1}>
                📂 Files
            </Typography>
            {filesData.length === 0 ? (
                <Typography variant="caption" color="text.secondary">
                    No recordings for selected date
                </Typography>
            ) : (
                filesData.map(({ cameraId, files }) => {
                    const camera = cameras.get(cameraId);
                    const isDeleted = !camera;
                    const displayName = camera?.display_name || cameraId;

                    return (
                        <Box key={cameraId} mb={2} sx={{ opacity: isDeleted ? 0.7 : 1 }}>
                            <Box display="flex" alignItems="center" gap={0.5} mb={0.5}>
                                {isDeleted && (
                                    <DeleteForever
                                        sx={{ color: 'grey.500', fontSize: 16 }}
                                    />
                                )}
                                <Typography
                                    variant="caption"
                                    fontWeight="bold"
                                    sx={{ color: isDeleted ? 'grey.600' : 'text.secondary' }}
                                >
                                    {displayName}
                                </Typography>
                                {!isDeleted && displayName !== cameraId && (
                                    <Typography variant="caption" color="text.disabled" sx={{ ml: 0.5 }}>
                                        ({cameraId})
                                    </Typography>
                                )}
                                {isDeleted && (
                                    <Chip
                                        label="удалена"
                                        size="small"
                                        sx={{
                                            ml: 0.5,
                                            height: 16,
                                            fontSize: '0.65rem',
                                            bgcolor: 'grey.300',
                                            color: 'grey.700',
                                        }}
                                    />
                                )}
                            </Box>
                            <List dense>
                                {files.map(file => (
                                    <ListItem
                                        key={file.filename}
                                        secondaryAction={
                                            <IconButton
                                                size="small"
                                                onClick={() =>
                                                    window.open(
                                                        `/api/recordings/download/${cameraId}/${file.filename}`
                                                    )
                                                }
                                            >
                                                <Download fontSize="small" />
                                            </IconButton>
                                        }
                                    >
                                        <ListItemButton onClick={() => onFileSelect(cameraId, file)}>
                                            <PlayArrow fontSize="small" sx={{ mr: 1 }} />
                                            <ListItemText
                                                primary={formatTime(file.created)}
                                                secondary={formatBytes(file.size)}
                                                primaryTypographyProps={{ variant: 'caption' }}
                                                secondaryTypographyProps={{ variant: 'caption' }}
                                            />
                                        </ListItemButton>
                                    </ListItem>
                                ))}
                            </List>
                        </Box>
                    );
                })
            )}
        </Box>
    );
};

export default RecordingsFileList;