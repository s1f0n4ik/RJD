import React, { useState, useEffect } from 'react';
import {
  Container,
  Paper,
  Typography,
  Box,
  Grid,
  TextField,
  Button,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Card,
  CardContent,
  CardActions,
  Chip,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  FormControlLabel,
  Switch,
  Divider,
  IconButton,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Videocam as VideocamIcon,
  Settings as SettingsIcon,
  CheckCircle,
  Error as ErrorIcon,
} from '@mui/icons-material';
import { FASTAPI_BASE } from '../utils/constants';
import { RZD_COLORS } from '../theme';

interface Camera {
  name: string;
  description: string;
  ip_adress: string;
  port: string;
  user: string;
  production: number;
  type: number;
  streams: {
    main: CameraStream;
    sub: CameraStream;
  };
}

interface CameraStream {
  type: number;
  sub: number;
  latency: number;
  use_udp: boolean;
  reconnect: number;
  record_path: string;
  segment: number;
  status?: number;
}

const CameraSettings: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [openDialog, setOpenDialog] = useState(false);

  // Форма добавления камеры
  const [formData, setFormData] = useState({
    name: '',
    description: 'Test Camera',
    ip_adress: '',
    port: '554',
    user: 'admin',
    password: 'VniiTest',
    production: 2, // 1-Dahua, 2-Hikvision, 3-ACE
    type: 1, // 1-General, 2-Neural, 3-Birdview
    main_sub: 0,
    main_latency: 0,
    main_use_udp: false,
    main_reconnect: 10,
    main_segment: 10,
    sub_sub: 1,
    sub_latency: 0,
    sub_use_udp: false,
    sub_reconnect: 10,
  });

  useEffect(() => {
    loadCameras();
  }, []);

  const loadCameras = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${FASTAPI_BASE}/api/cameras`);
      if (!response.ok) throw new Error('Failed to load cameras');

      const data = await response.json();
      setCameras(data.cameras || []);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (field: string, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleAddCamera = async () => {
    setLoading(true);
    setError('');
    setSuccess('');

    // Генерируем автоматически camera_name если не указан
    const cameraName = formData.name || `camera_${cameras.length + 1}`;
    const recordPath = `/home/orangepi/records/${cameraName}`;

    const payload = {
      name: cameraName,
      description: formData.description,
      ip_adress: formData.ip_adress,
      port: formData.port,
      user: formData.user,
      password: formData.password,
      production: formData.production,
      type: formData.type,
      streams: {
        main: {
          type: 1,
          sub: formData.main_sub,
          latency: formData.main_latency,
          use_udp: formData.main_use_udp,
          reconnect: formData.main_reconnect,
          record_path: recordPath,
          segment: formData.main_segment,
        },
        sub: {
          type: 2,
          sub: formData.sub_sub,
          latency: formData.sub_latency,
          use_udp: formData.sub_use_udp,
          reconnect: formData.sub_reconnect,
          record_path: '',
          segment: 0,
        },
      },
    };

    try {
      const response = await fetch(`${FASTAPI_BASE}/api/camera`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to add camera');
      }

      setSuccess(`Камера ${cameraName} успешно добавлена!`);
      setOpenDialog(false);
      loadCameras();

      // Сброс формы
      setFormData({
        name: '',
        description: 'Test Camera',
        ip_adress: '',
        port: '554',
        user: 'admin',
        password: 'VniiTest',
        production: 2,
        type: 1,
        main_sub: 0,
        main_latency: 0,
        main_use_udp: false,
        main_reconnect: 10,
        main_segment: 10,
        sub_sub: 1,
        sub_latency: 0,
        sub_use_udp: false,
        sub_reconnect: 10,
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteCamera = async (cameraName: string) => {
    if (!window.confirm(`Удалить камеру ${cameraName}?`)) return;

    setLoading(true);
    try {
      const response = await fetch(`${FASTAPI_BASE}/api/camera/${cameraName}`, {
        method: 'DELETE',
      });

      if (!response.ok) throw new Error('Failed to delete camera');

      setSuccess(`Камера ${cameraName} удалена`);
      loadCameras();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status?: number) => {
    switch (status) {
      case 3: return 'success'; // PLAYING
      case 5: return 'info'; // INITIALIZED
      case 2: return 'warning'; // STOPPED
      default: return 'default';
    }
  };

  const getStatusText = (status?: number) => {
    switch (status) {
      case 0: return 'Отсутствует';
      case 1: return 'Готов';
      case 2: return 'Остановлен';
      case 3: return 'В работе';
      case 4: return 'Перезапуск';
      case 5: return 'Инициализирован';
      default: return 'Неизвестно';
    }
  };

  const getProductionName = (prod: number) => {
    switch (prod) {
      case 1: return 'Dahua';
      case 2: return 'Hikvision';
      case 3: return 'ACE';
      default: return 'Unknown';
    }
  };

  const getTypeName = (type: number) => {
    switch (type) {
      case 1: return 'General';
      case 2: return 'Neural';
      case 3: return 'Birdview';
      default: return 'Unknown';
    }
  };

  return (
    <Container maxWidth="xl">
      {/* Заголовок */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Box display="flex" alignItems="center" gap={2}>
            <SettingsIcon sx={{ fontSize: 40, color: RZD_COLORS.primary }} />
            <Box>
              <Typography variant="h5" fontWeight="bold">
                ⚙️ Управление камерами
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Всего камер: {cameras.length}
              </Typography>
            </Box>
          </Box>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setOpenDialog(true)}
            sx={{ bgcolor: RZD_COLORS.primary }}
          >
            Добавить камеру
          </Button>
        </Box>
      </Paper>

      {/* Уведомления */}
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>{success}</Alert>}

      {/* Список камер */}
      <Grid container spacing={3}>
        {cameras.map((camera) => (
          <Grid item xs={12} md={6} lg={4} key={camera.name}>
            <Card>
              <CardContent>
                <Box display="flex" justifyContent="space-between" alignItems="start" mb={2}>
                  <Box display="flex" alignItems="center" gap={1}>
                    <VideocamIcon color="primary" />
                    <Typography variant="h6" fontWeight="bold">
                      {camera.name}
                    </Typography>
                  </Box>
                  <Chip
                    label={getStatusText(camera.streams?.main?.status)}
                    color={getStatusColor(camera.streams?.main?.status)}
                    size="small"
                  />
                </Box>

                <Typography variant="body2" color="text.secondary" gutterBottom>
                  {camera.description}
                </Typography>

                <Divider sx={{ my: 1.5 }} />

                <Box sx={{ '& > div': { mb: 1 } }}>
                  <Box display="flex" justifyContent="space-between">
                    <Typography variant="caption" color="text.secondary">IP:</Typography>
                    <Typography variant="caption">{camera.ip_adress}:{camera.port}</Typography>
                  </Box>
                  <Box display="flex" justifyContent="space-between">
                    <Typography variant="caption" color="text.secondary">Производитель:</Typography>
                    <Typography variant="caption">{getProductionName(camera.production)}</Typography>
                  </Box>
                  <Box display="flex" justifyContent="space-between">
                    <Typography variant="caption" color="text.secondary">Тип:</Typography>
                    <Typography variant="caption">{getTypeName(camera.type)}</Typography>
                  </Box>
                  <Box display="flex" justifyContent="space-between">
                    <Typography variant="caption" color="text.secondary">Запись:</Typography>
                    <Typography variant="caption">
                      {camera.streams?.main?.segment > 0 ? `${camera.streams.main.segment} мин` : 'Выкл'}
                    </Typography>
                  </Box>
                </Box>
              </CardContent>
              <CardActions>
                <Button
                  fullWidth
                  variant="outlined"
                  color="error"
                  startIcon={<DeleteIcon />}
                  onClick={() => handleDeleteCamera(camera.name)}
                  disabled={loading}
                >
                  Удалить
                </Button>
              </CardActions>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* Диалог добавления камеры */}
      <Dialog open={openDialog} onClose={() => setOpenDialog(false)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ bgcolor: RZD_COLORS.primary, color: 'white' }}>
          Добавить новую камеру
        </DialogTitle>
        <DialogContent sx={{ mt: 2 }}>
          <Grid container spacing={2}>
            {/* Основные параметры */}
            <Grid item xs={12}>
              <Typography variant="subtitle2" fontWeight="bold" gutterBottom>
                📋 Основные параметры
              </Typography>
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Имя камеры"
                placeholder={`camera_${cameras.length + 1}`}
                value={formData.name}
                onChange={(e) => handleInputChange('name', e.target.value)}
                helperText="Оставьте пустым для автогенерации"
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Описание"
                value={formData.description}
                onChange={(e) => handleInputChange('description', e.target.value)}
              />
            </Grid>

            <Grid item xs={12} sm={8}>
              <TextField
                fullWidth
                required
                label="IP-адрес"
                placeholder="192.168.1.10"
                value={formData.ip_adress}
                onChange={(e) => handleInputChange('ip_adress', e.target.value)}
              />
            </Grid>

            <Grid item xs={12} sm={4}>
              <TextField
                fullWidth
                label="Порт"
                value={formData.port}
                onChange={(e) => handleInputChange('port', e.target.value)}
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Логин"
                value={formData.user}
                onChange={(e) => handleInputChange('user', e.target.value)}
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                type="password"
                label="Пароль"
                value={formData.password}
                onChange={(e) => handleInputChange('password', e.target.value)}
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <FormControl fullWidth>
                <InputLabel>Производитель</InputLabel>
                <Select
                  value={formData.production}
                  onChange={(e) => handleInputChange('production', e.target.value)}
                  label="Производитель"
                >
                  <MenuItem value={1}>Dahua</MenuItem>
                  <MenuItem value={2}>Hikvision</MenuItem>
                  <MenuItem value={3}>ACE</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={12} sm={6}>
              <FormControl fullWidth>
                <InputLabel>Тип камеры</InputLabel>
                <Select
                  value={formData.type}
                  onChange={(e) => handleInputChange('type', e.target.value)}
                  label="Тип камеры"
                >
                  <MenuItem value={1}>General</MenuItem>
                  <MenuItem value={2}>Neural</MenuItem>
                  <MenuItem value={3}>Birdview</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            {/* Main Stream */}
            <Grid item xs={12}>
              <Divider sx={{ my: 1 }} />
              <Typography variant="subtitle2" fontWeight="bold" gutterBottom>
                📹 Main Stream (основной поток)
              </Typography>
            </Grid>

            <Grid item xs={12} sm={4}>
              <TextField
                fullWidth
                label="Subtype"
                type="number"
                value={formData.main_sub}
                onChange={(e) => handleInputChange('main_sub', parseInt(e.target.value))}
                helperText="0 или 1"
              />
            </Grid>

            <Grid item xs={12} sm={4}>
              <TextField
                fullWidth
                label="Reconnect (сек)"
                type="number"
                value={formData.main_reconnect}
                onChange={(e) => handleInputChange('main_reconnect', parseInt(e.target.value))}
              />
            </Grid>

            <Grid item xs={12} sm={4}>
              <TextField
                fullWidth
                label="Запись (мин)"
                type="number"
                value={formData.main_segment}
                onChange={(e) => handleInputChange('main_segment', parseInt(e.target.value))}
                helperText="0 = выкл"
              />
            </Grid>

            <Grid item xs={12}>
              <FormControlLabel
                control={
                  <Switch
                    checked={formData.main_use_udp}
                    onChange={(e) => handleInputChange('main_use_udp', e.target.checked)}
                  />
                }
                label="Использовать UDP"
              />
            </Grid>

            {/* Sub Stream */}
            <Grid item xs={12}>
              <Divider sx={{ my: 1 }} />
              <Typography variant="subtitle2" fontWeight="bold" gutterBottom>
                📹 Sub Stream (вспомогательный поток)
              </Typography>
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Subtype"
                type="number"
                value={formData.sub_sub}
                onChange={(e) => handleInputChange('sub_sub', parseInt(e.target.value))}
                helperText="1 или 2"
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Reconnect (сек)"
                type="number"
                value={formData.sub_reconnect}
                onChange={(e) => handleInputChange('sub_reconnect', parseInt(e.target.value))}
              />
            </Grid>

            <Grid item xs={12}>
              <FormControlLabel
                control={
                  <Switch
                    checked={formData.sub_use_udp}
                    onChange={(e) => handleInputChange('sub_use_udp', e.target.checked)}
                  />
                }
                label="Использовать UDP"
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setOpenDialog(false)} disabled={loading}>
            Отмена
          </Button>
          <Button
            variant="contained"
            onClick={handleAddCamera}
            disabled={loading || !formData.ip_adress}
            sx={{ bgcolor: RZD_COLORS.primary }}
          >
            Добавить
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};

export default CameraSettings;