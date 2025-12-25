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

const WS_URL = 'ws://192.168.1.2:8000/ws';
const FASTAPI_BASE = 'http://192.168.1.2:8000';
const FLASK_BASE = 'http://192.168.1.2:5000';  // ✅ Flask на порту 5000!

interface Camera {
  camera_name: string;
  rtsp_url: string;
  status: string;
  width?: number | null;
  height?: number | null;
}

interface Loader {
  loader_name: string;
  status: string;
  server_endpoint: string;
  loader_matrix?: string[][];
  img_size?: number;
  weights_path?: string;
}

interface SystemState {
  cameras: Camera[];
  loaders: Loader[];
  summary?: {
    cameras_total: number;
    cameras_running: number;
    loaders_total: number;
    loaders_running: number;
  };
}

// Маппинг endpoint ID → Flask URL
const ENDPOINT_MAP: Record<string, string> = {
  'id_1': '/neural_1',
  'id_2': '/neural_2',
  'id_3': '/neural_3',
};

const App: React.FC = () => {
  const [wsConnected, setWsConnected] = useState(false);
  const [state, setState] = useState<SystemState>({
    cameras: [],
    loaders: [],
  });

  useEffect(() => {
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('✅ WebSocket Connected');
      setWsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'initial_state' || data.type === 'state_update') {
          console.log('📦 State updated');
          setState(data.data);
        }
      } catch (err) {
        console.error('❌ Parse error:', err);
      }
    };

    ws.onclose = () => {
      console.log('🔌 WebSocket Disconnected');
      setWsConnected(false);
    };

    return () => ws.close();
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
              <Typography variant="h4">
                🚂 RJD Video Processing System
              </Typography>
            </Box>
            <Chip
              icon={wsConnected ? <CheckCircleIcon /> : <ErrorIcon />}
              label={wsConnected ? 'Connected' : 'Disconnected'}
              color={wsConnected ? 'success' : 'error'}
              sx={{ color: 'white', fontSize: '1rem', px: 1 }}
            />
          </Box>
        </Paper>

        {/* Summary Cards */}
        <Grid container spacing={3} sx={{ mb: 4 }}>
          <Grid item xs={12} md={6}>
            <Card sx={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={2} mb={1}>
                  <VideocamIcon sx={{ color: 'white', fontSize: 40 }} />
                  <Typography variant="h6" sx={{ color: 'white' }}>
                    Cameras
                  </Typography>
                </Box>
                <Typography variant="h2" sx={{ color: 'white', fontWeight: 'bold' }}>
                  {runningCameras}/{state.cameras.length}
                </Typography>
                <Typography sx={{ color: 'rgba(255,255,255,0.8)' }}>
                  Running
                </Typography>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card sx={{ background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' }}>
              <CardContent>
                <Box display="flex" alignItems="center" gap={2} mb={1}>
                  <MemoryIcon sx={{ color: 'white', fontSize: 40 }} />
                  <Typography variant="h6" sx={{ color: 'white' }}>
                    Neural Loaders
                  </Typography>
                </Box>
                <Typography variant="h2" sx={{ color: 'white', fontWeight: 'bold' }}>
                  {runningLoaders}/{state.loaders.length}
                </Typography>
                <Typography sx={{ color: 'rgba(255,255,255,0.8)' }}>
                  Running
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        {/* Cameras */}
        {state.cameras.length > 0 && (
          <Box sx={{ mb: 4 }}>
            <Typography variant="h5" gutterBottom sx={{ mb: 2, fontWeight: 'bold' }}>
              📹 Cameras
            </Typography>
            <Grid container spacing={2}>
              {state.cameras.map((camera) => (
                <Grid item xs={12} md={6} key={camera.camera_name}>
                  <Card>
                    <CardContent>
                      <Box display="flex" justifyContent="space-between" alignItems="start">
                        <Box>
                          <Typography variant="h6" gutterBottom>
                            {camera.camera_name}
                          </Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ mb: 1, fontSize: '0.75rem' }}>
                            {camera.rtsp_url}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            Resolution: {camera.width || 'auto'} × {camera.height || 'auto'}
                          </Typography>
                        </Box>
                        <Chip
                          label={camera.status}
                          color={camera.status === 'running' ? 'success' : 'warning'}
                          size="small"
                        />
                      </Box>
                    </CardContent>
                  </Card>
                </Grid>
              ))}
            </Grid>
          </Box>
        )}

        {/* Neural Loaders with Video Streams */}
        {state.loaders.length > 0 && (
          <Box>
            <Typography variant="h5" gutterBottom sx={{ mb: 2, fontWeight: 'bold' }}>
              🧠 Neural Processing
            </Typography>
            <Grid container spacing={3}>
              {state.loaders.map((loader) => {
                // ✅ ПРАВИЛЬНЫЙ МАППИНГ!
                const flaskPath = ENDPOINT_MAP[loader.server_endpoint] || '/neural_1';
                const streamUrl = `${FLASK_BASE}${flaskPath}`;
                
                console.log(`🎥 Stream URL for ${loader.loader_name}:`, streamUrl);
                
                return (
                  <Grid item xs={12} key={loader.loader_name}>
                    <Card>
                      <CardContent>
                        
                        {/* Header */}
                        <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                          <Box>
                            <Typography variant="h6">{loader.loader_name}</Typography>
                            <Typography variant="body2" color="text.secondary">
                              Endpoint: {loader.server_endpoint} → {flaskPath}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              Model size: {loader.img_size}px | Stream: {streamUrl}
                            </Typography>
                          </Box>
                          <Chip
                            label={loader.status}
                            color={loader.status === 'running' ? 'success' : 'default'}
                          />
                        </Box>
                        
                        {/* Video Stream */}
                        {loader.status === 'running' && (
                          <Box 
                            sx={{ 
                              mt: 2, 
                              bgcolor: 'black', 
                              borderRadius: 2, 
                              overflow: 'hidden',
                              border: '2px solid #1976d2'
                            }}
                          >
                            <img
                              src={streamUrl}
                              alt={`${loader.loader_name} stream`}
                              style={{
                                width: '100%',
                                height: 'auto',
                                display: 'block'
                              }}
                              onLoad={() => {
                                console.log('✅ Stream loaded:', streamUrl);
                              }}
                              onError={(e) => {
                                console.error('❌ Stream failed:', streamUrl);
                              }}
                            />
                          </Box>
                        )}
                        
                        {/* Camera Matrix */}
                        {loader.loader_matrix && loader.loader_matrix.length > 0 && (
                          <Box sx={{ mt: 2 }}>
                            <Typography variant="subtitle2" gutterBottom>
                              📊 Camera Matrix:
                            </Typography>
                            <Box 
                              sx={{ 
                                fontFamily: 'monospace', 
                                fontSize: '0.875rem', 
                                bgcolor: '#f5f5f5', 
                                p: 2, 
                                borderRadius: 1,
                                border: '1px solid #e0e0e0'
                              }}
                            >
                              {loader.loader_matrix.map((row, i) => (
                                <div key={i}>
                                  [{row.map(cam => `"${cam}"`).join(', ')}]
                                </div>
                              ))}
                            </Box>
                          </Box>
                        )}
                      </CardContent>
                    </Card>
                  </Grid>
                );
              })}
            </Grid>
          </Box>
        )}

        {/* Empty State */}
        {!wsConnected && state.cameras.length === 0 && state.loaders.length === 0 && (
          <Paper sx={{ p: 6, textAlign: 'center' }}>
            <Typography variant="h5" color="text.secondary" gutterBottom>
              🔌 Connecting to system...
            </Typography>
            <Typography variant="body1" color="text.secondary">
              Please wait while we establish connection
            </Typography>
          </Paper>
        )}
      </Container>
    </Box>
  );
};

export default App;
