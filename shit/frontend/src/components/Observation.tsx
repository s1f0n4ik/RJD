import React, { useState, useEffect, useRef } from 'react';
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
  IconButton,
  Select,
  FormControl,
  InputLabel,
  Divider,
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Videocam as VideocamIcon,
  Close as CloseIcon,
  Fullscreen as FullscreenIcon,
  GridOn as GridOnIcon,
  DragIndicator as DragIndicatorIcon,
  Save as SaveIcon,
  Delete as DeleteIcon,
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

interface SavedLayout {
  name: string;
  gridSize: GridSize;
  customCells?: CustomCell[];
  customGridRows?: number;
  customGridCols?: number;
  activeCells: Record<number | string, string>;
  timestamp: number;
}

const STORAGE_KEY = 'observation_layouts';

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
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ row: number; col: number } | null>(null);
  const [drawEnd, setDrawEnd] = useState<{ row: number; col: number } | null>(null);
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [resizing, setResizing] = useState<{ cellId: string; corner: string } | null>(null);

  // Layout Management
  const [savedLayouts, setSavedLayouts] = useState<SavedLayout[]>([]);
  const [currentLayoutName, setCurrentLayoutName] = useState<string>('');
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [newLayoutName, setNewLayoutName] = useState('');

  // Drag & Drop State
  const [draggedCamera, setDraggedCamera] = useState<string | null>(null);

  const SIGNALING_SERVER = 'ws://192.168.1.2:8765';

  useEffect(() => {
    loadCameras();
    loadSavedLayouts();
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

  // Layout Management Functions
  const loadSavedLayouts = () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const layouts: SavedLayout[] = JSON.parse(stored);
        setSavedLayouts(layouts);
      }
    } catch (error) {
      console.error('Error loading layouts:', error);
    }
  };

  const saveCurrentLayout = () => {
    if (!newLayoutName.trim()) {
      alert('Введите название layout');
      return;
    }

    const layout: SavedLayout = {
      name: newLayoutName.trim(),
      gridSize,
      customCells: gridSize === 'custom' ? customCells : undefined,
      customGridRows: gridSize === 'custom' ? customGridRows : undefined,
      customGridCols: gridSize === 'custom' ? customGridCols : undefined,
      activeCells,
      timestamp: Date.now(),
    };

    const existingIndex = savedLayouts.findIndex(l => l.name === layout.name);
    let newLayouts: SavedLayout[];

    if (existingIndex >= 0) {
      newLayouts = [...savedLayouts];
      newLayouts[existingIndex] = layout;
    } else {
      newLayouts = [...savedLayouts, layout];
    }

    setSavedLayouts(newLayouts);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newLayouts));
    setCurrentLayoutName(layout.name);
    setSaveDialogOpen(false);
    setNewLayoutName('');
  };

  const loadLayout = (layoutName: string) => {
    const layout = savedLayouts.find(l => l.name === layoutName);
    if (!layout) return;

    setGridSize(layout.gridSize);
    setActiveCells(layout.activeCells);

    if (layout.gridSize === 'custom' && layout.customCells) {
      setCustomCells(layout.customCells);
      setCustomGridRows(layout.customGridRows || 3);
      setCustomGridCols(layout.customGridCols || 3);
    }

    setCurrentLayoutName(layoutName);
  };

  const deleteLayout = (layoutName: string) => {
    if (!confirm(`Удалить layout "${layoutName}"?`)) return;

    const newLayouts = savedLayouts.filter(l => l.name !== layoutName);
    setSavedLayouts(newLayouts);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newLayouts));

    if (currentLayoutName === layoutName) {
      setCurrentLayoutName('');
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
      setCurrentLayoutName(''); // Reset layout name when changing manually
    }
  };

  // Visual Grid Editor Functions
  const handleGridCellMouseDown = (row: number, col: number) => {
    // Check if clicking on existing cell
    const clickedCell = customCells.find(cell =>
      row >= cell.row && row < cell.row + cell.rowSpan &&
      col >= cell.col && col < cell.col + cell.colSpan
    );

    if (clickedCell) {
      setSelectedCellId(clickedCell.id);
      return;
    }

    // Start drawing new cell
    setIsDrawing(true);
    setDrawStart({ row, col });
    setDrawEnd({ row, col });
    setSelectedCellId(null);
  };

  const handleGridCellMouseEnter = (row: number, col: number) => {
    if (isDrawing && drawStart) {
      setDrawEnd({ row, col });
    }
  };

  const handleGridCellMouseUp = () => {
    if (isDrawing && drawStart && drawEnd) {
      const minRow = Math.min(drawStart.row, drawEnd.row);
      const maxRow = Math.max(drawStart.row, drawEnd.row);
      const minCol = Math.min(drawStart.col, drawEnd.col);
      const maxCol = Math.max(drawStart.col, drawEnd.col);

      // Check for overlaps
      const hasOverlap = customCells.some(cell => {
        const cellMaxRow = cell.row + cell.rowSpan - 1;
        const cellMaxCol = cell.col + cell.colSpan - 1;

        return !(maxRow < cell.row || minRow > cellMaxRow ||
                 maxCol < cell.col || minCol > cellMaxCol);
      });

      if (!hasOverlap) {
        const newCell: CustomCell = {
          id: `custom-${Date.now()}`,
          row: minRow,
          col: minCol,
          rowSpan: maxRow - minRow + 1,
          colSpan: maxCol - minCol + 1,
        };
        setCustomCells([...customCells, newCell]);
      } else {
        alert('Ячейки не должны накладываться друг на друга');
      }
    }

    setIsDrawing(false);
    setDrawStart(null);
    setDrawEnd(null);
  };

  const handleDeleteSelectedCell = () => {
    if (selectedCellId) {
      setCustomCells(customCells.filter(cell => cell.id !== selectedCellId));
      const newActiveCells = { ...activeCells };
      delete newActiveCells[selectedCellId];
      setActiveCells(newActiveCells);
      setSelectedCellId(null);
    }
  };

  const handleApplyCustomGrid = () => {
    if (customCells.length === 0) {
      alert('Создайте хотя бы одну ячейку');
      return;
    }
    setGridSize('custom');
    setCustomDialogOpen(false);
    setCurrentLayoutName(''); // Reset layout name
  };

  const isCellInDrawRect = (row: number, col: number): boolean => {
    if (!drawStart || !drawEnd) return false;
    const minRow = Math.min(drawStart.row, drawEnd.row);
    const maxRow = Math.max(drawStart.row, drawEnd.row);
    const minCol = Math.min(drawStart.col, drawEnd.col);
    const maxCol = Math.max(drawStart.col, drawEnd.col);
    return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
  };

  const getCellAtPosition = (row: number, col: number): CustomCell | null => {
    return customCells.find(cell =>
      row >= cell.row && row < cell.row + cell.rowSpan &&
      col >= cell.col && col < cell.col + cell.colSpan
    ) || null;
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
      setCurrentLayoutName(''); // Reset layout name when modifying
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
      setCurrentLayoutName(''); // Reset layout name
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
    setCurrentLayoutName(''); // Reset layout name
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
                <WebRTCPlayer
                  key={`player-${cell.id}-${cameraName}`}
                  cameraId={cameraName}
                  signalingUrl={`${SIGNALING_SERVER}/client/${cameraName}`}
                  onError={(err) => console.error(`Error in ${cameraName}:`, err)}
                />
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
          <WebRTCPlayer
            key={`player-${cellId}-${cameraName}`}
            cameraId={cameraName}
            signalingUrl={`${SIGNALING_SERVER}/client/${cameraName}`}
            onError={(err) => console.error(`Error in ${cameraName}:`, err)}
          />
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
          }}
        >
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6" fontWeight="bold">
              Видеосетка
            </Typography>

            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              {/* Layout Selector */}
              <FormControl size="small" sx={{ minWidth: 150 }}>
                <InputLabel>Layout</InputLabel>
                <Select
                  value={currentLayoutName}
                  label="Layout"
                  onChange={(e) => loadLayout(e.target.value)}
                >
                  <MenuItem value="">
                    <em>Не выбрано</em>
                  </MenuItem>
                  {savedLayouts.map((layout) => (
                    <MenuItem key={layout.name} value={layout.name}>
                      {layout.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <IconButton
                size="small"
                color="primary"
                onClick={() => setSaveDialogOpen(true)}
                title="Сохранить текущий layout"
              >
                <SaveIcon />
              </IconButton>

              {currentLayoutName && (
                <IconButton
                  size="small"
                  color="error"
                  onClick={() => deleteLayout(currentLayoutName)}
                  title="Удалить текущий layout"
                >
                  <DeleteIcon />
                </IconButton>
              )}
            </Box>
          </Box>

          {/* Grid Size Buttons */}
          <ToggleButtonGroup
            value={gridSize}
            exclusive
            onChange={handleGridSizeChange}
            size="small"
            fullWidth
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

      {/* SAVE LAYOUT DIALOG */}
      <Dialog open={saveDialogOpen} onClose={() => setSaveDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Сохранить Layout</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Название layout"
            type="text"
            fullWidth
            value={newLayoutName}
            onChange={(e) => setNewLayoutName(e.target.value)}
            placeholder="Например: Охрана, Входы, По умолчанию"
          />
          {savedLayouts.find(l => l.name === newLayoutName) && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              Layout с таким именем уже существует и будет перезаписан
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSaveDialogOpen(false)}>Отмена</Button>
          <Button onClick={saveCurrentLayout} variant="contained">
            Сохранить
          </Button>
        </DialogActions>
      </Dialog>

      {/* VISUAL CUSTOM GRID EDITOR */}
      <Dialog
        open={customDialogOpen}
        onClose={() => setCustomDialogOpen(false)}
        maxWidth="lg"
        fullWidth
        PaperProps={{
          sx: { height: '90vh' }
        }}
      >
        <DialogTitle>
          <Box display="flex" justifyContent="space-between" alignItems="center">
            <Typography variant="h6">Редактор кастомной сетки</Typography>
            <Box>
              <TextField
                size="small"
                type="number"
                label="Строки"
                value={customGridRows}
                onChange={(e) => setCustomGridRows(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                sx={{ width: 80, mr: 1 }}
                InputProps={{ inputProps: { min: 1, max: 10 } }}
              />
              <TextField
                size="small"
                type="number"
                label="Колонки"
                value={customGridCols}
                onChange={(e) => setCustomGridCols(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                sx={{ width: 80 }}
                InputProps={{ inputProps: { min: 1, max: 10 } }}
              />
            </Box>
          </Box>
        </DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2 }}>
            <strong>Как использовать:</strong>
            <br />• Зажмите ЛКМ и выделите область для создания ячейки
            <br />• Кликните на ячейку, чтобы выбрать её
            <br />• Нажмите Delete, чтобы удалить выбранную ячейку
          </Alert>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: `repeat(${customGridCols}, 1fr)`,
              gridTemplateRows: `repeat(${customGridRows}, 1fr)`,
              gap: 0.5,
              height: 'calc(90vh - 250px)',
              bgcolor: '#f5f5f5',
              p: 2,
              borderRadius: 1,
              userSelect: 'none',
            }}
            onMouseUp={handleGridCellMouseUp}
            onMouseLeave={handleGridCellMouseUp}
            onKeyDown={(e) => {
              if (e.key === 'Delete' || e.key === 'Backspace') {
                handleDeleteSelectedCell();
              }
            }}
            tabIndex={0}
          >
            {Array.from({ length: customGridRows }).map((_, rowIndex) =>
              Array.from({ length: customGridCols }).map((_, colIndex) => {
                const row = rowIndex + 1;
                const col = colIndex + 1;
                const existingCell = getCellAtPosition(row, col);
                const isInDrawRect = isCellInDrawRect(row, col);
                const isSelected = existingCell && existingCell.id === selectedCellId;

                // Skip rendering if this cell is covered by a multi-cell
                if (existingCell && !(existingCell.row === row && existingCell.col === col)) {
                  return null;
                }

                return (
                  <Box
                    key={`${row}-${col}`}
                    onMouseDown={() => handleGridCellMouseDown(row, col)}
                    onMouseEnter={() => handleGridCellMouseEnter(row, col)}
                    sx={{
                      gridColumn: existingCell ? `${existingCell.col} / span ${existingCell.colSpan}` : 'auto',
                      gridRow: existingCell ? `${existingCell.row} / span ${existingCell.rowSpan}` : 'auto',
                      border: existingCell
                        ? `3px solid ${isSelected ? '#f44336' : '#2196f3'}`
                        : isInDrawRect
                        ? '2px solid #4caf50'
                        : '1px dashed #ccc',
                      borderRadius: 1,
                      bgcolor: existingCell
                        ? isSelected
                          ? 'rgba(244, 67, 54, 0.1)'
                          : 'rgba(33, 150, 243, 0.1)'
                        : isInDrawRect
                        ? 'rgba(76, 175, 80, 0.2)'
                        : 'white',
                      cursor: existingCell ? 'pointer' : 'crosshair',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'all 0.1s',
                      '&:hover': {
                        bgcolor: existingCell
                          ? isSelected
                            ? 'rgba(244, 67, 54, 0.2)'
                            : 'rgba(33, 150, 243, 0.2)'
                          : 'rgba(0, 0, 0, 0.02)',
                      },
                    }}
                  >
                    {existingCell && existingCell.row === row && existingCell.col === col && (
                      <Typography variant="caption" color="primary" fontWeight="bold">
                        {existingCell.rowSpan}x{existingCell.colSpan}
                      </Typography>
                    )}
                  </Box>
                );
              })
            )}
          </Box>

          <Box sx={{ mt: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              Создано ячеек: {customCells.length}
              {selectedCellId && ' | Выбрана ячейка (нажмите Delete для удаления)'}
            </Typography>
            <Button
              variant="outlined"
              color="error"
              size="small"
              onClick={() => {
                if (confirm('Удалить все ячейки?')) {
                  setCustomCells([]);
                  setSelectedCellId(null);
                }
              }}
              disabled={customCells.length === 0}
            >
              Очистить всё
            </Button>
          </Box>
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
            Применить ({customCells.length} ячеек)
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Observation;