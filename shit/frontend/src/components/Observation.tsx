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
  Alert,
} from '@mui/material';
import { ViewModule, ViewQuilt, GridView, Settings } from '@mui/icons-material';
import WebRTCPlayer from './WebRTCPlayer';
import { api, type CPPCamera } from '../services/api';

type GridSize = 1 | 4 | 6 | 9;

const Observation: React.FC = () => {
  const [cameras, setCameras] = useState<CPPCamera[]>([]);
  const [selectedCameras, setSelectedCameras] = useState<string[]>([]);
  const [gridSize, setGridSize] = useState<GridSize>(4);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loadError, setLoadError] = useState<string>(''); // ✅ ДОБАВЛЕНО

  const SIGNALING_SERVER = 'ws://192.168.1.2:8765';

  useEffect(() => {
    loadCameras();
  }, []);

  const loadCameras = async () => {
    try {
      const data = await api.getCameras();

      // ✅ ДОБАВЛЕНО: Дополнительная проверка
      if (!Array.isArray(data)) {
        console.error('❌ Cameras data is not array:', data);
        setLoadError('Получены некорректные данные с сервера');
        setCameras([]);
        return;
      }

      setCameras(data);
      setLoadError('');

      // По умолчанию выбираем камеры со статусом 3 (running)
      const runningCameras = data
        .filter(c => c.main?.status === 3)
        .slice(0, gridSize)
        .map(c => c.name);

      setSelectedCameras(runningCameras);
    } catch (error) {
      console.error('Failed to load cameras:', error);
      setLoadError(error instanceof Error ? error.message : 'Ошибка загрузки камер');
      setCameras([]);
    }
  };

  const handleGridSizeChange = (_: any, newSize: GridSize | null) => {
    if (newSize) {
      setGridSize(newSize);
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
        return prev;
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
      <Paper sx={{ p: 2, mb: 3 }}>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Typography variant="h6" fontWeight="bold">
            📹 Наблюдение
          </Typography>

          <Box display="flex" gap={2} alignItems="center">
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

      {/* ✅ ДОБАВЛЕНО: Показываем ошибку загрузки */}
      {loadError && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {loadError}
        </Alert>
      )}

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
          {cameras.length === 0 ? (
            <Alert severity="info">Нет доступных камер</Alert>
          ) : (
            <List>
              {cameras.map((camera) => (
                <ListItem
                  key={camera.name}
                  button
                  onClick={() => handleToggleCamera(camera.name)}
                  disabled={!selectedCameras.includes(camera.name) && selectedCameras.length >= gridSize}
                >
                  <ListItemIcon>
                    <Checkbox
                      checked={selectedCameras.includes(camera.name)}
                      disabled={!selectedCameras.includes(camera.name) && selectedCameras.length >= gridSize}
                    />
                  </ListItemIcon>
                  <ListItemText
                    primary={camera.name}
                    secondary={camera.main?.status === 3 ? '🟢 Активна' : '🔴 Остановлена'}
                  />
                </ListItem>
              ))}
            </List>
          )}
        </DialogContent>
      </Dialog>
    </Container>
  );
};

export default Observation;