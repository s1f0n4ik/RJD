import React, { useEffect, useState } from 'react';
import {
  Container,
  Paper,
  Typography,
  Box,
  Chip,
  Card,
  CardContent,
  Grid,
} from '@mui/material';
import {
  Videocam as VideocamIcon,
  Memory as MemoryIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
} from '@mui/icons-material';

// Получаем URL из переменных окружения
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://192.168.1.2:8000/ws';
const API_BASE = import.meta.env.VITE_API_URL || 'http://192.168.1.2:8000';

// Debug: выводим в консоль что используем
console.log('🔧 Config:', { WS_URL, API_BASE });

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
    console.log('🔌 Connecting to WebSocket:', WS_URL);
    
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('✅ WebSocket CONNECTED to', WS_URL);
      setWsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('📩 Received:', data.type, data);
        
        if (data.type === 'initial_state' || data.type === 'state_update') {
          setState(data.data);
        }
      } catch (err) {
        console.error('❌ Failed to parse message:', err);
      }
    };

    ws.onclose = (event) => {
      console.log('🔌 WebSocket CLOSED:', event.code, event.reason);
      setWsConnected(false);
    };

    ws.onerror = (error) => {
      console.error('❌ WebSocket ERROR:', error);
      console.error('Was trying to connect to:', WS_URL);
    };

    return () => {
      console.log('🧹 Cleaning up WebSocket connection');
      ws.close();
    };
  }, []);

  const runningCameras = state.cameras.filter(c => c.status === 'running').length;
  const runningLoaders = state.loaders.filter(l => l.status === 'running').length;

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: '#f5f5f5', py: 4 }}>
      <Container maxWidth="lg">
        {/* Header */}
        <Paper sx={{ p: 3, mb: 3, bgcolor: '#1976d2', color: 'white' }}>
          <Box display="flex" alignItems="center" justifyContent="space-between">
            <Box display="flex" alignItems="center" gap={2}>
              <VideocamIcon fontSize="large" />
              <Typography variant="h4" component="h1">
                Video Processing System
              </Typography>
            </Box>
            <Chip
              icon={wsConnected ? <CheckCircleIcon /> : <ErrorIcon />}
              label={wsConnected ? 'Connected' : 'Disconnected'}
              color={wsConnected ? 'success' : 'error'}
              sx={{ color: 'white' }}
            />
          </Box>
          <Typography variant="caption" sx={{ display: 'block', mt: 1, opacity: 0.8 }}>
            WS: {WS_URL} | API: {API_BASE}
          </Typography>
        </Paper>

        {/* Status Cards */}
        <Grid container spacing={3} sx={{ mb: 3 }}>
          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Box display="flex" alignItems="center" gap={2} mb={2}>
                  <VideocamIcon color="primary" fontSize="large" />
                  <Typography variant="h6">Cameras</Typography>
                </Box>
                <Typography variant="h3" color="primary">
                  {runningCameras}/{state.cameras.length}
                </Typography>
                <Typography color="text.secondary">Running</Typography>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Box display="flex" alignItems="center" gap={2} mb={2}>
                  <MemoryIcon color="secondary" fontSize="large" />
                  <Typography variant="h6">Loaders</Typography>
                </Box>
                <Typography variant="h3" color="secondary">
                  {runningLoaders}/{state.loaders.length}
                </Typography>
                <Typography color="text.secondary">Running</Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        {/* Cameras List */}
        {state.cameras.length > 0 && (
          <>
            <Typography variant="h5" gutterBottom sx={{ mt: 4, mb: 2 }}>
              Cameras
            </Typography>
            <Grid container spacing={2}>
              {state.cameras.map((camera) => (
                <Grid item xs={12} key={camera.camera_name}>
                  <Card>
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
                </Grid>
              ))}
            </Grid>
          </>
        )}

        {/* Loaders List */}
        {state.loaders.length > 0 && (
          <>
            <Typography variant="h5" gutterBottom sx={{ mt: 4, mb: 2 }}>
              Loaders
            </Typography>
            <Grid container spacing={2}>
              {state.loaders.map((loader) => (
                <Grid item xs={12} key={loader.loader_name}>
                  <Card>
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
                      
                      {/* Video Stream */}
                      {loader.status === 'running' && (
                        <Box sx={{ mt: 2, bgcolor: 'black', borderRadius: 1, overflow: 'hidden' }}>
                          <img
                            src={`${API_BASE}${loader.endpoint}`}
                            alt={loader.loader_name}
                            style={{
                              width: '100%',
                              height: 'auto',
                              display: 'block'
                            }}
                            onError={(e) => {
                              console.error(`❌ Failed to load stream: ${API_BASE}${loader.endpoint}`);
                            }}
                          />
                        </Box>
                      )}
                      
                      {/* Camera Matrix */}
                      <Box sx={{ mt: 2 }}>
                        <Typography variant="subtitle2" gutterBottom>
                          Camera Matrix:
                        </Typography>
                        <Box sx={{ fontFamily: 'monospace', fontSize: '0.875rem' }}>
                          {loader.camera_matrix.map((row, i) => (
                            <div key={i}>{row.join(', ')}</div>
                          ))}
                        </Box>
                      </Box>
                    </CardContent>
                  </Card>
                </Grid>
              ))}
            </Grid>
          </>
        )}

        {/* Empty State */}
        {!wsConnected && state.cameras.length === 0 && (
          <Paper sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="h6" color="text.secondary" gutterBottom>
              Connecting to system...
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Please wait while we establish connection
            </Typography>
          </Paper>
        )}
      </Container>
    </Box>
  );
};

export default App;
