import React, { useEffect, useRef, useState } from 'react';
import { Box, ButtonGroup, Button, Typography, Tooltip } from '@mui/material';
import { RZD_COLORS } from '../theme';

interface Recording {
  filename: string;
  created: string;
}

interface RecordingsTimelineProps {
  camera: string;
  date: Date;
  files: Recording[];
  currentTime?: number; // Unix timestamp in seconds
  onSeek: (file: Recording) => void;
}

// Helper: Parse UTC string to local Date
const parseUTC = (utcString: string): Date => {
  return new Date(utcString);
};

// Helper: Get minutes from day start (local time)
const getMinutesFromDayStart = (date: Date): number => {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
};

const RecordingsTimeline: React.FC<RecordingsTimelineProps> = ({
  camera,
  date,
  files,
  currentTime,
  onSeek
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(24);
  const [hoveredTime, setHoveredTime] = useState<string | null>(null);
  const [mouseX, setMouseX] = useState(0);

  useEffect(() => {
    drawTimeline();
  }, [camera, date, zoom, files, currentTime]);

  const drawTimeline = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    // Set canvas size for sharp rendering
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

      // Grid line
      ctx.strokeStyle = h % 6 === 0 ? '#666' : '#444';
      ctx.lineWidth = h % 6 === 0 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, topMargin);
      ctx.lineTo(x, height);
      ctx.stroke();

      // Time label
      if (zoom <= 12 || h % 2 === 0) {
        const label = `${String(h).padStart(2, '0')}:00`;

        // Background
        const metrics = ctx.measureText(label);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(x - metrics.width / 2 - 4, 5, metrics.width + 8, 18);

        // Text
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x, 8);
      }
    }

    // Draw recording ranges (BLUE CONTINUOUS BLOCK)
    if (files.length > 0) {
      // Sort files by time
      const sortedFiles = [...files].sort((a, b) =>
        new Date(a.created).getTime() - new Date(b.created).getTime()
      );

      // Find continuous recording ranges
      const ranges: { start: number; end: number }[] = [];
      let currentRange: { start: number; end: number } | null = null;

      sortedFiles.forEach(file => {
        const fileTime = parseUTC(file.created);
        const minutes = getMinutesFromDayStart(fileTime);
        const segmentDuration = 10; // Each file = 10 minutes

        if (!currentRange) {
          currentRange = { start: minutes, end: minutes + segmentDuration };
        } else {
          // If gap < 2 minutes, extend current range
          if (minutes - currentRange.end < 2) {
            currentRange.end = minutes + segmentDuration;
          } else {
            // Save current range and start new one
            ranges.push(currentRange);
            currentRange = { start: minutes, end: minutes + segmentDuration };
          }
        }
      });

      if (currentRange) {
        ranges.push(currentRange);
      }

      console.log(`📊 Recording ranges:`, ranges);

      // Draw ranges
      ranges.forEach(range => {
        const startX = (range.start / (zoom * 60)) * width;
        const endX = (range.end / (zoom * 60)) * width;
        const rangeWidth = Math.max(endX - startX, 3);

        // Blue fill
        ctx.fillStyle = '#2196F3';
        ctx.fillRect(startX, topMargin, rangeWidth, segmentHeight);

        // Border
        ctx.strokeStyle = '#64B5F6';
        ctx.lineWidth = 1;
        ctx.strokeRect(startX, topMargin, rangeWidth, segmentHeight);
      });

      // Draw current playback marker (RED LINE)
      if (currentTime && currentTime > 0) {
        const currentDate = new Date(currentTime * 1000);
        const currentMinutes = getMinutesFromDayStart(currentDate);
        const markerX = (currentMinutes / (zoom * 60)) * width;

        console.log(`🔴 Red marker: ${currentDate.toLocaleTimeString()} = ${currentMinutes} min = ${markerX}px`);

        // Red line
        ctx.strokeStyle = '#F44336';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(markerX, topMargin - 8);
        ctx.lineTo(markerX, height);
        ctx.stroke();

        // Red circle on top
        ctx.fillStyle = '#F44336';
        ctx.beginPath();
        ctx.arc(markerX, topMargin - 8, 5, 0, Math.PI * 2);
        ctx.fill();

        // Time label
        ctx.fillStyle = '#F44336';
        ctx.font = 'bold 11px Arial';
        ctx.fillText(
          currentDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
          markerX,
          topMargin - 15
        );
      }
    } else {
      // No recordings
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

    console.log(`🖱 Clicked: ${Math.floor(clickedMinutes / 60)}:${Math.floor(clickedMinutes % 60).toString().padStart(2, '0')}`);

    // Find closest file
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
  };

  const handleCanvasHover = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const minutes = (x / rect.width) * zoom * 60;

    const hours = Math.floor(minutes / 60);
    const mins = Math.floor(minutes % 60);

    setHoveredTime(`${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`);
    setMouseX(e.clientX);
  };

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
        <Typography variant="subtitle2" fontWeight="bold">
          📊 Временная шкала {files.length > 0 && `(${files.length} сегментов)`}
        </Typography>
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
            cursor: 'pointer',
            borderRadius: '4px',
            border: '2px solid #444',
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
        💡 <strong style={{ color: '#2196F3' }}>Синие блоки</strong> = непрерывные записи •
        <strong style={{ color: '#F44336' }}> Красная линия</strong> = текущее воспроизведение
      </Typography>
    </Box>
  );
};

export default RecordingsTimeline;