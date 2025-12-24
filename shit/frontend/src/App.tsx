import React, { useEffect, useState } from 'react';
import {
  Container,
  Paper,
  Typography,
  Box,
  Chip,
  Card,
  CardContent,
  Grid2 as Grid,
} from '@mui/material';
import {
  Videocam as VideocamIcon,
  Memory as MemoryIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
} from '@mui/icons-material';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws';
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

interface Camera {
  camera_name: string;
  rtsp_url: string;
  status: string;
  width?: number;
  height?: number;
}

interface Loader {
  loader_name: string;
  status: string;
  endpoint: string;
  camera_matrix: string[][];
}

interface SystemState {
  cameras: Camera[];
  loaders: Loader[];
}

const App: React.FC = () => {
  const [wsConnected, setWsConnected] = useState(false);
  const [state, setState] = useState<SystemState>({
    cameras: [],
    loaders: [],
  });

  useEffect(() => {
    console.log('Attempting to connect to', WS_URL);
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('✅ WebSocket connected');
      setWsConnected(true);
    };

    ws.onmessage = (event) => {
      console.log('📩 Received:', event.data);

      try {
        const message = JSON.parse(event.data);

        if (message.type === 'initial_state' || message.type === 'update') {
          setState({
            cameras: message.data.cameras || [],
            loaders: message.data.loaders || [],
          });
        }
      } catch (err) {
        console.error('Failed to parse WS message:', err);
      }
    };

    ws.onerror = (error) => {
      console.error('❌ WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('🔌 WebSocket disconnected');
      setWsConnected(false);
    };

    return () => {
      ws.close();
    };
  }, []);

  const runningCameras = state.cameras.filter((c) => c.status === 'running').length;
  const runningLoaders = state.loaders.filter((l) => l.status === 'running').length;

  return (
    <Box sx={{ bgcolor: '#f5f5f5', minHeight: '100vh', py: 4 }}>
      <Container maxWidth="xl">
        {/* Header */}
        <Paper
          elevation={3}
          sx={{
            p: 3,
            mb: 4,
            background: 'linear-gradient(135deg, #1976d2 0%, #2196f3 100%)',
            color: 'white',
          }}
        >
          <Box display="flex" justifyContent="space-between" alignItems="center">
            <Typography variant="h4" fontWeight="bold">
              🎥 Video Processing System
            </Typography>
            <Chip
              icon={wsConnected ? <CheckCircleIcon /> : <ErrorIcon />}
              label={wsConnected ? 'Connected' : 'Disconnected'}
              color={wsConnected ? 'success' : 'error'}
              sx={{ fontWeight: 'bold' }}
            />
          </Box>
        </Paper>

        {/* Stats */}
        <Grid container spacing={3} sx={{ mb: 4 }}>
          <Grid size={{ xs: 12, md: 6 }}>
            <Card>
              <CardContent>
                <Box display="flex" alignItems="center" gap={2}>
                  <VideocamIcon fontSize="large" color="primary" />
                  <Box>
                    <Typography variant="h6" color="text.secondary">
                      📹 Cameras
                    </Typography>
                    <Typography variant="h3" fontWeight="bold">
                      {runningCameras}/{state.cameras.length}
                    </Typography>
                    <Typography variant="body2" color="success.main">
                      Running
                    </Typography>
                  </Box>
                </Box>
              </CardContent>
            </Card>
          </Grid>

          <Grid size={{ xs: 12, md: 6 }}>
            <Card>
              <CardContent>
                <Box display="flex" alignItems="center" gap={2}>
                  <MemoryIcon fontSize="large" color="secondary" />
                  <Box>
                    <Typography variant="h6" color="text.secondary">
                      🧠 Loaders
                    </Typography>
                    <Typography variant="h3" fontWeight="bold">
                      {runningLoaders}/{state.loaders.length}
                    </Typography>
                    <Typography variant="body2" color="success.main">
                      Running
                    </Typography>
                  </Box>
                </Box>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        {/* Cameras */}
        <Paper sx={{ p: 3, mb: 4 }}>
          <Typography variant="h5" fontWeight="bold" mb={2}>
            Cameras
          </Typography>
          {state.cameras.map((camera) => (
            <Card key={camera.camera_name} sx={{ mb: 2 }}>
              <CardContent>
                <Box display="flex" justifyContent="space-between" alignItems="center">
                  <Box>
                    <Typography variant="h6">{camera.camera_name}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {camera.rtsp_url}
                    </Typography>
                    <Typography variant="caption">
                      Resolution: {camera.width || 'N/A'} × {camera.height || 'N/A'}
                    </Typography>
                  </Box>
                  <Chip
                    label={camera.status}
                    color={camera.status === 'running' ? 'success' : 'default'}
                  />
                </Box>
              </CardContent>
            </Card>
          ))}
        </Paper>

        {/* Loaders with MJPEG Streams */}
        <Paper sx={{ p: 3 }}>
          <Typography variant="h5" fontWeight="bold" mb={2}>
            Neural Loaders
          </Typography>
          {state.loaders.map((loader) => (
            <Card key={loader.loader_name} sx={{ mb: 3 }}>
              <CardContent>
                <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                  <Box>
                    <Typography variant="h6">{loader.loader_name}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Endpoint: {loader.endpoint}
                    </Typography>
                  </Box>
                  <Chip
                    label={loader.status}
                    color={loader.status === 'running' ? 'success' : 'default'}
                  />
                </Box>

                {/* MJPEG Stream */}
                <Box
                  sx={{
                    width: '100%',
                    maxHeight: 600,
                    bgcolor: '#000',
                    borderRadius: 1,
                    overflow: 'hidden',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                  }}
                >
                  <img
                    src={`${API_BASE}${loader.endpoint}`}
                    alt={`${loader.loader_name} stream`}
                    style={{
                      width: '100%',
                      height: 'auto',
                      objectFit: 'contain',
                    }}
                    onError={(e) => {
                      console.error('Failed to load image');
                      e.currentTarget.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
                    }}
                  />
                </Box>
              </CardContent>
            </Card>
          ))}
        </Paper>
      </Container>
    </Box>
  );
};

export default App;