import React, { useEffect, useRef, useState } from 'react';
import { Box, ButtonGroup, Button, Typography, Chip } from '@mui/material';
import { RZD_COLORS } from '../theme';

interface Recording {
  filename: string;
  created: string;
}

interface RecordingsTimelineProps {
  camera: string;
  date: Date;
  files: Recording[];
  currentTime?: number;
  onSeek: (file: Recording) => void;
  selectionMode?: boolean;
  selectedRange?: { start: number; end: number } | null;
  onRangeSelected?: (range: { start: number; end: number }) => void;
}

const parseUTC = (utcString: string): Date => {
  return new Date(utcString);
};

const getMinutesFromDayStart = (date: Date): number => {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
};

const formatTime = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const RecordingsTimeline: React.FC<RecordingsTimelineProps> = ({
  camera,
  date,
  files,
  currentTime,
  onSeek,
  selectionMode = false,
  selectedRange,
  onRangeSelected
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(24);
  const [hoveredTime, setHoveredTime] = useState<string | null>(null);
  const [mouseX, setMouseX] = useState(0);
  const [tempStart, setTempStart] = useState<number | null>(null);

  useEffect(() => {
    drawTimeline();
  }, [camera, date, zoom, files, currentTime, selectionMode, selectedRange, tempStart]);

  const drawTimeline = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    canvas.width = width * window.devicePixelRatio;
    canvas.height = height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    // Background
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0, 0, width, height);

    const topMargin = 30;
    const segmentHeight = height - topMargin - 10;

    // Draw hour grid
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let h = 0; h <= zoom; h++) {
      const x = (h / zoom) * width;

      ctx.strokeStyle = h % 6 === 0 ? '#666' : '#444';
      ctx.lineWidth = h % 6 === 0 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, topMargin);
      ctx.lineTo(x, height);
      ctx.stroke();

      if (zoom <= 12 || h % 2 === 0) {
        const label = `${String(h).padStart(2, '0')}:00`;
        const metrics = ctx.measureText(label);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(x - metrics.width / 2 - 4, 5, metrics.width + 8, 18);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x, 8);
      }
    }

    // Draw recording ranges (BLUE)
    if (files.length > 0) {
      const sortedFiles = [...files].sort((a, b) =>
        new Date(a.created).getTime() - new Date(b.created).getTime()
      );

      const ranges: { start: number; end: number }[] = [];
      let currentRange: { start: number; end: number } | null = null;

      sortedFiles.forEach(file => {
        const fileTime = parseUTC(file.created);
        const minutes = getMinutesFromDayStart(fileTime);
        const segmentDuration = 10;

        if (!currentRange) {
          currentRange = { start: minutes, end: minutes + segmentDuration };
        } else {
          if (minutes - currentRange.end < 2) {
            currentRange.end = minutes + segmentDuration;
          } else {
            ranges.push(currentRange);
            currentRange = { start: minutes, end: minutes + segmentDuration };
          }
        }
      });

      if (currentRange) {
        ranges.push(currentRange);
      }

      // Draw blue ranges
      ranges.forEach(range => {
        const startX = (range.start / (zoom * 60)) * width;
        const endX = (range.end / (zoom * 60)) * width;
        const rangeWidth = Math.max(endX - startX, 3);

        ctx.fillStyle = '#2196F3';
        ctx.fillRect(startX, topMargin, rangeWidth, segmentHeight);
        ctx.strokeStyle = '#64B5F6';
        ctx.lineWidth = 1;
        ctx.strokeRect(startX, topMargin, rangeWidth, segmentHeight);
      });

      // Draw SELECTED RANGE (GREEN overlay)
      if (selectedRange) {
        const startX = (selectedRange.start / (zoom * 60)) * width;
        const endX = (selectedRange.end / (zoom * 60)) * width;
        const rangeWidth = Math.max(endX - startX, 3);

        // Semi-transparent green fill
        ctx.fillStyle = 'rgba(76, 175, 80, 0.4)';
        ctx.fillRect(startX, topMargin, rangeWidth, segmentHeight);

        // Green borders
        ctx.strokeStyle = '#4CAF50';
        ctx.lineWidth = 3;
        ctx.strokeRect(startX, topMargin, rangeWidth, segmentHeight);

        // Start marker
        ctx.fillStyle = '#4CAF50';
        ctx.fillRect(startX - 2, topMargin, 4, segmentHeight);

        // End marker
        ctx.fillRect(endX - 2, topMargin, 4, segmentHeight);

        // Labels
        ctx.fillStyle = '#4CAF50';
        ctx.font = 'bold 11px Arial';
        ctx.fillText(`🟢 ${formatTime(selectedRange.start)}`, startX, topMargin - 15);
        ctx.fillText(`🟢 ${formatTime(selectedRange.end)}`, endX, topMargin - 15);
      }

      // Draw TEMP START marker (while selecting)
      if (tempStart !== null) {
        const startX = (tempStart / (zoom * 60)) * width;

        ctx.strokeStyle = '#FFC107';
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(startX, topMargin);
        ctx.lineTo(startX, height);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#FFC107';
        ctx.font = 'bold 11px Arial';
        ctx.fillText(`⏱️ ${formatTime(tempStart)}`, startX, topMargin - 15);
      }

      // Draw current playback marker (RED)
      if (currentTime && currentTime > 0 && !selectionMode) {
        const currentDate = new Date(currentTime * 1000);
        const currentMinutes = getMinutesFromDayStart(currentDate);
        const markerX = (currentMinutes / (zoom * 60)) * width;

        ctx.strokeStyle = '#F44336';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(markerX, topMargin - 8);
        ctx.lineTo(markerX, height);
        ctx.stroke();

        ctx.fillStyle = '#F44336';
        ctx.beginPath();
        ctx.arc(markerX, topMargin - 8, 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#F44336';
        ctx.font = 'bold 11px Arial';
        ctx.fillText(
          currentDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
          markerX,
          topMargin - 15
        );
      }
    } else {
      ctx.fillStyle = '#888';
      ctx.font = 'bold 14px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('Нет записей для выбранной даты', width / 2, height / 2);
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (files.length === 0) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clickedMinutes = (x / rect.width) * zoom * 60;

    if (selectionMode) {
      // RANGE SELECTION MODE
      if (tempStart === null) {
        // First click = start
        setTempStart(clickedMinutes);
        console.log(`🟢 Range start: ${formatTime(clickedMinutes)}`);
      } else {
        // Second click = end
        const start = Math.min(tempStart, clickedMinutes);
        const end = Math.max(tempStart, clickedMinutes);

        if (onRangeSelected) {
          onRangeSelected({ start, end });
        }

        setTempStart(null);
        console.log(`🟢 Range selected: ${formatTime(start)} - ${formatTime(end)}`);
      }
    } else {
      // NORMAL SEEK MODE
      let closestFile: Recording | null = null;
      let minDiff = Infinity;

      files.forEach(file => {
        const fileDate = parseUTC(file.created);
        const fileMinutes = getMinutesFromDayStart(fileDate);
        const diff = Math.abs(fileMinutes - clickedMinutes);

        if (diff < minDiff) {
          minDiff = diff;
          closestFile = file;
        }
      });

      if (closestFile) {
        console.log(`▶️ Playing: ${closestFile.filename}`);
        onSeek(closestFile);
      }
    }
  };

  const handleCanvasHover = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const minutes = (x / rect.width) * zoom * 60;

    setHoveredTime(formatTime(minutes));
    setMouseX(e.clientX);
  };

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={1} flexWrap="wrap" gap={1}>
        <Typography variant="subtitle2" fontWeight="bold">
          📊 Временная шкала {files.length > 0 && `(${files.length} сегментов)`}
        </Typography>

        {selectionMode && (
          <Chip
            label={tempStart !== null ? "Выберите конец диапазона" : "Выберите начало диапазона"}
            color={tempStart !== null ? "warning" : "success"}
            size="small"
          />
        )}

        <ButtonGroup size="small">
          {[1, 2, 6, 12, 24].map(h => (
            <Button
              key={h}
              onClick={() => setZoom(h)}
              variant={zoom === h ? 'contained' : 'outlined'}
            >
              {h}ч
            </Button>
          ))}
        </ButtonGroup>
      </Box>

      <Box position="relative">
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            height: '100px',
            cursor: selectionMode ? 'crosshair' : 'pointer',
            borderRadius: '4px',
            border: selectionMode ? '2px solid #4CAF50' : '2px solid #444',
            display: 'block',
          }}
          onClick={handleCanvasClick}
          onMouseMove={handleCanvasHover}
          onMouseLeave={() => setHoveredTime(null)}
        />

        {hoveredTime && (
          <Box
            sx={{
              position: 'fixed',
              left: mouseX + 10,
              top: 'auto',
              bgcolor: 'rgba(0, 0, 0, 0.9)',
              color: 'white',
              px: 1.5,
              py: 0.5,
              borderRadius: 1,
              fontSize: '13px',
              fontWeight: 'bold',
              pointerEvents: 'none',
              zIndex: 9999,
            }}
          >
            ⏰ {hoveredTime}
          </Box>
        )}
      </Box>

      <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
        💡 <strong style={{ color: '#2196F3' }}>Синие блоки</strong> = записи •
        {!selectionMode && <><strong style={{ color: '#F44336' }}> Красная линия</strong> = воспроизведение • </>}
        {selectionMode && <><strong style={{ color: '#4CAF50' }}> Зеленая область</strong> = выбранный диапазон • </>}
        Кликайте для {selectionMode ? 'выбора' : 'перехода'}
      </Typography>
    </Box>
  );
};

export default RecordingsTimeline;