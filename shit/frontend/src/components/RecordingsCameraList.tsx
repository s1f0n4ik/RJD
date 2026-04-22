import React from 'react';
import {
  Box, Typography, List, ListItem, ListItemButton, ListItemText, Checkbox,
} from '@mui/material';
import { Videocam } from '@mui/icons-material';

interface RecordingsCameraListProps {
  cameras: string[];
  selectedCameras: string[];
  onToggle: (camera: string) => void;
}

const RESERVED_PREFIXES = ['__probe_'];

const RecordingsCameraList: React.FC<RecordingsCameraListProps> = ({
  cameras,
  selectedCameras,
  onToggle,
}) => {
  // 🔑 Фильтруем технические probe-камеры из списка архива
  const visibleCameras = cameras.filter(
    (name) => !RESERVED_PREFIXES.some((p) => name.startsWith(p))
  );

  return (
    <Box>
      <Typography variant="subtitle2" fontWeight="bold" mb={1}>
        📹 Камеры
      </Typography>
      <List dense>
        {visibleCameras.map(camera => (
          <ListItem key={camera} disablePadding>
            <ListItemButton onClick={() => onToggle(camera)}>
              <Checkbox
                edge="start"
                checked={selectedCameras.includes(camera)}
                disabled={!selectedCameras.includes(camera) && selectedCameras.length >= 4}
              />
              <ListItemText
                primary={
                  <Box display="flex" alignItems="center" gap={1}>
                    <Videocam fontSize="small" />
                    <Typography variant="body2">{camera}</Typography>
                  </Box>
                }
              />
            </ListItemButton>
          </ListItem>
        ))}
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