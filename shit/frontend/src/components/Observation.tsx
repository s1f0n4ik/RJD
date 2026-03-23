import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Paper,
  ToggleButtonGroup,
  ToggleButton,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Alert,
  IconButton,
  Menu,
  MenuItem,
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Videocam as VideocamIcon,
  Close as CloseIcon,
  Fullscreen as FullscreenIcon,
} from '@mui/icons-material';
import WebRTCPlayer from './WebRTCPlayer';
import { api, type CPPCamera } from '../services/api';

type GridSize = 1 | 4 | 9 | 16;

const Observation: React.FC = () => {
  const [cameras, setCameras] = useState<CPPCamera[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
  const [activeCells, setActiveCells] = useState<Record<number, string>>({});
  const [gridSize, setGridSize] = useState<GridSize>(4);
  const [loadError, setLoadError] = useState<string>('');
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    cellIndex: number;
  } | null>(null);

  const SIGNALING_SERVER = 'ws://192.168.1.2:8765';

  useEffect(() => {
    loadCameras();
  }, []);

  const loadCameras = async () => {
    try {
      const data = await api.getCameras();

      if (!Array.isArray(data)) {
        console.error('❌ Cameras data is not array:', data);
        setLoadError('Получены некорректные данные с сервера');
        setCameras([]);
        return;
      }

      console.log('✅ Loaded cameras:', data);
      setCameras(data);
      setLoadError('');

    } catch (error) {
      console.error('❌ Failed to load cameras:', error);
      setLoadError(error instanceof Error ? error.message : 'Ошибка загрузки камер');
      setCameras([]);
    }
  };

  const handleGridSizeChange = (_: any, newSize: GridSize | null) => {
    if (newSize) {
      setGridSize(newSize);
      const newActiveCells: Record<number, string> = {};
      Object.entries(activeCells).forEach(([index, cameraName]) => {
        if (parseInt(index) < newSize) {
          newActiveCells[parseInt(index)] = cameraName;
        }
      });
      setActiveCells(newActiveCells);
    }
  };

  const handleCellClick = (index: number) => {
    if (activeCells[index]) return;

  if (selectedCamera) {
    const alreadyUsed = Object.values(activeCells).includes(selectedCamera);
    if (alreadyUsed) {
      alert('Эта камера уже отображается');
      return;
    }

    setActiveCells(prev => ({
      ...prev,
      [index]: selectedCamera,
      }));
    }
  };

  const handleCellRightClick = (event: React.MouseEvent, index: number) => {
    event.preventDefault();
    if (activeCells[index]) {
      setContextMenu({
        mouseX: event.clientX,
        mouseY: event.clientY,
        cellIndex: index,
      });
    }
  };

  const handleCloseContextMenu = () => {
    setContextMenu(null);
  };

  const handleRemoveCamera = () => {
    if (contextMenu) {
      const newActiveCells = { ...activeCells };
      delete newActiveCells[contextMenu.cellIndex];
      setActiveCells(newActiveCells);
    }
    handleCloseContextMenu();
  };

  const handleFullscreen = () => {
    if (contextMenu) {
      const cellIndex = contextMenu.cellIndex;
      const videoElement = document.getElementById(`video-cell-${cellIndex}`)?.querySelector('video');
      if (videoElement) {
        if (videoElement.requestFullscreen) {
          videoElement.requestFullscreen();
        }
      }
    }
    handleCloseContextMenu();
  };

  const getGridCols = (): number => {
    return Math.sqrt(gridSize);
  };

  const getCameraStatus = (cameraName: string): boolean => {
    const camera = cameras.find(c => c.name === cameraName);
    return camera?.streams?.main?.status === 3;
  };

  return (
    <Box sx={{ display: 'flex', height: 'calc(100vh - 120px)', gap: 0 }}>
      <Paper
        elevation={3}
        sx={{
          width: 200,
          flexShrink: 0,
          overflow: 'auto',
          borderRadius: 0,
        }}
      >
        <Box sx={{ p: 2, borderBottom: '1px solid #e0e0e0' }}>
          <Typography variant="subtitle2" fontWeight="bold">
            📹 Камеры
          </Typography>
        </Box>

        {loadError && (
          <Alert severity="error" sx={{ m: 1 }}>
            {loadError}
          </Alert>
        )}

        <List dense>
          {cameras.map((camera) => {
            const isActive = getCameraStatus(camera.name);
            const isSelected = selectedCamera === camera.name;

            return (
              <ListItem
                key={camera.name}
                button
                selected={isSelected}
                onClick={() => setSelectedCamera(camera.name)}
                sx={{
                  bgcolor: isSelected ? 'info.main' : 'transparent',
                  color: isSelected ? 'white' : 'inherit',
                  '&:hover': {
                    bgcolor: isSelected ? 'info.dark' : 'action.hover',
                  },
                  '&.Mui-selected': {
                    bgcolor: 'info.main',
                    '&:hover': {
                      bgcolor: 'info.dark',
                    },
                  },
                }}
              >
                <ListItemIcon sx={{ minWidth: 36 }}>
                  {isActive ? (
                    <CheckCircleIcon
                      color={isSelected ? 'inherit' : 'success'}
                      sx={{ color: isSelected ? 'white' : undefined }}
                    />
                  ) : (
                    <ErrorIcon color="disabled" />
                  )}
                </ListItemIcon>
                <ListItemText
                  primary={camera.name}
                  primaryTypographyProps={{
                    fontSize: '0.875rem',
                    fontWeight: isSelected ? 600 : 400,
                  }}
                />
              </ListItem>
            );
          })}
        </List>

        {cameras.length === 0 && !loadError && (
          <Box sx={{ p: 2, textAlign: 'center' }}>
            <Typography variant="caption" color="text.secondary">
              Нет доступных камер
            </Typography>
          </Box>
        )}
      </Paper>

      <Box
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
          bgcolor: '#f5f5f5',
        }}
      >
        <Paper
          elevation={0}
          sx={{
            p: 2,
            borderRadius: 0,
            borderBottom: '1px solid #e0e0e0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Typography variant="h6" fontWeight="bold">
            Видеосетка
          </Typography>

          <ToggleButtonGroup
            value={gridSize}
            exclusive
            onChange={handleGridSizeChange}
            size="small"
          >
            <ToggleButton value={1}>1x1</ToggleButton>
            <ToggleButton value={4}>2x2</ToggleButton>
            <ToggleButton value={9}>3x3</ToggleButton>
            <ToggleButton value={16}>4x4</ToggleButton>
          </ToggleButtonGroup>
        </Paper>

        <Box
          sx={{
            flex: 1,
            p: 2,
            display: 'grid',
            gridTemplateColumns: `repeat(${getGridCols()}, 1fr)`,
            gap: 1,
            alignContent: 'start',
          }}
        >
          {Array.from({ length: gridSize }).map((_, index) => {
            const cameraName = activeCells[index];

            return (
              <Box
                id={`video-cell-${index}`}
                key={index}
                onClick={() => handleCellClick(index)}
                onContextMenu={(e) => handleCellRightClick(e, index)}
                sx={{
                  aspectRatio: '16/9',
                  border: cameraName ? '2px solid #2196f3' : '2px dashed #9e9e9e',
                  borderRadius: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: cameraName ? 'black' : '#fafafa',
                  cursor: cameraName ? 'context-menu' : 'pointer',
                  position: 'relative',
                  overflow: 'hidden',
                  transition: 'border-color 0.2s',
                  '&:hover': {
                    borderColor: cameraName ? '#1976d2' : '#2196f3',
                  },
                }}
              >
                {cameraName ? (
                  <WebRTCPlayer
                    cameraId={cameraName}
                    signalingUrl={`${SIGNALING_SERVER}/client/${cameraName}`}
                    onError={(err) => console.error(`Error in ${cameraName}:`, err)}
                  />
                ) : (
                  <Box
                    sx={{
                      textAlign: 'center',
                      color: 'text.secondary',
                    }}
                  >
                    <VideocamIcon sx={{ fontSize: 60, mb: 1, opacity: 0.3 }} />
                    <Typography variant="body2" sx={{ opacity: 0.6 }}>
                      {selectedCamera
                        ? `Нажмите, чтобы добавить ${selectedCamera}`
                        : 'Выберите камеру слева'}
                    </Typography>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      </Box>

      <Menu
        open={contextMenu !== null}
        onClose={handleCloseContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenu !== null
            ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
            : undefined
        }
      >
        <MenuItem onClick={handleFullscreen}>
          <FullscreenIcon sx={{ mr: 1 }} />
          Полноэкранный режим
        </MenuItem>
        <MenuItem onClick={handleRemoveCamera}>
          <CloseIcon sx={{ mr: 1 }} />
          Закрыть камеру
        </MenuItem>
      </Menu>
    </Box>
  );
};

export default Observation;