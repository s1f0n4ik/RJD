import React from 'react';
import {
  Container,
  Typography,
  Box,
  Chip,
  Card,
  CardContent,
  Grid,
  Paper,
} from '@mui/material';
import {
  Videocam as VideocamIcon,
  Memory as MemoryIcon,
} from '@mui/icons-material';
import { SystemState } from '../types';
import { FLASK_BASE, ENDPOINT_MAP } from '../utils/constants';

interface DashboardProps {
  state: SystemState;
}

const Dashboard: React.FC<DashboardProps> = ({ state }) => {
  const runningCameras = state.cameras.filter(c => c.status === 'running').length;
  const runningLoaders = state.loaders.filter(l => l.status === 'running').length;

  return (
    <Container maxWidth="lg">
      {/* Summary Cards */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid item xs={12} md={6}>
          <Card sx={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
            <CardContent>
              <Box display="flex" alignItems="center" gap={2} mb={1}>
                <VideocamIcon sx={{ color: 'white', fontSize: 40 }} />
                <Typography variant="h6" sx={{ color: 'white' }}>
                  Камеры
                </Typography>
              </Box>
              <Typography variant="h2" sx={{ color: 'white', fontWeight: 'bold' }}>
                {runningCameras}/{state.cameras.length}
              </Typography>
              <Typography sx={{ color: 'rgba(255,255,255,0.8)' }}>
                Активны
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
                  Нейронные загрузчики
                </Typography>
              </Box>
              <Typography variant="h2" sx={{ color: 'white', fontWeight: 'bold' }}>
                {runningLoaders}/{state.loaders.length}
              </Typography>
              <Typography sx={{ color: 'rgba(255,255,255,0.8)' }}>
                Активны
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Cameras List */}
      {state.cameras.length > 0 && (
        <Box sx={{ mb: 4 }}>
          <Typography variant="h5" gutterBottom sx={{ mb: 2, fontWeight: 'bold' }}>
            📹 Камеры
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
                          Разрешение: {camera.width || 'auto'} × {camera.height || 'auto'}
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

      {/* Neural Loaders with Streams */}
      {state.loaders.length > 0 && (
        <Box>
          <Typography variant="h5" gutterBottom sx={{ mb: 2, fontWeight: 'bold' }}>
            🧠 Нейронная обработка
          </Typography>
          <Grid container spacing={3}>
            {state.loaders.map((loader) => {
              const flaskPath = ENDPOINT_MAP[loader.server_endpoint] || '/neural_1';
              const streamUrl = `${FLASK_BASE}${flaskPath}`;

              return (
                <Grid item xs={12} key={loader.loader_name}>
                  <Card>
                    <CardContent>
                      <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                        <Box>
                          <Typography variant="h6">{loader.loader_name}</Typography>
                          <Typography variant="body2" color="text.secondary">
                            Endpoint: {loader.server_endpoint} → {flaskPath}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            Размер модели: {loader.img_size}px
                          </Typography>
                        </Box>
                        <Chip
                          label={loader.status}
                          color={loader.status === 'running' ? 'success' : 'default'}
                        />
                      </Box>

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
                            style={{ width: '100%', height: 'auto', display: 'block' }}
                          />
                        </Box>
                      )}

                      {loader.loader_matrix && loader.loader_matrix.length > 0 && (
                        <Box sx={{ mt: 2 }}>
                          <Typography variant="subtitle2" gutterBottom>
                            📊 Матрица камер:
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
      {state.cameras.length === 0 && state.loaders.length === 0 && (
        <Paper sx={{ p: 6, textAlign: 'center' }}>
          <Typography variant="h5" color="text.secondary" gutterBottom>
            🔌 Нет данных
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Система не содержит камер или загрузчиков
          </Typography>
        </Paper>
      )}
    </Container>
  );
};

export default Dashboard;