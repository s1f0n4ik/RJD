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
  currentTime?: number;
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
  const [zoom, setZoom] = useState(24);
  const [hoveredFile, setHoveredFile] = useState<Recording | null>(null);

  useEffect(() => {
    drawTimeline();
  }, [camera, date, zoom, files, currentTime]);

  const getLocalTimeInMinutes = (file: Recording): number => {
    const fileDate = new Date(file.created);
    // Используем локальное время (не UTC!)
    return fileDate.getHours() * 60 + fileDate.getMinutes();
  };

  const drawTimeline = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const dpr = window.devicePixelRatio || 1;

    // Adjust for high DPI
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0, 0, width, height);

    const topMargin = 25;
    const segmentHeight = height - topMargin - 5;

    // Draw hour grid
    ctx.strokeStyle = '#444';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px Arial';
    ctx.textAlign = 'center';

    for (let i = 0; i <= zoom; i++) {
      const x = (i / zoom) * width;

      // Major grid lines every 3 hours
      if (i % 3 === 0) {
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 2;
      } else {
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1;
      }

      ctx.beginPath();
      ctx.moveTo(x, topMargin);
      ctx.lineTo(x, height);
      ctx.stroke();

      // Time labels with background
      if (zoom <= 12 || i % 2 === 0) {
        const timeLabel = `${String(i).padStart(2, '0')}:00`;
        const textWidth = ctx.measureText(timeLabel).width;

        // Background for text
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(x - textWidth / 2 - 4, 2, textWidth + 8, 18);

        // Text
        ctx.fillStyle = '#ffffff';
        ctx.fillText(timeLabel, x, 15);
      }
    }

    // Draw recording segments (BLUE BLOCKS)
    if (files.length > 0) {
      console.log(`Drawing ${files.length} segments`);

      files.forEach((file, index) => {
        const totalMinutes = getLocalTimeInMinutes(file);
        const startX = (totalMinutes / (zoom * 60)) * width;

        // Segment width (10 min default)
        const segmentDurationMin = 10;
        const segmentWidth = Math.max((segmentDurationMin / (zoom * 60)) * width, 2);

        // Different colors for different states
        let color = '#2196F3'; // Blue for recordings

        if (hoveredFile?.filename === file.filename) {
          color = '#FFD700'; // Gold when hovered
        }

        // Draw segment
        ctx.fillStyle = color;
        ctx.fillRect(startX, topMargin, segmentWidth, segmentHeight);

        // Border
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.strokeRect(startX, topMargin, segmentWidth, segmentHeight);

        // Debug log
        if (index === 0) {
          console.log(`First segment: time=${new Date(file.created).toLocaleTimeString()}, x=${startX}, width=${segmentWidth}`);
        }
      });

      // Draw current playback position (RED LINE - THIN!)
      if (currentTime !== undefined && currentTime > 0) {
        const fileDate = new Date(currentTime * 1000);
        const currentMinutes = fileDate.getHours() * 60 + fileDate.getMinutes();
        const currentX = (currentMinutes / (zoom * 60)) * width;

        // Thin red line
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(currentX, topMargin - 5);
        ctx.lineTo(currentX, height);
        ctx.stroke();

        // Small red circle on top
        ctx.fillStyle = '#FF0000';
        ctx.beginPath();
        ctx.arc(currentX, topMargin - 5, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // No recordings message
      ctx.fillStyle = '#888';
      ctx.font = 'bold 16px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('Нет записей для выбранной даты', width / 2, height / 2);
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (files.length === 0) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = x / rect.width;
    const clickedMinutes = percent * zoom * 60;

    console.log(`Clicked at ${clickedMinutes} minutes (${Math.floor(clickedMinutes/60)}:${Math.floor(clickedMinutes%60)})`);

    // Find closest file
    let closestFile: Recording | null = null;
    let minDiff = Infinity;

    files.forEach(file => {
      const fileMinutes = getLocalTimeInMinutes(file);
      const diff = Math.abs(fileMinutes - clickedMinutes);

      console.log(`File ${file.filename}: ${fileMinutes} min, diff=${diff}`);

      if (diff < minDiff) {
        minDiff = diff;
        closestFile = file;
      }
    });

    if (closestFile) {
      // console.log(`Playing file: ${closestFile.filename}`);
      onSeek(closestFile);
    }
  };

  const handleCanvasHover = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = x / rect.width;
    const hoveredMinutes = percent * zoom * 60;

    let foundFile: Recording | null = null;

    files.forEach(file => {
      const fileMinutes = getLocalTimeInMinutes(file);
      const segmentDuration = 10;

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
              <Typography variant="body2" fontWeight="bold">
                ⏰ {new Date(hoveredFile.created).toLocaleTimeString('ru-RU')}
              </Typography>
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
          width={1200}
          height={100}
          style={{
            width: '100%',
            height: '100px',
            cursor: 'pointer',
            borderRadius: '4px',
            border: '2px solid #444',
          }}
          onClick={handleCanvasClick}
          onMouseMove={handleCanvasHover}
          onMouseLeave={() => setHoveredFile(null)}
        />
      </Tooltip>

      <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
        💡 <strong style={{ color: '#2196F3' }}>Синие блоки</strong> = записи •
        <strong style={{ color: '#FF0000' }}> Красная линия</strong> = текущее время воспроизведения
      </Typography>
    </Box>
  );
};

export default RecordingsTimeline;