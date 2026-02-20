import React, { useState, useEffect } from 'react';
import {
  Container,
  Grid,
  Box,
  Typography,
  Paper,
  ToggleButtonGroup,
  ToggleButton,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  Checkbox,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
} from '@mui/material';
import { ViewModule, ViewQuilt, GridView, Settings } from '@mui/icons-material';
import WebRTCPlayer from './WebRTCPlayer';
import { api } from '../services/api';
import type { Camera } from '../types';

type GridSize = 1 | 4 | 6 | 9;

const Observation: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selectedCameras, setSelectedCameras] = useState<string[]>([]);
  const [gridSize, setGridSize] = useState<GridSize>(4);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // URL сигналинг сервера (настройте свой)
  const SIGNALING_SERVER = 'ws://192.168.1.2:8765'; // ← ваш сервер из server.py

  useEffect(() => {
    loadCameras();
  }, []);

  const loadCameras = async () => {
    try {
      const data = await api.getCameras();
      setCameras(data);

      // По умолчанию выбираем первые N камер
      const defaultSelected = data.slice(0, gridSize).map(c => c.camera_name);
      setSelectedCameras(defaultSelected);
    } catch (error) {
      console.error('Failed to load cameras:', error);
    }
  };

  const handleGridSizeChange = (_: any, newSize: GridSize | null) => {
    if (newSize) {
      setGridSize(newSize);
      // Обрезаем выбранные камеры если нужно
      if (selectedCameras.length > newSize) {
        setSelectedCameras(selectedCameras.slice(0, newSize));
      }
    }
  };

  const handleToggleCamera = (cameraName: string) => {
    setSelectedCameras((prev) => {
      if (prev.includes(cameraName)) {
        return prev.filter(c => c !== cameraName);
      } else if (prev.length < gridSize) {
        return [...prev, cameraName];
      } else {
        return prev; // Лимит достигнут
      }
    });
  };

  const getGridColumns = (): number => {
    switch (gridSize) {
      case 1: return 1;
      case 4: return 2;
      case 6: return 3;
      case 9: return 3;
      default: return 2;
    }
  };

  return (
    <Container maxWidth="xl">
      {/* Панель управления */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Typography variant="h6" fontWeight="bold">
            📹 Наблюдение
          </Typography>

          <Box display="flex" gap={2} alignItems="center">
            {/* Выбор размера сетки */}
            <ToggleButtonGroup
              value={gridSize}
              exclusive
              onChange={handleGridSizeChange}
              size="small"
            >
              <ToggleButton value={1}>
                <ViewModule /> <Box ml={1}>1</Box>
              </ToggleButton>
              <ToggleButton value={4}>
                <ViewQuilt /> <Box ml={1}>4</Box>
              </ToggleButton>
              <ToggleButton value={6}>
                <GridView /> <Box ml={1}>6</Box>
              </ToggleButton>
              <ToggleButton value={9}>
                <GridView /> <Box ml={1}>9</Box>
              </ToggleButton>
            </ToggleButtonGroup>

            {/* Кнопка настроек */}
            <Button
              variant="outlined"
              startIcon={<Settings />}
              onClick={() => setSettingsOpen(true)}
            >
              Камеры
            </Button>
          </Box>
        </Box>
      </Paper>

      {/* Сетка камер */}
      {selectedCameras.length === 0 ? (
        <Paper sx={{ p: 8, textAlign: 'center' }}>
          <Typography variant="h5" color="text.secondary" gutterBottom>
            Камеры не выбраны
          </Typography>
          <Button variant="contained" onClick={() => setSettingsOpen(true)}>
            Выбрать камеры
          </Button>
        </Paper>
      ) : (
        <Grid container spacing={2} sx={{ height: 'calc(100vh - 250px)' }}>
          {selectedCameras.map((cameraName) => (
            <Grid
              item
              xs={12}
              sm={12 / getGridColumns()}
              key={cameraName}
              sx={{ height: `${100 / Math.ceil(gridSize / getGridColumns())}%` }}
            >
              <WebRTCPlayer
                cameraId={cameraName}
                signalingUrl={`${SIGNALING_SERVER}/client/${cameraName}`}
                onError={(err) => console.error(`Error in ${cameraName}:`, err)}
              />
            </Grid>
          ))}
        </Grid>
      )}

      {/* Диалог выбора камер */}
      <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          Выбор камер (макс. {gridSize})
        </DialogTitle>
        <DialogContent>
          <List>
            {cameras.map((camera) => (
              <ListItem
                key={camera.camera_name}
                button
                onClick={() => handleToggleCamera(camera.camera_name)}
                disabled={!selectedCameras.includes(camera.camera_name) && selectedCameras.length >= gridSize}
              >
                <ListItemIcon>
                  <Checkbox
                    checked={selectedCameras.includes(camera.camera_name)}
                    disabled={!selectedCameras.includes(camera.camera_name) && selectedCameras.length >= gridSize}
                  />
                </ListItemIcon>
                <ListItemText
                  primary={camera.camera_name}
                  secondary={camera.status === 'running' ? 'Активна' : 'Остановлена'}
                />
              </ListItem>
            ))}
          </List>
        </DialogContent>
      </Dialog>
    </Container>
  );
};

export default Observation;