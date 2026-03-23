import React, { useRef, useEffect } from 'react';
import { Box } from '@mui/material';
import { FASTAPI_BASE } from '../utils/constants';

interface RecordingsPlayerProps {
  camera: string;
  file: { filename: string };
}

const RecordingsPlayer: React.FC<RecordingsPlayerProps> = ({ camera, file }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.load();
    }
  }, [camera, file]);

  return (
    <Box sx={{ width: '100%', height: '100%', bgcolor: 'black' }}>
      <video
        ref={videoRef}
        controls
        autoPlay
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        src={`${FASTAPI_BASE}/api/recordings/stream/${camera}/${file.filename}`}
      />
    </Box>
  );
};

export default RecordingsPlayer;