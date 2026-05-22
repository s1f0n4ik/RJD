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
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  DragIndicator as DragIndicatorIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import WebRTCPlayer from './WebRTCPlayer';
import { api, type CPPCamera } from '../services/api';
import { SIGNALING_SERVER } from '../utils/constants';
import CellMenu from './CellMenu';
import { useTouchDevice } from '../utils/useTouchDevice';
interface CustomCell {
  id: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

interface SavedLayout {
  name: string;
  gridSize: number | 'custom' | 'single';
  customCells?: CustomCell[];
  customGridRows?: number;
  customGridCols?: number;
  activeCells: Record<number | string, string>;
  timestamp: number;
}

const STORAGE_KEY = 'observation_layouts';
const CONTROLS_HIDE_DELAY = 3000;


const KioskView: React.FC = () => {
  const [layout, setLayout] = useState<SavedLayout | null>(null);
  const [error, setError] = useState<string>('');
  const [fullscreenActive, setFullscreenActive] = useState(false);
  const [availableLayouts, setAvailableLayouts] = useState<SavedLayout[]>([]);
  const [cameras, setCameras] = useState<CPPCamera[]>([]);
  const isTouch = useTouchDevice();
  const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  const [activeCellsOverride, setActiveCellsOverride] = useState<Record<number | string, string> | null>(null);

  // 🆕 Состояние drag-n-drop
  const [draggedCamera, setDraggedCamera] = useState<string | null>(null);
  const [dragOverCellId, setDragOverCellId] = useState<number | string | null>(null);

  const getLayoutNameFromUrl = (): string | null => {
    const match = window.location.pathname.match(/^\/kiosk\/?(.*)$/);
    if (!match) return null;
    const name = decodeURIComponent(match[1] || '').trim();
    return name || null;
  };

    const DEFAULT_LAYOUTS: SavedLayout[] = [
        {
            name: "Панорама сверху",
            gridSize: "single",
            activeCells: {
                single: "linker_360", // фиксированная камера
            },
            timestamp: Date.now(),
        },
    ];

    useEffect(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);

            const savedLayouts: SavedLayout[] = stored
                ? JSON.parse(stored)
                : [];

            // объединяем дефолтные + сохранённые
            const mergedLayouts = [
                ...DEFAULT_LAYOUTS,
                ...savedLayouts,
            ];

            setAvailableLayouts(mergedLayouts);

            const requestedName = getLayoutNameFromUrl();

            const found = requestedName
                ? mergedLayouts.find(l => l.name === requestedName)
                : mergedLayouts[0];

            if (found) {
                setLayout(found);
            } else {
                setError("Layout не найден");
            }

        } catch (err) {
            console.error(err);
            setAvailableLayouts(DEFAULT_LAYOUTS);
            setLayout(DEFAULT_LAYOUTS[0]);
        }

