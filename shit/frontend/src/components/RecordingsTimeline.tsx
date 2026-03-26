import React, { useEffect, useRef } from 'react';
import { Box, ButtonGroup, Button, Typography } from '@mui/material';
import { RZD_COLORS } from '../theme';

interface Recording {
  filename: string;
  created: string;
}

interface RecordingsTimelineProps {
  camera: string;
  date: Date;
  files: Recording[];
  onSeek: (time: number) => void;
}

const RecordingsTimeline: React.FC<RecordingsTimelineProps> = ({ camera, date, files, onSeek }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = React.useState(24); // hours

  useEffect(() => {
    drawTimeline();
  }, [camera, date, zoom, files]);

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

    // Draw hour markers
    ctx.strokeStyle = RZD_COLORS.grey[400];
    ctx.fillStyle = RZD_COLORS.grey[300];
    ctx.font = '12px Arial';

    for (let i = 0; i <= zoom; i++) {
      const x = (i / zoom) * width;
      ctx.beginPath();
      ctx.moveTo(x, 20);
      ctx.lineTo(x, height);
      ctx.stroke();

      ctx.fillText(`${String(i).padStart(2, '0')}:00`, x + 5, 15);
    }

    // Draw recording segments
    if (files.length > 0) {
      ctx.fillStyle = RZD_COLORS.primary;

      files.forEach(file => {
        const fileDate = new Date(file.created);
        const hours = fileDate.getHours();
        const minutes = fileDate.getMinutes();
        const totalMinutes = hours * 60 + minutes;

        // Assume 10 min segments (adjust based on your config)
        const startX = (totalMinutes / (zoom * 60)) * width;
        const segmentWidth = (10 / (zoom * 60)) * width;

        ctx.fillRect(startX, height * 0.3, segmentWidth, height * 0.4);
      });
    }

    // No data message
    if (files.length === 0) {
      ctx.fillStyle = RZD_COLORS.grey[500];
      ctx.font = '14px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('Нет записей для выбранной даты', width / 2, height / 2);
    }
  };

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
        <Typography variant="subtitle2" fontWeight="bold">
          📊 Временная шкала
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
      <canvas
        ref={canvasRef}
        width={900}
        height={80}
        style={{ width: '100%', height: '80px', cursor: 'pointer', borderRadius: '4px' }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const percent = x / rect.width;
          onSeek(percent * zoom * 3600); // seconds
        }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
        💡 Подсказка: Кликните на шкале для быстрой перемотки
      </Typography>
    </Box>
  );
};

export default RecordingsTimeline;