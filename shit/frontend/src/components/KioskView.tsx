import React, { useState, useEffect, useRef } from 'react';
import {
  Box, Typography, Button, Alert, IconButton, Drawer,
  List, ListItem, ListItemIcon, ListItemText, Select, MenuItem,
  FormControl, InputLabel, Divider, Tooltip,
} from '@mui/material';
import {
  Fullscreen as FullscreenIcon,
  Menu as MenuIcon,
  Home as HomeIcon,
  FullscreenExit as FullscreenExitIcon,
  Videocam as VideocamIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  DragIndicator as DragIndicatorIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import WebRTCPlayer from './WebRTCPlayer';
import { api, type CPPCamera } from '../services/api';
import { SIGNALING_SERVER } from '../utils/constants';

interface CustomCell {
  id: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

interface SavedLayout {
  name: string;
  gridSize: number | 'custom';
  customCells?: CustomCell[];
  customGridRows?: number;
  customGridCols?: number;
  activeCells: Record<number | string, string>;
  timestamp: number;
}

const STORAGE_KEY = 'observation_layouts';
const CONTROLS_HIDE_DELAY = 3000; // мс

const KioskView: React.FC = () => {
  const [layout, setLayout] = useState<SavedLayout | null>(null);
  const [error, setError] = useState<string>('');
  const [fullscreenActive, setFullscreenActive] = useState(false);
  const [availableLayouts, setAvailableLayouts] = useState<SavedLayout[]>([]);
  const [cameras, setCameras] = useState<CPPCamera[]>([]);

  // Управление: видимость шторки и боковой панели
  const [controlsVisible, setControlsVisible] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  // Редактирование ячеек в киоске (меняется in-memory, НЕ пишем обратно в localStorage
  // без явного действия пользователя, чтобы не затирать сохранённый layout)
  const [activeCellsOverride, setActiveCellsOverride] = useState<Record<number | string, string> | null>(null);

  const getLayoutNameFromUrl = (): string | null => {
    const match = window.location.pathname.match(/^\/kiosk\/?(.*)$/);
    if (!match) return null;
    const name = decodeURIComponent(match[1] || '').trim();
    return name || null;
  };

  // Загрузка layouts и камер
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        setError("Нет сохранённых layout'ов. Зайдите на главную → Наблюдение и создайте хотя бы один.");
        return;
      }
      const layouts: SavedLayout[] = JSON.parse(stored);
      setAvailableLayouts(layouts);

      const requestedName = getLayoutNameFromUrl();
      if (!requestedName) {
        if (layouts.length === 0) {
          setError("Нет сохранённых layout'ов.");
          return;
        }
        setLayout(layouts[0]);
        return;
      }
      const found = layouts.find(l => l.name === requestedName);
      if (!found) {
        setError(`Layout "${requestedName}" не найден.`);
        return;
      }
      setLayout(found);
    } catch (err) {
      setError('Ошибка чтения layouts из localStorage');
      console.error(err);
    }

    // Параллельно подгружаем список камер (для списка в шторке)
    api.getCameras().then(data => {
      if (Array.isArray(data)) setCameras(data);
    }).catch(err => console.error('Kiosk: failed to load cameras', err));
  }, []);

  // Fullscreen отслеживание
  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreenActive(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    return () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    };
  }, []);

  // Автоскрытие шторки
  const scheduleHide = () => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (!drawerOpen) setControlsVisible(false);
    }, CONTROLS_HIDE_DELAY);
  };

  useEffect(() => {
    const onMove = () => {
      setControlsVisible(true);
      scheduleHide();
    };
    window.addEventListener('mousemove', onMove);
    scheduleHide();
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen]);

  const enterFullscreen = async () => {
    try {
      await document.documentElement.requestFullscreen();
      setFullscreenActive(true);
    } catch (err) {
      console.error('Fullscreen failed:', err);
    }
  };

  const exitKiosk = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    window.location.href = '/';
  };

  const handleSwitchLayout = (layoutName: string) => {
    const found = availableLayouts.find(l => l.name === layoutName);
    if (!found) return;
    setLayout(found);
    setActiveCellsOverride(null); // сбрасываем временные изменения
    // Обновляем URL без перезагрузки
    window.history.replaceState(null, '', `/kiosk/${encodeURIComponent(layoutName)}`);
  };

  // === Drag & Drop: смена камер в ячейках прямо в киоске ===
  const handleDragStart = (e: React.DragEvent, cameraName: string) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', cameraName);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop = (e: React.DragEvent, cellId: number | string) => {
    e.preventDefault();
    const cameraName = e.dataTransfer.getData('text/plain');
    if (!cameraName) return;

    const currentCells = activeCellsOverride ?? layout!.activeCells;
    const next = { ...currentCells };

    // Удаляем камеру из другой ячейки, если она там
    Object.entries(next).forEach(([id, name]) => {
      if (name === cameraName && id !== String(cellId)) {
        delete next[id];
      }
    });
    next[cellId] = cameraName;
    setActiveCellsOverride(next);
  };

  const handleCellDoubleClick = (cellId: number | string) => {
    const currentCells = activeCellsOverride ?? layout!.activeCells;
    if (!currentCells[cellId]) return;
    const next = { ...currentCells };
    delete next[cellId];
    setActiveCellsOverride(next);
  };

  const getCameraStatus = (cameraName: string): boolean => {
    const camera = cameras.find(c => c.name === cameraName);
    return camera?.streams?.main?.status === 3;
  };

  // === РЕНДЕР ===

  if (error) {
    return (
      <Box sx={{
        minHeight: '100vh', bgcolor: '#000', color: 'white',
        display: 'flex', alignItems: 'center', justifyContent: 'center', p: 4,
      }}>
        <Box sx={{ maxWidth: 600, width: '100%' }}>
          <Alert severity="error" sx={{ mb: 3 }}>{error}</Alert>
          {availableLayouts.length > 0 && (
            <Box>
              <Typography variant="h6" sx={{ mb: 2 }}>Доступные layouts:</Typography>
              {availableLayouts.map(l => (
                <Button key={l.name} fullWidth variant="outlined"
                  sx={{ mb: 1, color: 'white', borderColor: 'white' }}
                  onClick={() => { window.location.href = `/kiosk/${encodeURIComponent(l.name)}`; }}>
                  {l.name}
                </Button>
              ))}
            </Box>
          )}
          <Button fullWidth variant="contained" sx={{ mt: 2 }}
            onClick={() => (window.location.href = '/')}>
            Вернуться на главную
          </Button>
        </Box>
      </Box>
    );
  }

  if (!layout) {
    return (
      <Box sx={{ minHeight: '100vh', bgcolor: '#000', color: 'white',
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Typography>Загрузка...</Typography>
      </Box>
    );
  }

  if (!fullscreenActive) {
    return (
      <Box sx={{
        minHeight: '100vh', bgcolor: '#000', color: 'white',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', p: 4,
      }}>
        <Typography variant="h3" sx={{ mb: 2 }}>🎥 Киоск-режим</Typography>
        <Typography variant="h5" color="grey.400" sx={{ mb: 4 }}>
          Layout: <strong>{layout.name}</strong>
        </Typography>
        <Button variant="contained" size="large" startIcon={<FullscreenIcon />}
          onClick={enterFullscreen} sx={{ fontSize: '1.2rem', px: 4, py: 2 }}>
          Запустить полноэкранный режим
        </Button>
        <Button variant="text" sx={{ color: 'grey.400', mt: 2 }}
          onClick={() => (window.location.href = '/')}>
          ← Вернуться на главную
        </Button>
        <Typography variant="caption" color="grey.500" sx={{ mt: 3 }}>
          В киоске: подвиньте мышь сверху для панели управления • Esc — выход
        </Typography>
      </Box>
    );
  }

  const effectiveActiveCells = activeCellsOverride ?? layout.activeCells;

  const renderCellContent = (cellId: number | string) => {
    const cameraName = effectiveActiveCells[cellId];
    return (
      <Box
        onDragOver={handleDragOver}
        onDrop={(e) => handleDrop(e, cellId)}
        onDoubleClick={() => handleCellDoubleClick(cellId)}
        sx={{
          width: '100%', height: '100%',
          bgcolor: '#000',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden', border: '1px solid #222',
        }}
      >
        {cameraName ? (
          <WebRTCPlayer
            key={`kiosk-${cellId}-${cameraName}`}
            cameraId={cameraName}
            signalingUrl={`${SIGNALING_SERVER}/client/${cameraName}`}
            onError={(err) => console.error(`Kiosk error ${cameraName}:`, err)}
          />
        ) : (
          <Typography color="grey.700" variant="caption">
            Перетащите камеру
          </Typography>
        )}
      </Box>
    );
  };

  const renderStandardGrid = () => {
    const gridSize = layout.gridSize as number;
    const cols = Math.sqrt(gridSize);
    return (
      <Box sx={{
        width: '100vw', height: '100vh',
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap: 0.5, bgcolor: '#000', p: 0.5, boxSizing: 'border-box',
      }}>
        {Array.from({ length: gridSize }).map((_, index) => (
          <Box key={index}>{renderCellContent(index)}</Box>
        ))}
      </Box>
    );
  };

  const renderCustomGrid = () => {
    const rows = layout.customGridRows || 3;
    const cols = layout.customGridCols || 3;
    return (
      <Box sx={{
        width: '100vw', height: '100vh',
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        gap: 0.5, bgcolor: '#000', p: 0.5, boxSizing: 'border-box',
      }}>
        {(layout.customCells || []).map(cell => (
          <Box key={cell.id} sx={{
            gridColumn: `${cell.col} / span ${cell.colSpan}`,
            gridRow: `${cell.row} / span ${cell.rowSpan}`,
          }}>
            {renderCellContent(cell.id)}
          </Box>
        ))}
      </Box>
    );
  };

  return (
    <Box sx={{ position: 'relative', width: '100vw', height: '100vh', bgcolor: '#000' }}>
      {layout.gridSize === 'custom' ? renderCustomGrid() : renderStandardGrid()}

      {/* Верхняя шторка с быстрым управлением */}
      <Box
        sx={{
          position: 'fixed', top: 0, left: 0, right: 0,
          bgcolor: 'rgba(0,0,0,0.85)',
          color: 'white',
          px: 2, py: 1,
          display: 'flex', alignItems: 'center', gap: 2,
          transform: controlsVisible ? 'translateY(0)' : 'translateY(-100%)',
          transition: 'transform 0.25s ease',
          zIndex: 1000,
        }}
      >
        <IconButton size="small" sx={{ color: 'white' }} onClick={() => setDrawerOpen(true)}>
          <MenuIcon />
        </IconButton>

        <Typography variant="subtitle2" sx={{ flexGrow: 0 }}>
          🎥 Киоск
        </Typography>

        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel sx={{ color: 'grey.400' }}>Layout</InputLabel>
          <Select
            value={layout.name}
            label="Layout"
            onChange={(e) => handleSwitchLayout(e.target.value)}
            sx={{
              color: 'white',
              '& .MuiOutlinedInput-notchedOutline': { borderColor: 'grey.600' },
              '& .MuiSvgIcon-root': { color: 'white' },
            }}
          >
            {availableLayouts.map(l => (
              <MenuItem key={l.name} value={l.name}>{l.name}</MenuItem>
            ))}
          </Select>
        </FormControl>

        {activeCellsOverride && (
          <Typography variant="caption" color="warning.main">
            ● изменения не сохранены
          </Typography>
        )}

        <Box sx={{ flexGrow: 1 }} />

        <Tooltip title="Выйти из полноэкранного режима">
          <IconButton size="small" sx={{ color: 'white' }}
            onClick={() => document.exitFullscreen().catch(() => {})}>
            <FullscreenExitIcon />
          </IconButton>
        </Tooltip>

        <Tooltip title="Вернуться на главную">
          <IconButton size="small" sx={{ color: 'white' }} onClick={exitKiosk}>
            <HomeIcon />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Боковая панель с камерами */}
      <Drawer
        anchor="left"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        PaperProps={{ sx: { width: 260, bgcolor: '#1a1a1a', color: 'white' } }}
      >
        <Box sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="subtitle1" fontWeight="bold">📹 Камеры</Typography>
          <IconButton size="small" sx={{ color: 'white' }} onClick={() => setDrawerOpen(false)}>
            <CloseIcon />
          </IconButton>
        </Box>
        <Divider sx={{ borderColor: 'grey.800' }} />
        <Typography variant="caption" sx={{ px: 2, pt: 1, color: 'grey.500', display: 'block' }}>
          Перетащите камеру в ячейку. Двойной клик по ячейке — освободить.
        </Typography>
        <List dense>
          {cameras.map(camera => {
            const isActive = getCameraStatus(camera.name);
            const isUsed = Object.values(effectiveActiveCells).includes(camera.name);
            return (
              <ListItem
                key={camera.name}
                draggable
                onDragStart={(e) => handleDragStart(e, camera.name)}
                sx={{
                  cursor: 'grab',
                  bgcolor: isUsed ? 'rgba(76,175,80,0.15)' : 'transparent',
                  borderLeft: isUsed ? '3px solid #4caf50' : '3px solid transparent',
                  '&:active': { cursor: 'grabbing' },
                  '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' },
                }}
              >
                <ListItemIcon sx={{ minWidth: 32 }}>
                  <DragIndicatorIcon sx={{ color: 'grey.600', fontSize: 16, mr: -0.5 }} />
                  {isActive
                    ? <CheckCircleIcon sx={{ color: 'success.main', fontSize: 18 }} />
                    : <ErrorIcon sx={{ color: 'grey.600', fontSize: 18 }} />}
                </ListItemIcon>
                <ListItemText
                  primary={camera.name}
                  primaryTypographyProps={{ fontSize: '0.85rem' }}
                />
              </ListItem>
            );
          })}
          {cameras.length === 0 && (
            <Box sx={{ p: 2 }}>
              <Typography variant="caption" color="grey.500">
                Нет доступных камер
              </Typography>
            </Box>
          )}
        </List>
      </Drawer>
    </Box>
  );
};

export default KioskView;