        api.getCameras()
            .then(data => {
                if (Array.isArray(data)) setCameras(data);
            })
            .catch(err => console.error(err));

    }, []);
  useEffect(() => {
    api.getCameras()
      .then(data => {
        if (Array.isArray(data)) setCameras(data);
      })
      .catch(err => console.error('Kiosk: failed to load cameras', err));
  }, []);
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

  const scheduleHide = () => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (!drawerOpen && !draggedCamera) setControlsVisible(false);
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
  }, [drawerOpen, draggedCamera]);

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
    setActiveCellsOverride(null);
    window.history.replaceState(null, '', `/kiosk/${encodeURIComponent(layoutName)}`);
  };

  // === Drag & Drop ===
  const handleDragStart = (e: React.DragEvent, cameraName: string) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', cameraName);
    setDraggedCamera(cameraName);
  };

  const handleDragEnd = () => {
    setDraggedCamera(null);
    setDragOverCellId(null);
  };

  const handleDragOver = (e: React.DragEvent, cellId: number | string) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (dragOverCellId !== cellId) {
      setDragOverCellId(cellId);
    }
  };

  const handleDragLeave = (e: React.DragEvent, cellId: number | string) => {
    // проверяем, что уходим реально из ячейки, а не на её дочерний элемент
    const related = e.relatedTarget as Node | null;
    if (related && (e.currentTarget as Node).contains(related)) return;
    if (dragOverCellId === cellId) {
      setDragOverCellId(null);
    }
  };
  // === Tap-режим (как в Observation) ===
  const placeCameraInCell = (cellId: number | string, cameraName: string) => {
    if (!layout) return;
    const currentCells = activeCellsOverride ?? layout.activeCells;
    const next = { ...currentCells };
    // Если камера уже где-то — убираем её оттуда
    Object.entries(next).forEach(([id, name]) => {
      if (name === cameraName && id !== String(cellId)) {
        delete next[id];
      }
    });
    next[cellId] = cameraName;
    setActiveCellsOverride(next);
  };

  const handleCellTap = (cellId: number | string) => {
    if (!selectedCamera) return; // tap по ячейке без выбранной камеры — игнор
    placeCameraInCell(cellId, selectedCamera);
    // Камеру оставляем выбранной, чтобы можно было продолжать расставлять
  };

  // === Меню ячейки ===
  const handleCellFullscreen = (cellId: number | string) => {
    const videoElement = document
      .getElementById(`kiosk-cell-${cellId}`)
      ?.querySelector('video');
    if (videoElement && videoElement.requestFullscreen) {
      videoElement.requestFullscreen().catch(err =>
        console.error('Fullscreen failed:', err)
      );
    }
  };

  const handleCellRemove = (cellId: number | string) => {
    if (!layout) return;
    const currentCells = activeCellsOverride ?? layout.activeCells;
    if (!currentCells[cellId]) return;
    const next = { ...currentCells };
    delete next[cellId];
    setActiveCellsOverride(next);
  };
  const handleDrop = (e: React.DragEvent, cellId: number | string) => {
    e.preventDefault();
    e.stopPropagation();
    const cameraName = e.dataTransfer.getData('text/plain') || draggedCamera;
    if (!cameraName || !layout) return;

    const currentCells = activeCellsOverride ?? layout.activeCells;
    const next = { ...currentCells };

    Object.entries(next).forEach(([id, name]) => {
      if (name === cameraName && id !== String(cellId)) {
        delete next[id];
      }
    });
    next[cellId] = cameraName;
    setActiveCellsOverride(next);
    setDraggedCamera(null);
    setDragOverCellId(null);
  };

  const handleCellDoubleClick = (cellId: number | string) => {
    if (!layout) return;
    const currentCells = activeCellsOverride ?? layout.activeCells;
    if (!currentCells[cellId]) return;
    const next = { ...currentCells };
    delete next[cellId];
    setActiveCellsOverride(next);
  };

  const getCameraStatus = (cameraId: string): boolean => {
    const camera = cameras.find(c => c.id === cameraId);
    return camera?.streams?.main?.status === 3;
  };
  const getCameraDisplayName = (cameraId: string): string => {
      const c = cameras.find(c => c.id === cameraId);
      return c?.display_name || cameraId;
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

  const effectiveActiveCells = layout.gridSize === 'single' ? { single: 'linker_360' } : activeCellsOverride ?? layout.activeCells;

  const renderCellContent = (cellId: number | string) => {
    const cameraName = layout.gridSize === 'single' ? effectiveActiveCells['single'] : effectiveActiveCells[cellId];
    const isDropTarget = dragOverCellId === cellId;
    const isDragging = !!draggedCamera;
    const canPlaceByTap = !!selectedCamera;

    return (
      <Box
        id={`kiosk-cell-${cellId}`}
        className="video-cell"
        onDragOver={(e) => handleDragOver(e, cellId)}
        onDragEnter={(e) => handleDragOver(e, cellId)}
        onDragLeave={(e) => handleDragLeave(e, cellId)}
        onDrop={(e) => handleDrop(e, cellId)}
        onClick={() => handleCellTap(cellId)}
        onDoubleClick={() => handleCellDoubleClick(cellId)}
        sx={{
          position: 'relative',
          width: '100%', height: '100%',
          bgcolor: '#000',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
          border: isDropTarget
            ? '3px solid #4caf50'
            : canPlaceByTap
            ? '2px dashed rgba(33, 150, 243, 0.6)'
            : isDragging
            ? '2px dashed rgba(76, 175, 80, 0.5)'
            : '1px solid #222',
          cursor: canPlaceByTap ? 'pointer' : 'default',
          transition: 'border-color 0.15s',
          '& video, & > div > video': (isDragging || canPlaceByTap) ? {
            pointerEvents: 'none',
          } : {},
        }}
      >
        {cameraName ? (
          <>
            <WebRTCPlayer
              key={`kiosk-${cellId}-${cameraName}`}
              cameraId={cameraName}
              cameraName={getCameraDisplayName(cameraName)}
              signalingUrl={`${SIGNALING_SERVER}/client/${cameraName}`}
              onError={(err) => console.error(`Kiosk error ${cameraName}:`, err)}
            />

            <CellMenu
              cellId={cellId}
              onFullscreen={handleCellFullscreen}
              onRemove={handleCellRemove}
              alwaysVisible={isTouch}
              variant="light"
            />

            {isDragging && (
              <Box
                onDragOver={(e) => handleDragOver(e, cellId)}
                onDragEnter={(e) => handleDragOver(e, cellId)}
                onDragLeave={(e) => handleDragLeave(e, cellId)}
                onDrop={(e) => handleDrop(e, cellId)}
                sx={{
                  position: 'absolute', inset: 0, zIndex: 5,
                  bgcolor: isDropTarget ? 'rgba(76, 175, 80, 0.25)' : 'rgba(0, 0, 0, 0.15)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'background-color 0.15s',
                }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    color: 'white', bgcolor: 'rgba(0,0,0,0.7)',
                    px: 2, py: 0.5, borderRadius: 1, fontSize: '0.85rem',
                  }}
                >
                  {isDropTarget ? `✓ Заменить на «${getCameraDisplayName(draggedCamera!)}»` : 'Отпустите для замены'}
                </Typography>
              </Box>
            )}

            {/* Overlay для tap-режима */}
            {canPlaceByTap && !isDragging && (
              <Box
                sx={{
                  position: 'absolute', inset: 0, zIndex: 4,
                  bgcolor: 'rgba(33, 150, 243, 0.15)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  pointerEvents: 'none',
                }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    color: 'white', bgcolor: 'rgba(0,0,0,0.7)',
                    px: 2, py: 0.5, borderRadius: 1, fontSize: '0.85rem',
                  }}
                >
                  Тап — заменить на «${getCameraDisplayName(selectedCamera!)}»
                </Typography>
              </Box>
            )}
          </>
        ) : (
          <Box sx={{ textAlign: 'center', pointerEvents: 'none' }}>
            <Typography
              variant="body2"
              sx={{
                color: isDropTarget
                  ? '#4caf50'
                  : canPlaceByTap
                  ? '#2196f3'
                  : 'grey.600',
                fontWeight: (isDropTarget || canPlaceByTap) ? 'bold' : 'normal',
              }}
            >
              {isDropTarget
                ? `✓ Отпустите «${getCameraDisplayName(selectedCamera!)}»`
                : canPlaceByTap
                ? `Тап — поставить «${getCameraDisplayName(selectedCamera!)}»`
                : isDragging
                ? 'Перетащите сюда'
                : 'Пусто'}
            </Typography>
          </Box>
        )}
      </Box>
    );
  };

    const renderSingleView = () => {
        return (
            <Box sx={{
                width: '100vw',
                height: '100vh',
                bgcolor: '#000',
            }}>
                {renderCellContent('single')}
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
          <Box key={index} sx={{ minHeight: 0, minWidth: 0 }}>
            {renderCellContent(index)}
          </Box>
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
            minHeight: 0, minWidth: 0,
          }}>
            {renderCellContent(cell.id)}
          </Box>
        ))}
      </Box>
    );
  };

  return (
    <Box sx={{ position: 'relative', width: '100vw', height: '100vh', bgcolor: '#000' }}>
        {layout.gridSize === 'custom'
            ? renderCustomGrid()
            : layout.gridSize === 'single'
                ? renderSingleView()
                : renderStandardGrid()
        }

      {/* Верхняя шторка */}
      <Box
        sx={{
          position: 'fixed', top: 0, left: 0, right: 0,
          bgcolor: 'rgba(0,0,0,0.85)',
          color: 'white',
          px: 2, py: 1,
          display: 'flex', alignItems: 'center', gap: 2,
          transform: controlsVisible ? 'translateY(0)' : 'translateY(-100%)',
          transition: 'transform 0.25s ease',
          zIndex: 1200,
          // Когда шторка скрыта — не мешаем кликать/дропать под ней
          pointerEvents: controlsVisible ? 'auto' : 'none',
        }}
      >
        <IconButton size="small" sx={{ color: 'white' }} onClick={() => setDrawerOpen(true)}>
          <MenuIcon />
        </IconButton>

        <Typography variant="subtitle2">🎥 Киоск</Typography>
        {selectedCamera && (
          <Box
            sx={{
              bgcolor: 'rgba(33,150,243,0.25)',
              border: '1px solid #2196f3',
              borderRadius: 1,
              px: 1.5,
              py: 0.25,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
            }}
          >
            <Typography variant="caption" sx={{ color: 'white' }}>
              📹 {getCameraDisplayName(selectedCamera)}
            </Typography>
            <IconButton
              size="small"
              onClick={() => setSelectedCamera(null)}
              sx={{ color: 'white', p: 0.25 }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Box>
        )}
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

      {/* 🔑 Боковая панель: variant="persistent" + убран backdrop */}
      <Drawer
          anchor="left"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          variant="persistent"
          ModalProps={{
            keepMounted: true,
            hideBackdrop: true,
            disableEnforceFocus: true,
            disableAutoFocus: true,
            disableRestoreFocus: true,
          }}
          PaperProps={{
            sx: {
              width: 260,
              bgcolor: '#1a1a1a',
              color: 'white',
              zIndex: 1300, // 🔑 выше шторки (1200)
              pt: controlsVisible ? '56px' : 0, // 🔑 отступ сверху, когда шторка видна
              transition: 'padding-top 0.25s ease',
            }
          }}
        >
        <Box sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="subtitle1" fontWeight="bold">📹 Камеры</Typography>
          <IconButton size="small" sx={{ color: 'white' }} onClick={() => setDrawerOpen(false)}>
            <CloseIcon />
          </IconButton>
        </Box>
        <Divider sx={{ borderColor: 'grey.800' }} />
        <Typography variant="caption" sx={{ px: 2, pt: 1, color: 'grey.500', display: 'block' }}>
          {isTouch
            ? 'Тап по камере → тап по ячейке. Двойной тап — освободить.'
            : 'Перетащите камеру в ячейку или: клик по камере → клик по ячейке. Двойной клик по ячейке — освободить.'}
        </Typography>
        <List dense>
          {cameras.map(camera => {
            const isActive = getCameraStatus(camera.id);
            const isUsed = Object.values(effectiveActiveCells).includes(camera.id);
            const isBeingDragged = draggedCamera === camera.id;
            const isSelected = selectedCamera === camera.id;
            return (
              <ListItem
                key={camera.id}
                draggable
                onDragStart={(e) => handleDragStart(e, camera.id)}
                onDragEnd={handleDragEnd}
                onClick={() => {
                  setSelectedCamera(prev => (prev === camera.id ? null : camera.id));
                }}
                sx={{
                  cursor: 'grab',
                  opacity: isBeingDragged ? 0.5 : 1,
                  // bgcolor: isUsed ? 'rgba(76,175,80,0.15)' : 'transparent',
                  // borderLeft: isUsed ? '3px solid #4caf50' : '3px solid transparent',
                  // '&:active': { cursor: 'grabbing' },
                  // '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' },
                  bgcolor: isSelected
                  ? 'rgba(33, 150, 243, 0.35)'             // 🆕 выбранная — синяя
                  : isUsed
                  ? 'rgba(76,175,80,0.15)'
                  : 'transparent',
                borderLeft: isSelected
                  ? '3px solid #2196f3'                    // 🆕
                  : isUsed
                  ? '3px solid #4caf50'
                  : '3px solid transparent',
                '&:active': { cursor: 'grabbing' },
                '&:hover': {
                  bgcolor: isSelected
                    ? 'rgba(33, 150, 243, 0.45)'
                    : 'rgba(255,255,255,0.08)'
                },
                }}
              >
                <ListItemIcon sx={{ minWidth: 32 }}>
                  <DragIndicatorIcon sx={{ color: 'grey.600', fontSize: 16, mr: -0.5 }} />
                  {isActive
                    ? <CheckCircleIcon sx={{ color: 'success.main', fontSize: 18 }} />
                    : <ErrorIcon sx={{ color: 'grey.600', fontSize: 18 }} />}
                </ListItemIcon>
                <ListItemText
                  primary={camera.id}
                  primaryTypographyProps={{
                    fontSize: '0.85rem',
                    fontWeight: isSelected ? 600 : 400, // 🆕
                  }}
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