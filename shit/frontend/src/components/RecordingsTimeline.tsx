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
  currentTime?: number; // Current playback time in seconds from day start
  onSeek: (file: Recording) => void;
}

const RecordingsTimeline: React.FC<RecordingsTimelineProps> = ({
  camera,
  date,
  files,
  currentTime,
  onSeek
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(24); // hours
  const [hoveredFile, setHoveredFile] = useState<Recording | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    drawTimeline();
  }, [camera, date, zoom, files, currentTime]);

  const getFileTimeInMinutes = (file: Recording): number => {
    const fileDate = new Date(file.created);
    return fileDate.getHours() * 60 + fileDate.getMinutes();
  };

  const drawTimeline = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Clear
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, width, height);

    // Draw hour grid
    ctx.strokeStyle = RZD_COLORS.grey[700];
    ctx.fillStyle = RZD_COLORS.grey[400];
    ctx.font = '11px Arial';

    for (let i = 0; i <= zoom; i++) {
      const x = (i / zoom) * width;

      // Vertical line
      ctx.beginPath();
      ctx.moveTo(x, 20);
      ctx.lineTo(x, height);
      ctx.lineWidth = i % 6 === 0 ? 2 : 1;
      ctx.stroke();

      // Time label
      if (zoom <= 12 || i % 2 === 0) {
        ctx.fillText(`${String(i).padStart(2, '0')}:00`, x + 3, 15);
      }
    }

    // Draw recording segments
    if (files.length > 0) {
      files.forEach(file => {
        const totalMinutes = getFileTimeInMinutes(file);
        const startX = (totalMinutes / (zoom * 60)) * width;

        // Segment duration (assume 10 min, adjust based on actual duration)
        const segmentDurationMin = 10; // You can get this from file metadata
        const segmentWidth = Math.max((segmentDurationMin / (zoom * 60)) * width, 3);

        // Draw segment
        ctx.fillStyle = RZD_COLORS.primary;
        ctx.fillRect(startX, 25, segmentWidth, height - 30);

        // Draw border for hovered segment
        if (hoveredFile?.filename === file.filename) {
          ctx.strokeStyle = '#FFD700';
          ctx.lineWidth = 3;
          ctx.strokeRect(startX, 25, segmentWidth, height - 30);
        }
      });

      // Draw current playback position
      if (currentTime !== undefined && currentTime > 0) {
        const currentMinutes = (currentTime / 60) % (24 * 60);
        const currentX = (currentMinutes / (zoom * 60)) * width;

        ctx.strokeStyle = '#FF3333';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(currentX, 20);
        ctx.lineTo(currentX, height);
        ctx.stroke();

        // Red circle on top
        ctx.fillStyle = '#FF3333';
        ctx.beginPath();
        ctx.arc(currentX, 20, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // No data message
      ctx.fillStyle = RZD_COLORS.grey[500];
      ctx.font = '14px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('Нет записей для выбранной даты', width / 2, height / 2);
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clickedMinutes = (x / rect.width) * zoom * 60;

    // Find closest file
    let closestFile: Recording | null = null;
    let minDiff = Infinity;

    files.forEach(file => {
      const fileMinutes = getFileTimeInMinutes(file);
      const diff = Math.abs(fileMinutes - clickedMinutes);

      if (diff < minDiff) {
        minDiff = diff;
        closestFile = file;
      }
    });

    if (closestFile) {
      onSeek(closestFile);
    }
  };

  const handleCanvasHover = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const hoveredMinutes = (x / rect.width) * zoom * 60;

    setMousePos({ x: e.clientX, y: e.clientY });

    // Find hovered file
    let foundFile: Recording | null = null;

    files.forEach(file => {
      const fileMinutes = getFileTimeInMinutes(file);
      const segmentDuration = 10; // minutes

      if (hoveredMinutes >= fileMinutes && hoveredMinutes <= fileMinutes + segmentDuration) {
        foundFile = file;
      }
    });

    setHoveredFile(foundFile);
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
              size="small"
            >
              {h}ч
            </Button>
          ))}
        </ButtonGroup>
      </Box>

      <Tooltip
        open={!!hoveredFile}
        title={
          hoveredFile ? (
            <Box>
              <Typography variant="caption">
                ⏰ {new Date(hoveredFile.created).toLocaleTimeString('ru-RU')}
              </Typography>
              <br />
              <Typography variant="caption">
                📁 {hoveredFile.filename}
              </Typography>
            </Box>
          ) : ''
        }
        placement="top"
        followCursor
      >
        <canvas
          ref={canvasRef}
          width={1000}
          height={80}
          style={{
            width: '100%',
            height: '80px',
            cursor: 'pointer',
            borderRadius: '4px',
            border: `1px solid ${RZD_COLORS.grey[700]}`,
          }}
          onClick={handleCanvasClick}
          onMouseMove={handleCanvasHover}
          onMouseLeave={() => setHoveredFile(null)}
        />
      </Tooltip>

      <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
        💡 Кликните на синий сегмент для перехода к записи • Красная линия = текущее время
      </Typography>
    </Box>
  );
};

export default RecordingsTimeline;