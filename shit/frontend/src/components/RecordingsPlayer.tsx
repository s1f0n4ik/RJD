import React, { useRef, useEffect } from 'react';
import { Box, LinearProgress, Typography } from '@mui/material';
import { FASTAPI_BASE } from '../utils/constants';

interface RecordingsPlayerProps {
  camera: string;
  file: { filename: string; created: string };
  onEnded?: () => void; // Callback при окончании видео
  onTimeUpdate?: (currentTime: number) => void;
}

const RecordingsPlayer: React.FC<RecordingsPlayerProps> = ({
  camera,
  file,
  onEnded,
  onTimeUpdate
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);

  useEffect(() => {
    if (videoRef.current) {
      setLoading(true);
      setError(false);
      videoRef.current.load();
    }
  }, [camera, file.filename]);

  const handleCanPlay = () => {
    setLoading(false);
  };

  const handleError = () => {
    setLoading(false);
    setError(true);
  };

  const handleTimeUpdate = () => {
    if (videoRef.current && onTimeUpdate) {
    const fileDate = new Date(file.created);
    const fileStartSeconds = fileDate.getTime() / 1000; // Local time in seconds
    const currentSeconds = fileStartSeconds + videoRef.current.currentTime;

    onTimeUpdate(currentSeconds);
  }
};

  return (
    <Box sx={{ width: '100%', height: '100%', bgcolor: 'black', position: 'relative' }}>
      {loading && (
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 10,
            textAlign: 'center',
          }}
        >
          <LinearProgress sx={{ width: 200, mb: 2 }} />
          <Typography color="white">Загрузка видео...</Typography>
        </Box>
      )}

      {error && (
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 10,
            textAlign: 'center',
          }}
        >
          <Typography color="error" variant="h6">
            ❌ Ошибка загрузки видео
          </Typography>
          <Typography color="grey.500" variant="body2">
            {file.filename}
          </Typography>
        </Box>
      )}

      <video
        ref={videoRef}
        controls
        autoPlay
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          display: loading ? 'none' : 'block',
        }}
        src={`${FASTAPI_BASE}/api/recordings/stream/${camera}/${file.filename}`}
        onCanPlay={handleCanPlay}
        onError={handleError}
        onEnded={onEnded}
        onTimeUpdate={handleTimeUpdate}
      />

      {/* Current video indicator */}
      <Box
        sx={{
          position: 'absolute',
          bottom: 60,
          left: 10,
          bgcolor: 'rgba(0,0,0,0.7)',
          color: 'white',
          px: 2,
          py: 1,
          borderRadius: 1,
          fontSize: '0.875rem',
        }}
      >
        📹 {camera} • ⏰ {new Date(file.created).toLocaleTimeString('ru-RU')}
      </Box>
    </Box>
  );
};

export default RecordingsPlayer;