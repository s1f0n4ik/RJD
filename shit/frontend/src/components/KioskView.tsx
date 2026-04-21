import React, { useState, useEffect } from 'react';
import { Box, Typography, Button, Alert } from '@mui/material';
import { Fullscreen as FullscreenIcon } from '@mui/icons-material';
import WebRTCPlayer from './WebRTCPlayer';
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

const KioskView: React.FC = () => {
  const [layout, setLayout] = useState<SavedLayout | null>(null);
  const [error, setError] = useState<string>('');
  const [fullscreenActive, setFullscreenActive] = useState(false);
  const [availableLayouts, setAvailableLayouts] = useState<SavedLayout[]>([]);

  // Парсим имя layout'а из URL: /kiosk/ИмяLayout
  const getLayoutNameFromUrl = (): string | null => {
    const path = window.location.pathname;
    const match = path.match(/^\/kiosk\/?(.*)$/);
    if (!match) return null;
    const name = decodeURIComponent(match[1] || '').trim();
    return name || null;
  };

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        setError('Нет сохранённых layout\'ов. Зайдите на /observation и создайте хотя бы один.');
        return;
      }

      const layouts: SavedLayout[] = JSON.parse(stored);
      setAvailableLayouts(layouts);

      const requestedName = getLayoutNameFromUrl();

      if (!requestedName) {
        // /kiosk без имени — возьмём первый доступный
        if (layouts.length === 0) {
          setError('Нет сохранённых layout\'ов.');
          return;
        }
        setLayout(layouts[0]);
        return;
      }

      const found = layouts.find(l => l.name === requestedName);
      if (!found) {
        setError(`Layout "${requestedName}" не найден. Доступные: ${layouts.map(l => l.name).join(', ') || '(нет)'}`);
        return;
      }

      setLayout(found);
    } catch (err) {
      setError('Ошибка чтения layouts из localStorage');
      console.error(err);
    }
  }, []);

  // Отслеживаем выход из fullscreen (Esc)
  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreenActive(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // При размонтировании компонента выходим из fullscreen
  useEffect(() => {
    return () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    };
  }, []);

  const enterFullscreen = async () => {
    try {
      await document.documentElement.requestFullscreen();
      setFullscreenActive(true);
    } catch (err) {
      console.error('Fullscreen failed:', err);
    }
  };

  if (error) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          bgcolor: '#000',
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: 4,
        }}
      >
        <Box sx={{ maxWidth: 600, width: '100%' }}>
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
          {availableLayouts.length > 0 && (
            <Box>
              <Typography variant="h6" sx={{ mb: 2 }}>
                Доступные layouts:
              </Typography>
              {availableLayouts.map(l => (
                <Button
                  key={l.name}
                  fullWidth
                  variant="outlined"
                  sx={{ mb: 1, color: 'white', borderColor: 'white' }}
                  onClick={() => {
                    window.location.href = `/kiosk/${encodeURIComponent(l.name)}`;
                  }}
                >
                  {l.name}
                </Button>
              ))}
            </Box>
          )}
          <Button
            fullWidth
            variant="contained"
            sx={{ mt: 2 }}
            onClick={() => (window.location.href = '/')}
          >
            Вернуться в основной интерфейс
          </Button>
        </Box>
      </Box>
    );
  }

  if (!layout) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          bgcolor: '#000',
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Typography>Загрузка...</Typography>
      </Box>
    );
  }

  // Экран запуска fullscreen (показывается один раз)
  if (!fullscreenActive) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          bgcolor: '#000',
          color: 'white',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          p: 4,
        }}
      >
        <Typography variant="h3" sx={{ mb: 2 }}>
          🎥 Киоск-режим
        </Typography>
        <Typography variant="h5" color="grey.400" sx={{ mb: 4 }}>
          Layout: <strong>{layout.name}</strong>
        </Typography>
        <Button
          variant="contained"
          size="large"
          startIcon={<FullscreenIcon />}
          onClick={enterFullscreen}
          sx={{ fontSize: '1.2rem', px: 4, py: 2 }}
        >
          Запустить полноэкранный режим
        </Button>
        <Typography variant="caption" color="grey.500" sx={{ mt: 3 }}>
          Esc — выход из полноэкранного режима
        </Typography>
      </Box>
    );
  }

  // Рендер сетки
  const renderStandardGrid = () => {
    const gridSize = layout.gridSize as number;
    const cols = Math.sqrt(gridSize);
    return (
      <Box
        sx={{
          width: '100vw',
          height: '100vh',
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: 0.5,
          bgcolor: '#000',
          p: 0.5,
          boxSizing: 'border-box',
        }}
      >
        {Array.from({ length: gridSize }).map((_, index) => {
          const cameraName = layout.activeCells[index];
          return (
            <Box
              key={index}
              sx={{
                bgcolor: '#000',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                border: '1px solid #222',
              }}
            >
              {cameraName ? (
                <WebRTCPlayer
                  key={`kiosk-${index}-${cameraName}`}
                  cameraId={cameraName}
                  signalingUrl={`${SIGNALING_SERVER}/client/${cameraName}`}
                  onError={(err) => console.error(`Kiosk error ${cameraName}:`, err)}
                />
              ) : (
                <Typography color="grey.700" variant="caption">
                  Пусто
                </Typography>
              )}
            </Box>
          );
        })}
      </Box>
    );
  };

  const renderCustomGrid = () => {
    const rows = layout.customGridRows || 3;
    const cols = layout.customGridCols || 3;
    return (
      <Box
        sx={{
          width: '100vw',
          height: '100vh',
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          gap: 0.5,
          bgcolor: '#000',
          p: 0.5,
          boxSizing: 'border-box',
        }}
      >
        {(layout.customCells || []).map(cell => {
          const cameraName = layout.activeCells[cell.id];
          return (
            <Box
              key={cell.id}
              sx={{
                gridColumn: `${cell.col} / span ${cell.colSpan}`,
                gridRow: `${cell.row} / span ${cell.rowSpan}`,
                bgcolor: '#000',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                border: '1px solid #222',
              }}
            >
              {cameraName ? (
                <WebRTCPlayer
                  key={`kiosk-${cell.id}-${cameraName}`}
                  cameraId={cameraName}
                  signalingUrl={`${SIGNALING_SERVER}/client/${cameraName}`}
                  onError={(err) => console.error(`Kiosk error ${cameraName}:`, err)}
                />
              ) : (
                <Typography color="grey.700" variant="caption">
                  Пусто
                </Typography>
              )}
            </Box>
          );
        })}
      </Box>
    );
  };

  return layout.gridSize === 'custom' ? renderCustomGrid() : renderStandardGrid();
};

export default KioskView;