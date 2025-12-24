import { useState, useEffect } from 'react';
import { 
  AppBar, Toolbar, Typography, Container, Grid, Card, 
  CardContent, Box, Chip, Button, CircularProgress 
} from '@mui/material';
import { green, red, orange } from '@mui/material/colors';

interface Camera {
  camera_name: string;
  rtsp_url: string;
  status: string;
  width: number | null;
  height: number | null;
}

interface Loader {
  loader_name: string;
  img_size: number;
  status: string;
}

interface StatusData {
  cameras: Camera[];
  loaders: Loader[];
  summary: {
    cameras_total: number;
    cameras_running: number;
    loaders_total: number;
    loaders_running: number;
  };
}

// Определяем URL API из переменных окружения или используем по умолчанию
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000';

function App() {
  const [data, setData] = useState<StatusData | null>(null);
  const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [ws, setWs] = useState<WebSocket | null>(null);

  useEffect(() => {
    const connectWebSocket = () => {
      console.log(`Attempting to connect to ${WS_URL}/ws`);
      const websocket = new WebSocket(`${WS_URL}/ws`);

      websocket.onopen = () => {
        console.log('✅ WebSocket connected');
        setWsStatus('connected');
        websocket.send(JSON.stringify({ type: 'subscribe' }));
      };

      websocket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        console.log('📩 Received:', message.type);
        if (message.type === 'status_update' || message.type === 'initial_state') {
          setData(message.data);
        }
      };

      websocket.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
      };

      websocket.onclose = () => {
        console.log('🔴 WebSocket disconnected');
        setWsStatus('disconnected');
        setTimeout(() => {
          console.log('🔄 Reconnecting...');
          connectWebSocket();
        }, 3000);
      };

      setWs(websocket);
    };

    connectWebSocket();

    return () => {
      if (ws) {
        ws.close();
      }
    };
  }, []);

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'running': return green[500];
      case 'stopped': return red[500];
      case 'failed': return red[700];
      default: return orange[500];
    }
  };

  if (!data) {
    return (
      <Box display="flex" flexDirection="column" justifyContent="center" alignItems="center" minHeight="100vh">
        <CircularProgress />
        <Typography sx={{ mt: 2 }}>
          {wsStatus === 'connected' ? 'Loading data...' : 'Connecting to server...'}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
          WebSocket: {WS_URL}/ws
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ flexGrow: 1 }}>
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            🎥 Video Processing System
          </Typography>
          <Chip 
            label={wsStatus === 'connected' ? '🟢 Connected' : '🔴 Disconnected'}
            color={wsStatus === 'connected' ? 'success' : 'error'}
          />
        </Toolbar>
      </AppBar>

      <Container maxWidth="xl" sx={{ mt: 4 }}>
        {/* Summary */}
        <Grid container spacing={2} sx={{ mb: 4 }}>
          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Typography variant="h6">📹 Cameras</Typography>
                <Typography variant="h3">
                  {data.summary.cameras_running}/{data.summary.cameras_total}
                </Typography>
                <Typography color="text.secondary">Running</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} md={6}>
            <Card>
              <CardContent>
                <Typography variant="h6">🧠 Loaders</Typography>
                <Typography variant="h3">
                  {data.summary.loaders_running}/{data.summary.loaders_total}
                </Typography>
                <Typography color="text.secondary">Running</Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        {/* Cameras */}
        <Typography variant="h5" sx={{ mb: 2 }}>Cameras</Typography>
        <Grid container spacing={2} sx={{ mb: 4 }}>
          {data.cameras.map((camera) => (
            <Grid item xs={12} md={6} key={camera.camera_name}>
              <Card>
                <CardContent>
                  <Box display="flex" justifyContent="space-between" alignItems="center">
                    <Typography variant="h6">{camera.camera_name}</Typography>
                    <Chip 
                      label={camera.status}
                      sx={{ bgcolor: getStatusColor(camera.status), color: 'white' }}
                    />
                  </Box>
                  <Typography color="text.secondary" sx={{ mt: 1, fontSize: '0.875rem' }}>
                    {camera.rtsp_url}
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    Resolution: {camera.width || 'N/A'} × {camera.height || 'N/A'}
                  </Typography>
                  
                  {/* Video Stream */}
                  {camera.status === 'running' && (
                    <Box sx={{ mt: 2 }}>
                      <img 
                        src={`${API_URL}/neural_1`}
                        alt={camera.camera_name}
                        style={{ width: '100%', borderRadius: 4 }}
                        onError={(e) => {
                          console.error('Failed to load image');
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    </Box>
                  )}
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>

        {/* Loaders */}
        <Typography variant="h5" sx={{ mb: 2 }}>Neural Loaders</Typography>
        <Grid container spacing={2}>
          {data.loaders.map((loader) => (
            <Grid item xs={12} md={4} key={loader.loader_name}>
              <Card>
                <CardContent>
                  <Box display="flex" justifyContent="space-between" alignItems="center">
                    <Typography variant="h6">{loader.loader_name}</Typography>
                    <Chip 
                      label={loader.status}
                      sx={{ bgcolor: getStatusColor(loader.status), color: 'white' }}
                    />
                  </Box>
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    Image Size: {loader.img_size}×{loader.img_size}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Container>
    </Box>
  );
}

export default App;
