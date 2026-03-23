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
  Menu,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Grid,
  IconButton,
  Tooltip,
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Videocam as VideocamIcon,
  Close as CloseIcon,
  Fullscreen as FullscreenIcon,
  GridOn as GridOnIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
  DragIndicator as DragIndicatorIcon,
} from '@mui/icons-material';
import WebRTCPlayer from './WebRTCPlayer';
import { api, type CPPCamera } from '../services/api';

type GridSize = 1 | 4 | 9 | 16 | 'custom';

interface CustomCell {
  id: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

const Observation: React.FC = () => {
  const [cameras, setCameras] = useState<CPPCamera[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
  const [activeCells, setActiveCells] = useState<Record<number | string, string>>({});
  const [gridSize, setGridSize] = useState<GridSize>(4);
  const [loadError, setLoadError] = useState<string>('');
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    cellId: number | string;
  } | null>(null);

  // Custom Grid State
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [customCells, setCustomCells] = useState<CustomCell[]>([]);
  const [customGridRows, setCustomGridRows] = useState(3);
  const [customGridCols, setCustomGridCols] = useState(3);

  // Drag & Drop State
  const [draggedCamera, setDraggedCamera] = useState<string | null>(null);

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
      if (newSize === 'custom') {
        setCustomDialogOpen(true);
        return;
      }

      setGridSize(newSize);
      const newActiveCells: Record<number, string> = {};
      Object.entries(activeCells).forEach(([index, cameraName]) => {
        const numIndex = parseInt(index);
        if (!isNaN(numIndex) && numIndex < (newSize as number)) {
          newActiveCells[numIndex] = cameraName;
        }
      });
      setActiveCells(newActiveCells);
    }
  };

  const handleApplyCustomGrid = () => {
    setGridSize('custom');
    setCustomDialogOpen(false);

    // Очищаем активные ячейки, оставляем только custom
    const newActiveCells: Record<string, string> = {};
    Object.entries(activeCells).forEach(([id, cameraName]) => {
      if (id.startsWith('custom-')) {
        newActiveCells[id] = cameraName;
      }
    });
    setActiveCells(newActiveCells);
  };

  const handleAddCustomCell = () => {
    const newCell: CustomCell = {
      id: `custom-${Date.now()}`,
      row: 1,
      col: 1,
      rowSpan: 1,
      colSpan: 1,
    };
    setCustomCells([...customCells, newCell]);
  };

  const handleUpdateCustomCell = (id: string, updates: Partial<CustomCell>) => {
    setCustomCells(customCells.map(cell =>
      cell.id === id ? { ...cell, ...updates } : cell
    ));
  };

  const handleDeleteCustomCell = (id: string) => {
    setCustomCells(customCells.filter(cell => cell.id !== id));
    const newActiveCells = { ...activeCells };
    delete newActiveCells[id];
    setActiveCells(newActiveCells);
  };

  const handleCellClick = (cellId: number | string) => {
    if (activeCells[cellId]) return;

    if (selectedCamera) {
      const alreadyUsed = Object.values(activeCells).includes(selectedCamera);
      if (alreadyUsed) {
        alert('Эта камера уже отображается');
        return;
      }

      setActiveCells(prev => ({
        ...prev,
        [cellId]: selectedCamera,
      }));
    }
  };

  const handleCellRightClick = (event: React.MouseEvent, cellId: number | string) => {
    event.preventDefault();
    if (activeCells[cellId]) {
      setContextMenu({
        mouseX: event.clientX,
        mouseY: event.clientY,
        cellId,
      });
    }
  };

  const handleCloseContextMenu = () => {
    setContextMenu(null);
  };

  const handleRemoveCamera = () => {
    if (contextMenu) {
      const newActiveCells = { ...activeCells };
      delete newActiveCells[contextMenu.cellId];
      setActiveCells(newActiveCells);
    }
    handleCloseContextMenu();
  };

  const handleFullscreen = () => {
    if (contextMenu) {
      const cellId = contextMenu.cellId;
      const videoElement = document.getElementById(`video-cell-${cellId}`)?.querySelector('video');
      if (videoElement) {
        if (videoElement.requestFullscreen) {
          videoElement.requestFullscreen();
        }
      }
    }
    handleCloseContextMenu();
  };

  // Drag & Drop Handlers
  const handleDragStart = (event: React.DragEvent, cameraName: string) => {
    setDraggedCamera(cameraName);
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', cameraName);
  };

  const handleDragEnd = () => {
    setDraggedCamera(null);
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop = (event: React.DragEvent, cellId: number | string) => {
    event.preventDefault();
    const cameraName = event.dataTransfer.getData('text/plain');

    if (activeCells[cellId]) {
      alert('Ячейка уже занята');
      return;
    }

    const alreadyUsed = Object.values(activeCells).includes(cameraName);
    if (alreadyUsed) {
      alert('Эта камера уже отображается');
      return;
    }

    setActiveCells(prev => ({
      ...prev,
      [cellId]: cameraName,
    }));
    setDraggedCamera(null);
  };

  const getGridCols = (): number => {
    if (gridSize === 'custom') return customGridCols;
    return Math.sqrt(gridSize as number);
  };

  const getCameraStatus = (cameraName: string): boolean => {
    const camera = cameras.find(c => c.name === cameraName);
    return camera?.streams?.main?.status === 3;
  };

  const renderStandardGrid = () => {
    const cols = getGridCols();
    return (
      <Box
        sx={{
          flex: 1,
          p: 2,
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: 1,
          alignContent: 'start',
        }}
      >
        {Array.from({ length: gridSize as number }).map((_, index) => {
          const cameraName = activeCells[index];
          return renderCell(index, cameraName);
        })}
      </Box>
    );
  };

  const renderCustomGrid = () => {
    return (
      <Box
        sx={{
          flex: 1,
          p: 2,
          display: 'grid',
          gridTemplateColumns: `repeat(${customGridCols}, 1fr)`,
          gridTemplateRows: `repeat(${customGridRows}, 1fr)`,
          gap: 1,
        }}
      >
        {customCells.map((cell) => {
          const cameraName = activeCells[cell.id];
          return (
            <Box
              key={cell.id}
              id={`video-cell-${cell.id}`}
              onClick={() => handleCellClick(cell.id)}
              onContextMenu={(e) => handleCellRightClick(e, cell.id)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, cell.id)}
              sx={{
                gridColumn: `${cell.col} / span ${cell.colSpan}`,
                gridRow: `${cell.row} / span ${cell.rowSpan}`,
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
                minHeight: 200,
                '&:hover': {
                  borderColor: cameraName ? '#1976d2' : '#2196f3',
                },
              }}
            >
              {cameraName ? (
                <>
                  <WebRTCPlayer
                    cameraId={cameraName}
                    signalingUrl={`${SIGNALING_SERVER}/client/${cameraName}`}
                    onError={(err) => console.error(`Error in ${cameraName}:`, err)}
                  />
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 8,
                      left: 8,
                      bgcolor: 'rgba(0,0,0,0.7)',
                      color: 'white',
                      px: 1,
                      py: 0.5,
                      borderRadius: 1,
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      zIndex: 10,
                    }}
                  >
                    {cameraName}
                  </Box>
                </>
              ) : (
                <Box sx={{ textAlign: 'center', color: 'text.secondary' }}>
                  <VideocamIcon sx={{ fontSize: 60, mb: 1, opacity: 0.3 }} />
                  <Typography variant="body2" sx={{ opacity: 0.6 }}>
                    Перетащите камеру сюда
                  </Typography>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    );
  };

  const renderCell = (cellId: number, cameraName: string | undefined) => {
    return (
      <Box
        id={`video-cell-${cellId}`}
        key={cellId}
        onClick={() => handleCellClick(cellId)}
        onContextMenu={(e) => handleCellRightClick(e, cellId)}
        onDragOver={handleDragOver}
        onDrop={(e) => handleDrop(e, cellId)}
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
          <>
            <WebRTCPlayer
              cameraId={cameraName}
              signalingUrl={`${SIGNALING_SERVER}/client/${cameraName}`}
              onError={(err) => console.error(`Error in ${cameraName}:`, err)}
            />
            <Box
              sx={{
                position: 'absolute',
                top: 8,
                left: 8,
                bgcolor: 'rgba(0,0,0,0.7)',
                color: 'white',
                px: 1,
                py: 0.5,
                borderRadius: 1,
                fontSize: '0.75rem',
                fontWeight: 600,
                zIndex: 10,
              }}
            >
              {cameraName}
            </Box>
          </>
        ) : (
          <Box sx={{ textAlign: 'center', color: 'text.secondary' }}>
            <VideocamIcon sx={{ fontSize: 60, mb: 1, opacity: 0.3 }} />
            <Typography variant="body2" sx={{ opacity: 0.6 }}>
              {selectedCamera
                ? `Нажмите или перетащите`
                : 'Выберите камеру слева'}
            </Typography>
          </Box>
        )}
      </Box>
    );
  };

  return (
    <Box sx={{ display: 'flex', height: 'calc(100vh - 120px)', gap: 0 }}>
      {/* LEFT PANEL */}
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
          <Typography variant="caption" color="text.secondary">
            Перетащите в сетку
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
                draggable
                onDragStart={(e) => handleDragStart(e, camera.name)}
                onDragEnd={handleDragEnd}
                onClick={() => setSelectedCamera(camera.name)}
                sx={{
                  bgcolor: isSelected ? 'info.main' : 'transparent',
                  color: isSelected ? 'white' : 'inherit',
                  cursor: 'grab',
                  '&:active': {
                    cursor: 'grabbing',
                  },
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
                  <DragIndicatorIcon
                    sx={{
                      fontSize: 16,
                      color: isSelected ? 'white' : 'text.disabled',
                      mr: -1,
                    }}
                  />
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

      {/* CENTER PANEL */}
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
            <ToggleButton value="custom">
              <GridOnIcon sx={{ mr: 0.5 }} />
              Custom
            </ToggleButton>
          </ToggleButtonGroup>
        </Paper>

        {gridSize === 'custom' ? renderCustomGrid() : renderStandardGrid()}
      </Box>

      {/* CONTEXT MENU */}
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

      {/* CUSTOM GRID DIALOG */}
      <Dialog
        open={customDialogOpen}
        onClose={() => setCustomDialogOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          Настройка кастомной сетки
        </DialogTitle>
        <DialogContent>
          <Grid container spacing={2} sx={{ mt: 1 }}>
            <Grid item xs={6}>
              <TextField
                label="Количество строк"
                type="number"
                value={customGridRows}
                onChange={(e) => setCustomGridRows(Math.max(1, parseInt(e.target.value) || 1))}
                fullWidth
                InputProps={{ inputProps: { min: 1, max: 10 } }}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField
                label="Количество колонок"
                type="number"
                value={customGridCols}
                onChange={(e) => setCustomGridCols(Math.max(1, parseInt(e.target.value) || 1))}
                fullWidth
                InputProps={{ inputProps: { min: 1, max: 10 } }}
              />
            </Grid>
          </Grid>

          <Box sx={{ mt: 3, mb: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="subtitle2" fontWeight="bold">
              Ячейки ({customCells.length})
            </Typography>
            <Button
              variant="contained"
              size="small"
              startIcon={<AddIcon />}
              onClick={handleAddCustomCell}
            >
              Добавить ячейку
            </Button>
          </Box>

          {customCells.length === 0 ? (
            <Alert severity="info">
              Добавьте ячейки для создания кастомного layout
            </Alert>
          ) : (
            <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
              {customCells.map((cell, index) => (
                <Paper key={cell.id} sx={{ p: 2, mb: 2 }}>
                  <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                    <Typography variant="subtitle2" fontWeight="bold">
                      Ячейка #{index + 1}
                    </Typography>
                    <IconButton
                      size="small"
                      color="error"
                      onClick={() => handleDeleteCustomCell(cell.id)}
                    >
                      <DeleteIcon />
                    </IconButton>
                  </Box>
                  <Grid container spacing={2}>
                    <Grid item xs={3}>
                      <TextField
                        label="Строка"
                        type="number"
                        size="small"
                        value={cell.row}
                        onChange={(e) => handleUpdateCustomCell(cell.id, {
                          row: Math.max(1, Math.min(customGridRows, parseInt(e.target.value) || 1))
                        })}
                        fullWidth
                        InputProps={{ inputProps: { min: 1, max: customGridRows } }}
                      />
                    </Grid>
                    <Grid item xs={3}>
                      <TextField
                        label="Колонка"
                        type="number"
                        size="small"
                        value={cell.col}
                        onChange={(e) => handleUpdateCustomCell(cell.id, {
                          col: Math.max(1, Math.min(customGridCols, parseInt(e.target.value) || 1))
                        })}
                        fullWidth
                        InputProps={{ inputProps: { min: 1, max: customGridCols } }}
                      />
                    </Grid>
                    <Grid item xs={3}>
                      <TextField
                        label="Высота"
                        type="number"
                        size="small"
                        value={cell.rowSpan}
                        onChange={(e) => handleUpdateCustomCell(cell.id, {
                          rowSpan: Math.max(1, parseInt(e.target.value) || 1)
                        })}
                        fullWidth
                        InputProps={{ inputProps: { min: 1, max: customGridRows } }}
                      />
                    </Grid>
                    <Grid item xs={3}>
                      <TextField
                        label="Ширина"
                        type="number"
                        size="small"
                        value={cell.colSpan}
                        onChange={(e) => handleUpdateCustomCell(cell.id, {
                          colSpan: Math.max(1, parseInt(e.target.value) || 1)
                        })}
                        fullWidth
                        InputProps={{ inputProps: { min: 1, max: customGridCols } }}
                      />
                    </Grid>
                  </Grid>
                </Paper>
              ))}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCustomDialogOpen(false)}>
            Отмена
          </Button>
          <Button
            onClick={handleApplyCustomGrid}
            variant="contained"
            disabled={customCells.length === 0}
          >
            Применить
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Observation;