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
import type { SystemState } from '../types';
import { FLASK_BASE, ENDPOINT_MAP } from '../utils/constants';
import { RZD_COLORS } from '../theme';

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
          <Card
            sx={{
              background: `linear-gradient(135deg, ${RZD_COLORS.primary} 0%, ${RZD_COLORS.primaryDark} 100%)`,
              color: 'white',
            }}
          >
            <CardContent sx={{ py: 3 }}>
              <Box display="flex" alignItems="center" gap={2} mb={2}>
                <VideocamIcon sx={{ fontSize: 48 }} />
                <Typography variant="h6" fontWeight={600}>
                  Камеры видеонаблюдения
                </Typography>
              </Box>
              <Typography variant="h2" fontWeight="bold" sx={{ mb: 1 }}>
                {runningCameras}/{state.cameras.length}
              </Typography>
              <Typography sx={{ opacity: 0.9 }}>
                Активных камер
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={6}>
          <Card
            sx={{
              background: `linear-gradient(135deg, ${RZD_COLORS.secondary} 0%, ${RZD_COLORS.secondaryLight} 100%)`,
              color: 'white',
            }}
          >
            <CardContent sx={{ py: 3 }}>
              <Box display="flex" alignItems="center" gap={2} mb={2}>
                <MemoryIcon sx={{ fontSize: 48 }} />
                <Typography variant="h6" fontWeight={600}>
                  Нейронные загрузчики
                </Typography>
              </Box>
              <Typography variant="h2" fontWeight="bold" sx={{ mb: 1 }}>
                {runningLoaders}/{state.loaders.length}
              </Typography>
              <Typography sx={{ opacity: 0.9 }}>
                Активных загрузчиков
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Cameras List */}
      {state.cameras.length > 0 && (
        <Box sx={{ mb: 4 }}>
          <Typography variant="h5" gutterBottom sx={{ mb: 2, fontWeight: 600 }}>
            📹 Камеры видеонаблюдения
          </Typography>
          <Grid container spacing={2}>
            {state.cameras.map((camera) => (
              <Grid item xs={12} md={6} key={camera.camera_name}>
                <Card sx={{ borderLeft: `4px solid ${RZD_COLORS.primary}` }}>
                  <CardContent>
                    <Box display="flex" justifyContent="space-between" alignItems="start" gap={2}>
                      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                        <Typography variant="h6" gutterBottom fontWeight={600} noWrap>
                          {camera.camera_name}
                        </Typography>
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{
                            mb: 1,
                            fontSize: '0.8rem',
                            wordBreak: 'break-all',
                          }}
                        >
                          {camera.rtsp_url}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Разрешение: {camera.width || 'auto'} × {camera.height || 'auto'}
                        </Typography>
                      </Box>

                      {/* ✅ 4. Chip с правильными размерами */}
                      <Chip
                        label={camera.status === 'running' ? 'Активна' : 'Остановлена'}
                        color={camera.status === 'running' ? 'success' : 'default'}
                        size="small"
                        sx={{
                          flexShrink: 0,
                          fontWeight: 600,
                          fontSize: '0.75rem',
                          height: 'auto',
                          minHeight: 24,
                          '& .MuiChip-label': {
                            px: 1.5,
                            py: 0.5,
                            whiteSpace: 'nowrap',
                          },
                        }}
                      />
                    </Box>
                  </CardContent>
                </Card>
              </Grid>
            ))}
          </Grid>
        </Box>
      )}

      {/* Neural Loaders */}
      {state.loaders.length > 0 && (
        <Box>
          <Typography variant="h5" gutterBottom sx={{ mb: 2, fontWeight: 600 }}>
            🧠 Нейронная обработка
          </Typography>
          <Grid container spacing={3}>
            {state.loaders.map((loader) => {
              const flaskPath = ENDPOINT_MAP[loader.server_endpoint] || '/neural_1';
              const streamUrl = `${FLASK_BASE}${flaskPath}`;

              return (
                <Grid item xs={12} key={loader.loader_name}>
                  <Card sx={{ borderLeft: `4px solid ${RZD_COLORS.secondary}` }}>
                    <CardContent>
                      <Box display="flex" justifyContent="space-between" alignItems="center" mb={2} gap={2}>
                        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                          <Typography variant="h6" fontWeight={600}>
                            {loader.loader_name}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            Endpoint: {loader.server_endpoint} → {flaskPath}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            Размер модели: {loader.img_size}px
                          </Typography>
                        </Box>

                        {/* ✅ Chip для загрузчиков тоже */}
                        <Chip
                          label={loader.status === 'running' ? 'Активен' : 'Остановлен'}
                          color={loader.status === 'running' ? 'success' : 'default'}
                          sx={{
                            flexShrink: 0,
                            fontWeight: 600,
                            fontSize: '0.75rem',
                            height: 'auto',
                            minHeight: 24,
                            '& .MuiChip-label': {
                              px: 1.5,
                              py: 0.5,
                              whiteSpace: 'nowrap',
                            },
                          }}
                        />
                      </Box>

                      {loader.status === 'running' && (
                        <Box
                          sx={{
                            mt: 2,
                            bgcolor: 'black',
                            borderRadius: 2,
                            overflow: 'hidden',
                            border: `3px solid ${RZD_COLORS.primary}`,
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
                          <Typography variant="subtitle2" gutterBottom fontWeight={600}>
                            📊 Матрица камер:
                          </Typography>
                          <Box
                            sx={{
                              fontFamily: 'monospace',
                              fontSize: '0.875rem',
                              bgcolor: RZD_COLORS.grey[100],
                              p: 2,
                              borderRadius: 2,
                              border: `1px solid ${RZD_COLORS.grey[200]}`,
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
        <Paper sx={{ p: 8, textAlign: 'center' }}>
          <Typography variant="h5" color="text.secondary" gutterBottom fontWeight={600}>
            Нет активных устройств
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