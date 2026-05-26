import React from 'react';
import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  IconButton,
} from '@mui/material';
import { Download, PlayArrow } from '@mui/icons-material';

interface Recording {
  filename: string;
  size: number;
  created: string;
  modified: string;
}

interface RecordingsFileListProps {
  recordings: Record<string, Recording[]>;
  selectedCameras: string[];
  selectedDate: Date;
  onFileSelect: (camera: string, file: Recording) => void;
}

const RecordingsFileList: React.FC<RecordingsFileListProps> = ({
  recordings,
  selectedCameras,
  selectedDate,
  onFileSelect,
}) => {
  const formatTime = (isoDate: string) => {
    return new Date(isoDate).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatBytes = (bytes: number) => {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  };

  const getFilesForSelectedDate = () => {
    const dateStr = selectedDate.toISOString().split('T')[0];
    const result: { camera: string; files: Recording[] }[] = [];

    selectedCameras.forEach(camera => {
      const files = recordings[camera]?.filter(f =>
        f.created.startsWith(dateStr)
      ) || [];
      if (files.length > 0) {
        result.push({ camera, files });
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
        filesData.map(({ camera, files }) => (
          <Box key={camera} mb={2}>
            <Typography variant="caption" color="text.secondary" fontWeight="bold">
              {camera}
            </Typography>
            <List dense>
              {files.map(file => (
                <ListItem
                  key={file.filename}
                  secondaryAction={
                    <IconButton
                      size="small"
                      onClick={() =>
                        window.open(`/api/recordings/download/${camera}/${file.filename}`)
                      }
                    >
                      <Download fontSize="small" />
                    </IconButton>
                  }
                >
                  <ListItemButton onClick={() => onFileSelect(camera, file)}>
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
        ))
      )}
    </Box>
  );
};

export default RecordingsFileList;