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

const RecordingsCameraList: React.FC<RecordingsCameraListProps> = ({
  cameras,
  selectedCameras,
  onToggle,
}) => {
  return (
    <Box>
      <Typography variant="subtitle2" fontWeight="bold" mb={1}>
        📹 Камеры
      </Typography>
      <List dense>
        {cameras.map(camera => (
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
      </List>
    </Box>
  );
};

export default RecordingsCameraList;