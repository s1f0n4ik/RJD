import React, { useEffect, useRef } from 'react';
import { Box, ButtonGroup, Button, Typography } from '@mui/material';
import { RZD_COLORS } from '../theme';

interface RecordingsTimelineProps {
  camera: string;
  date: Date;
  onSeek: (time: number) => void;
}

const RecordingsTimeline: React.FC<RecordingsTimelineProps> = ({ camera, date, onSeek }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = React.useState(24); // hours

  useEffect(() => {
    drawTimeline();
  }, [camera, date, zoom]);

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
    ctx.font = '10px Arial';

    for (let i = 0; i <= zoom; i++) {
      const x = (i / zoom) * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      ctx.fillText(`${i}:00`, x + 5, 15);
    }

    ctx.fillStyle = RZD_COLORS.primary;
    ctx.fillRect(width * 0.2, height * 0.3, width * 0.3, height * 0.4);

    ctx.fillStyle = '#FFD700';
    ctx.fillRect(width * 0.6, height * 0.3, width * 0.2, height * 0.4);
  };

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
        <Typography variant="caption" fontWeight="bold">
          ⏱️ Timeline
        </Typography>
        <ButtonGroup size="small">
          {[1, 2, 6, 12, 24].map(h => (
            <Button
              key={h}
              onClick={() => setZoom(h)}
              variant={zoom === h ? 'contained' : 'outlined'}
            >
              {h}h
            </Button>
          ))}
        </ButtonGroup>
      </Box>
      <canvas
        ref={canvasRef}
        width={800}
        height={80}
        style={{ width: '100%', height: '80px', cursor: 'pointer' }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const percent = x / rect.width;
          onSeek(percent * zoom * 3600); // seconds
        }}
      />
    </Box>
  );
};

export default RecordingsTimeline;