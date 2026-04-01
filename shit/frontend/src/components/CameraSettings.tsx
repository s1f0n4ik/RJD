import React, { useState, useEffect } from 'react';
import {
  Container,
  Paper,
  Typography,
  Box,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Chip,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Grid,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormControlLabel,
  Switch,
  Tabs,
  Tab,
  Divider,
  CircularProgress,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  Settings as SettingsIcon,
  Videocam as VideocamIcon,
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

interface CameraFormData {
  name: string;
  description: string;
  ip_adress: string;
  port: string;
  user: string;
  password: string;
  production: number;
  type: number;
  main_sub: number;
  main_latency: number;
  main_use_udp: boolean;
  main_reconnect: number;
  main_segment: number;
  sub_sub: number;
  sub_latency: number;
  sub_use_udp: boolean;
  sub_reconnect: number;
}

const CameraSettings: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [openDialog, setOpenDialog] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [selectedTab, setSelectedTab] = useState(0);

  const [formData, setFormData] = useState<CameraFormData>({
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

  const handleInputChange = (field: keyof CameraFormData, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleOpenAddDialog = () => {
    setEditMode(false);
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
    setSelectedTab(0);
    setOpenDialog(true);
  };

  const handleOpenEditDialog = (camera: Camera) => {
    setEditMode(true);
    setFormData({
      name: camera.name,
      description: camera.description,
      ip_adress: camera.ip_adress,
      port: camera.port,
      user: camera.user,
      password: '', // Не показываем пароль
      production: camera.production,
      type: camera.type,
      main_sub: camera.streams.main.sub,
      main_latency: camera.streams.main.latency,
      main_use_udp: camera.streams.main.use_udp,
      main_reconnect: camera.streams.main.reconnect,
      main_segment: camera.streams.main.segment,
      sub_sub: camera.streams.sub.sub,
      sub_latency: camera.streams.sub.latency,
      sub_use_udp: camera.streams.sub.use_udp,
      sub_reconnect: camera.streams.sub.reconnect,
    });
    setSelectedTab(0);
    setOpenDialog(true);
  };

  const handleSaveCamera = async () => {
    setLoading(true);
    setError('');
    setSuccess('');

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
        throw new Error(errorData.detail || 'Failed to save camera');
      }

      setSuccess(`Камера ${cameraName} успешно ${editMode ? 'обновлена' : 'добавлена'}!`);
      setOpenDialog(false);
      loadCameras();
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

  const getStatusColor = (status?: number): 'default' | 'success' | 'warning' | 'error' | 'info' => {
    switch (status) {
      case 3: return 'success';
      case 5: return 'info';
      case 2: return 'warning';
      case 0: return 'error';
      default: return 'default';
    }
  };

  const getStatusText = (status?: number) => {
    const statusMap: Record<number, string> = {
      0: 'Отсутствует',
      1: 'Готов',
      2: 'Остановлен',
      3: 'В работе',
      4: 'Перезапуск',
      5: 'Инициализирован',
    };
    return statusMap[status ?? 0] || 'Неизвестно';
  };

  const getProductionName = (prod: number) => {
    const prodMap: Record<number, string> = { 1: 'Dahua', 2: 'Hikvision', 3: 'ACE' };
    return prodMap[prod] || 'Unknown';
  };

  return (
    <Container maxWidth="xl">
      {/* Header */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Box display="flex" alignItems="center" gap={2}>
            <SettingsIcon sx={{ fontSize: 40, color: RZD_COLORS.primary }} />
            <Box>
              <Typography variant="h5" fontWeight="bold">
                ⚙️ Настройки камер
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Добавленные устройства: {cameras.length}
              </Typography>
            </Box>
          </Box>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={handleOpenAddDialog}
            sx={{ bgcolor: RZD_COLORS.primary }}
          >
            Manual Add
          </Button>
        </Box>
      </Paper>

      {/* Alerts */}
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>{success}</Alert>}

      {/* Table */}
      <TableContainer component={Paper}>
        <Table>
          <TableHead sx={{ bgcolor: RZD_COLORS.grey[100] }}>
            <TableRow>
              <TableCell><strong>Канал</strong></TableCell>
              <TableCell><strong>IP</strong></TableCell>
              <TableCell><strong>Порт</strong></TableCell>
              <TableCell><strong>Производитель</strong></TableCell>
              <TableCell><strong>Имя камеры</strong></TableCell>
              <TableCell><strong>Статус</strong></TableCell>
              <TableCell align="center"><strong>Изменить</strong></TableCell>
              <TableCell align="center"><strong>Удалить</strong></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && cameras.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ py: 4 }}>
                  <CircularProgress />
                </TableCell>
              </TableRow>
            ) : cameras.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ py: 4 }}>
                  <Typography color="text.secondary">Нет добавленных камер</Typography>
                </TableCell>
              </TableRow>
            ) : (
              cameras.map((camera, index) => (
                <TableRow key={camera.name} hover>
                  <TableCell>
                    <Box display="flex" alignItems="center" gap={1}>
                      <VideocamIcon sx={{ color: RZD_COLORS.primary, fontSize: 20 }} />
                      <Typography variant="body2" fontWeight={600}>
                        #{index + 1}
                      </Typography>
                    </Box>
                  </TableCell>
                  <TableCell>{camera.ip_adress}</TableCell>
                  <TableCell>{camera.port}</TableCell>
                  <TableCell>{getProductionName(camera.production)}</TableCell>
                  <TableCell>
                    <Typography variant="body2" fontWeight={600}>
                      {camera.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {camera.description}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={getStatusText(camera.streams?.main?.status)}
                      color={getStatusColor(camera.streams?.main?.status)}
                      size="small"
                    />
                  </TableCell>
                  <TableCell align="center">
                    <IconButton
                      color="primary"
                      onClick={() => handleOpenEditDialog(camera)}
                      disabled={loading}
                    >
                      <EditIcon />
                    </IconButton>
                  </TableCell>
                  <TableCell align="center">
                    <IconButton
                      color="error"
                      onClick={() => handleDeleteCamera(camera.name)}
                      disabled={loading}
                    >
                      <DeleteIcon />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Add/Edit Dialog */}
      <Dialog open={openDialog} onClose={() => setOpenDialog(false)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ bgcolor: RZD_COLORS.primary, color: 'white' }}>
          {editMode ? '✏️ Изменить камеру' : '➕ Добавить новую камеру'}
        </DialogTitle>
        <DialogContent sx={{ mt: 2 }}>
          <Tabs value={selectedTab} onChange={(_, v) => setSelectedTab(v)} sx={{ mb: 2 }}>
            <Tab label="📋 Основная информация" />
            <Tab label="📹 Потоки" />
            <Tab label="⏺️ Запись" />
          </Tabs>

          {/* Tab 0: Basic Info */}
          {selectedTab === 0 && (
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  label="Имя камеры"
                  placeholder={`camera_${cameras.length + 1}`}
                  value={formData.name}
                  onChange={(e) => handleInputChange('name', e.target.value)}
                  disabled={editMode}
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
                  label="IP-адресс"
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
                  label="Имя пользователя"
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
                    <MenuItem value={1}>Основная</MenuItem>
                    <MenuItem value={2}>AI</MenuItem>
                    <MenuItem value={3}>360°</MenuItem>
                  </Select>
                </FormControl>
              </Grid>
            </Grid>
          )}

          {/* Tab 1: Streams */}
          {selectedTab === 1 && (
            <Grid container spacing={2}>
              <Grid item xs={12}>
                <Typography variant="subtitle2" fontWeight="bold" gutterBottom>
                  📹 Главный поток
                </Typography>
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  fullWidth
                  label="Подтип"
                  type="number"
                  value={formData.main_sub}
                  onChange={(e) => handleInputChange('main_sub', parseInt(e.target.value))}
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  fullWidth
                  label="Задержка (мс)"
                  type="number"
                  value={formData.main_latency}
                  onChange={(e) => handleInputChange('main_latency', parseInt(e.target.value))}
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  fullWidth
                  label="Переподключение (сек)"
                  type="number"
                  value={formData.main_reconnect}
                  onChange={(e) => handleInputChange('main_reconnect', parseInt(e.target.value))}
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
                  label="Используйте UDP"
                />
              </Grid>

              <Grid item xs={12}>
                <Divider sx={{ my: 1 }} />
                <Typography variant="subtitle2" fontWeight="bold" gutterBottom>
                  📹 Второй поток
                </Typography>
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  fullWidth
                  label="Subtype"
                  type="number"
                  value={formData.sub_sub}
                  onChange={(e) => handleInputChange('sub_sub', parseInt(e.target.value))}
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  fullWidth
                  label="Задержка (мс)"
                  type="number"
                  value={formData.sub_latency}
                  onChange={(e) => handleInputChange('sub_latency', parseInt(e.target.value))}
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  fullWidth
                  label="Переподключение (сек)"
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
                  label="Используйте UDP"
                />
              </Grid>
            </Grid>
          )}

          {/* Tab 2: Recording */}
          {selectedTab === 2 && (
            <Grid container spacing={2}>
              <Grid item xs={12}>
                <Alert severity="info" sx={{ mb: 2 }}>
                  Настройки записи доступны только для основного потока
                </Alert>
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  label="Длительность сегмента"
                  type="number"
                  value={formData.main_segment}
                  onChange={(e) => handleInputChange('main_segment', parseInt(e.target.value))}
                  helperText="0 = recording disabled"
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  disabled
                  label="Местоположение записей"
                  value={`/home/orangepi/records/${formData.name || 'camera_X'}`}
                  helperText="Auto-generated"
                />
              </Grid>
              <Grid item xs={12}>
                <Typography variant="caption" color="text.secondary">
                  💾 Записи сохранены как MP4 файлы в указанный каталог.
                  Каждый сегмент длится {formData.main_segment} минут
                </Typography>
              </Grid>
            </Grid>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setOpenDialog(false)} disabled={loading}>
            Отменить
          </Button>
          <Button
            variant="contained"
            onClick={handleSaveCamera}
            disabled={loading || !formData.ip_adress}
            sx={{ bgcolor: RZD_COLORS.primary }}
          >
            {loading ? <CircularProgress size={24} /> : editMode ? 'Update' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};

export default CameraSettings;