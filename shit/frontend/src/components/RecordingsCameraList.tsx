import React from 'react';
import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Checkbox,
  Chip,
} from '@mui/material';
import { Videocam } from '@mui/icons-material';

interface RecordingsCameraListProps {
  cameras: string[];
  selectedCameras: string[];
  onToggle: (camera: string) => void;
  recordings: Record<string, any[]>;
}

const RecordingsCameraList: React.FC<RecordingsCameraListProps> = ({
  cameras,
  selectedCameras,
  onToggle,
  recordings,
}) => {
  return (
    <Box>
      <Typography variant="subtitle2" fontWeight="bold" mb={1}>
        📹 Cameras
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
              {recordings[camera]?.length > 0 && (
                <Chip label="M" size="small" color="primary" />
              )}
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </Box>
  );
};

export default RecordingsCameraList;