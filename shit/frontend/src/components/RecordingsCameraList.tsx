import React from 'react';
import {
    Box, Typography, List, ListItem, ListItemButton, ListItemText,
    Checkbox, Chip,
} from '@mui/material';
import { Videocam, DeleteForever } from '@mui/icons-material';
import type { CPPCamera } from '../types';

interface RecordingsCameraListProps {
    /** id'ы камер, у которых есть папки с записями */
    cameras: string[];
    /** активные камеры с C++ Media Center, по id */
    knownCameras: Map<string, CPPCamera>;
    selectedCameras: string[];
    onToggle: (cameraId: string) => void;
}

const RESERVED_PREFIXES = ['__probe_'];

const RecordingsCameraList: React.FC<RecordingsCameraListProps> = ({
                                                                       cameras,
                                                                       knownCameras,
                                                                       selectedCameras,
                                                                       onToggle,
                                                                   }) => {
    const visibleCameras = cameras.filter(
        (id) => !RESERVED_PREFIXES.some((p) => id.startsWith(p))
    );

    return (
        <Box>
            <Typography variant="subtitle2" fontWeight="bold" mb={1}>
                Камеры
            </Typography>
            <List dense>
                {visibleCameras.map(cameraId => {
                    const camera = knownCameras.get(cameraId);
                    const isDeleted = !camera;
                    const displayName = camera?.display_name || cameraId;
                    const isSelected = selectedCameras.includes(cameraId);
                    const limitReached = !isSelected && selectedCameras.length >= 4;

                    return (
                        <ListItem key={cameraId} disablePadding>
                            <ListItemButton
                                onClick={() => onToggle(cameraId)}
                                disabled={limitReached || (isDeleted && !isSelected)}
                                sx={{ opacity: isDeleted ? 0.7 : 1 }}
                            >
                                <Checkbox edge="start" checked={isSelected} />
                                <ListItemText
                                    primary={
                                        <Box display="flex" alignItems="center" gap={1} flexWrap="wrap">
                                            {isDeleted ? (
                                                <DeleteForever fontSize="small" sx={{ color: 'grey.500' }} />
                                            ) : (
                                                <Videocam fontSize="small" />
                                            )}
                                            <Typography
                                                variant="body2"
                                                sx={{ color: isDeleted ? 'grey.600' : 'inherit' }}
                                            >
                                                {displayName}
                                            </Typography>
                                            {!isDeleted && displayName !== cameraId && (
                                                <Typography variant="caption" color="text.disabled">
                                                    {cameraId}
                                                </Typography>
                                            )}
                                            {isDeleted && (
                                                <Chip
                                                    label="удалена"
                                                    size="small"
                                                    sx={{
                                                        height: 16,
                                                        fontSize: '0.65rem',
                                                        bgcolor: 'grey.300',
                                                        color: 'grey.700',
                                                    }}
                                                />
                                            )}
                                        </Box>
                                    }
                                />
                            </ListItemButton>
                        </ListItem>
                    );
                })}
                {visibleCameras.length === 0 && (
                    <Typography variant="caption" color="text.secondary" sx={{ px: 2 }}>
                        Нет камер с записями
                    </Typography>
                )}
            </List>
        </Box>
    );
};

export default RecordingsCameraList;