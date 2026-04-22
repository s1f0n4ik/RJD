import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
  Stack,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  Settings as SettingsIcon,
  Videocam as VideocamIcon,
  FiberManualRecord as RecIcon,
  PlayArrow as PlayIcon,
  Stop as StopIcon,
  CheckCircle as CheckIcon,
  Error as ErrorIcon,
} from '@mui/icons-material';
import { FASTAPI_BASE } from '../utils/constants';
import { RZD_COLORS } from '../theme';
// ⚠️ Если у тебя другой путь к плееру — поправь импорт
import WebRTCPlayer from './WebRTCPlayer';

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
  recording_enabled: boolean;
}

type ProbeStatus = 'idle' | 'creating' | 'streaming' | 'error';

const RESERVED_PREFIXES = ['__probe_'];
const NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_-]{1,31}$/;
const IP_REGEX = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

const DEFAULT_FORM: CameraFormData = {
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
  recording_enabled: true,
};

/** Поиск первого свободного номера для camera_N */
const findNextFreeCameraName = (cameras: Camera[]): string => {
  const usedNumbers = new Set<number>();
  const re = /^camera_(\d+)$/;
  for (const c of cameras) {
    const m = c.name.match(re);
    if (m) usedNumbers.add(parseInt(m[1], 10));
  }
  let n = 1;
  while (usedNumbers.has(n)) n++;
  return `camera_${n}`;
};

interface NameValidation {
  valid: boolean;
  error?: string;
}

const validateCameraName = (
  name: string,
  existingNames: string[],
  editMode: boolean
): NameValidation => {
  if (!name) return { valid: true }; // пусто = будет auto-name
  if (RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
    return { valid: false, error: 'Этот префикс зарезервирован системой' };
  }
  if (!NAME_REGEX.test(name)) {
    return {
      valid: false,
      error: 'Только латиница, цифры, _ и -. Длина 2–32, не начинается с цифры',
    };
  }
  if (!editMode && existingNames.includes(name)) {
    return { valid: false, error: 'Камера с таким именем уже существует' };
  }
  return { valid: true };
};

const validateIp = (ip: string): NameValidation => {
  if (!ip) return { valid: false, error: 'IP-адрес обязателен' };
  if (!IP_REGEX.test(ip)) return { valid: false, error: 'Некорректный IP-адрес' };
  return { valid: true };
};

const validatePort = (port: string): NameValidation => {
  if (!port) return { valid: false, error: 'Порт обязателен' };
  const n = parseInt(port, 10);
  if (isNaN(n) || n < 1 || n > 65535) {
    return { valid: false, error: 'Порт должен быть в диапазоне 1–65535' };
  }
  return { valid: true };
};

const CameraSettings: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [openDialog, setOpenDialog] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [selectedTab, setSelectedTab] = useState(0);

  const [formData, setFormData] = useState<CameraFormData>(DEFAULT_FORM);

  // === PROBE state ===
  const [probeStatus, setProbeStatus] = useState<ProbeStatus>('idle');
  const [probeError, setProbeError] = useState('');
  const [probeName, setProbeName] = useState<string | null>(null);
  const probeNameRef = useRef<string | null>(null);

  useEffect(() => {
    loadCameras();
  }, []);

  // === cleanup probe на beforeunload ===
  useEffect(() => {
    const handler = () => {
      if (probeNameRef.current) {
        // fetch с keepalive работает при unload в современных браузерах
        fetch(`${FASTAPI_BASE}/api/camera/${probeNameRef.current}`, {
          method: 'DELETE',
          keepalive: true,
        }).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const existingNames = useMemo(() => cameras.map((c) => c.name), [cameras]);

  // === Валидация ===
  const nameValidation = useMemo(
    () => validateCameraName(formData.name, existingNames, editMode),
    [formData.name, existingNames, editMode]
  );
  const ipValidation = useMemo(() => validateIp(formData.ip_adress), [formData.ip_adress]);
  const portValidation = useMemo(() => validatePort(formData.port), [formData.port]);

  const isFormValid =
    nameValidation.valid && ipValidation.valid && portValidation.valid;

  const loadCameras = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${FASTAPI_BASE}/api/cameras`);
      if (!response.ok) throw new Error('Failed to load cameras');
      const data = await response.json();

      // Нормализация: бэк может отдавать и объект, и массив
      let list: Camera[] = [];
      if (data.cameras) {
        if (Array.isArray(data.cameras)) {
          list = data.cameras;
        } else if (typeof data.cameras === 'object') {
          list = Object.entries(data.cameras).map(([name, v]: [string, any]) => ({
            name,
            ...v,
          }));
        }
      }
      // скрываем probe-камеры из UI (если вдруг остались от прошлой сессии)
      list = list.filter((c) => !RESERVED_PREFIXES.some((p) => c.name.startsWith(p)));
      setCameras(list);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (field: keyof CameraFormData, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleOpenAddDialog = () => {
    setEditMode(false);
    setFormData({
      ...DEFAULT_FORM,
      // placeholder оставим пустым, auto-name сформируется при сохранении
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
      password: '',
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
      // тумблер = включён, если segment > 0
      recording_enabled: camera.streams.main.segment > 0,
    });
    setSelectedTab(0);
    setOpenDialog(true);
  };

  // === PROBE ===
  const cleanupProbe = useCallback(async () => {
    const name = probeNameRef.current;
    if (!name) return;
    probeNameRef.current = null;
    setProbeName(null);
    try {
      await fetch(`${FASTAPI_BASE}/api/camera/${name}`, { method: 'DELETE' });
    } catch {
      /* тихо */
    }
  }, []);

  const handleTestStream = async () => {
    // Валидируем только то, что нужно для подключения
    if (!ipValidation.valid || !portValidation.valid) {
      setProbeError('Заполните корректные IP и порт');
      setProbeStatus('error');
      return;
    }

    // Если уже есть probe — снесём старый
    await cleanupProbe();

    setProbeError('');
    setProbeStatus('creating');

    const tempName = `__probe_${Date.now()}`;
    const recordPath = `/home/orangepi/records/${tempName}`;

    const payload = {
      name: tempName,
      description: 'Temporary probe',
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
          segment: 0, // probe пишется без записи
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
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || 'Не удалось создать probe-камеру');
      }

      probeNameRef.current = tempName;
      setProbeName(tempName);
      // Небольшая задержка, чтобы pipeline успел подняться
      setTimeout(() => setProbeStatus('streaming'), 1500);
    } catch (err: any) {
      setProbeError(err.message);
      setProbeStatus('error');
    }
  };

  const handleStopTest = async () => {
    await cleanupProbe();
    setProbeStatus('idle');
    setProbeError('');
  };

  // === SAVE ===
  const handleSaveCamera = async () => {
    if (!isFormValid) return;

    setLoading(true);
    setError('');
    setSuccess('');

    // 1) auto-name через поиск свободного номера
    const cameraName = formData.name || findNextFreeCameraName(cameras);
    const recordPath = `/home/orangepi/records/${cameraName}`;

    // 2) segment с учётом тумблера
    const effectiveSegment = formData.recording_enabled ? formData.main_segment : 0;

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
          segment: effectiveSegment,
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

      // Если был probe — прибираем
      await cleanupProbe();
      setProbeStatus('idle');

      setSuccess(
        `Камера ${cameraName} успешно ${editMode ? 'обновлена' : 'добавлена'}!`
      );
      setOpenDialog(false);
      loadCameras();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCloseDialog = async () => {
    await cleanupProbe();
    setProbeStatus('idle');
    setProbeError('');
    setOpenDialog(false);
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

  const getStatusColor = (
    status?: number
  ): 'default' | 'success' | 'warning' | 'error' | 'info' => {
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

  const autoNamePreview = useMemo(
    () => findNextFreeCameraName(cameras),
    [cameras]
  );

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
            Добавить
          </Button>
        </Box>
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>
          {success}
        </Alert>
      )}

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
              <TableCell><strong>Запись</strong></TableCell>
              <TableCell><strong>Статус</strong></TableCell>
              <TableCell align="center"><strong>Изменить</strong></TableCell>
              <TableCell align="center"><strong>Удалить</strong></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && cameras.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} align="center" sx={{ py: 4 }}>
                  <CircularProgress />
                </TableCell>
              </TableRow>
            ) : cameras.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} align="center" sx={{ py: 4 }}>
                  <Typography color="text.secondary">Нет добавленных камер</Typography>
                </TableCell>
              </TableRow>
            ) : (
              cameras.map((camera, index) => {
                const recOn = (camera.streams?.main?.segment ?? 0) > 0;
                return (
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
                      {recOn ? (
                        <Chip
                          icon={<RecIcon sx={{ color: '#e53935 !important' }} />}
                          label={`REC ${camera.streams.main.segment}м`}
                          size="small"
                          variant="outlined"
                          sx={{ borderColor: '#e53935', color: '#e53935' }}
                        />
                      ) : (
                        <Chip label="Выкл" size="small" variant="outlined" />
                      )}
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
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Add/Edit Dialog */}
      <Dialog open={openDialog} onClose={handleCloseDialog} maxWidth="md" fullWidth>
        <DialogTitle sx={{ bgcolor: RZD_COLORS.primary, color: 'white' }}>
          {editMode ? '✏️ Изменить камеру' : '➕ Добавить новую камеру'}
        </DialogTitle>
        <DialogContent sx={{ mt: 2 }}>
          <Tabs
            value={selectedTab}
            onChange={(_, v) => setSelectedTab(v)}
            sx={{ mb: 2 }}
          >
            <Tab label="📋 Основная информация" />
            <Tab label="📹 Потоки" />
            <Tab label="⏺️ Запись" />
            <Tab label="🔍 Проверка" />
          </Tabs>

          {/* Tab 0: Basic Info */}
          {selectedTab === 0 && (
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  label="Имя камеры"
                  placeholder={autoNamePreview}
                  value={formData.name}
                  onChange={(e) => handleInputChange('name', e.target.value)}
                  disabled={editMode}
                  error={!nameValidation.valid}
                  helperText={
                    nameValidation.error ||
                    (formData.name
                      ? ' '
                      : `Оставьте пустым для авто-имени: ${autoNamePreview}`)
                  }
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
                  error={!!formData.ip_adress && !ipValidation.valid}
                  helperText={
                    formData.ip_adress ? ipValidation.error : 'Формат: 192.168.1.10'
                  }
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  fullWidth
                  label="Порт"
                  value={formData.port}
                  onChange={(e) => handleInputChange('port', e.target.value)}
                  error={!portValidation.valid}
                  helperText={portValidation.error || ' '}
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
                  onChange={(e) =>
                    handleInputChange('main_sub', parseInt(e.target.value))
                  }
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  fullWidth
                  label="Задержка (мс)"
                  type="number"
                  value={formData.main_latency}
                  onChange={(e) =>
                    handleInputChange('main_latency', parseInt(e.target.value))
                  }
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  fullWidth
                  label="Переподключение (сек)"
                  type="number"
                  value={formData.main_reconnect}
                  onChange={(e) =>
                    handleInputChange('main_reconnect', parseInt(e.target.value))
                  }
                />
              </Grid>
              <Grid item xs={12}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={formData.main_use_udp}
                      onChange={(e) =>
                        handleInputChange('main_use_udp', e.target.checked)
                      }
                    />
                  }
                  label="Использовать UDP"
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
                  label="Подтип"
                  type="number"
                  value={formData.sub_sub}
                  onChange={(e) =>
                    handleInputChange('sub_sub', parseInt(e.target.value))
                  }
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  fullWidth
                  label="Задержка (мс)"
                  type="number"
                  value={formData.sub_latency}
                  onChange={(e) =>
                    handleInputChange('sub_latency', parseInt(e.target.value))
                  }
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  fullWidth
                  label="Переподключение (сек)"
                  type="number"
                  value={formData.sub_reconnect}
                  onChange={(e) =>
                    handleInputChange('sub_reconnect', parseInt(e.target.value))
                  }
                />
              </Grid>
              <Grid item xs={12}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={formData.sub_use_udp}
                      onChange={(e) =>
                        handleInputChange('sub_use_udp', e.target.checked)
                      }
                    />
                  }
                  label="Использовать UDP"
                />
              </Grid>
            </Grid>
          )}

          {/* Tab 2: Recording */}
          {selectedTab === 2 && (
            <Grid container spacing={2}>
              <Grid item xs={12}>
                <Paper
                  variant="outlined"
                  sx={{
                    p: 2,
                    bgcolor: formData.recording_enabled
                      ? 'rgba(229, 57, 53, 0.05)'
                      : 'transparent',
                    borderColor: formData.recording_enabled ? '#e53935' : undefined,
                  }}
                >
                  <FormControlLabel
                    control={
                      <Switch
                        checked={formData.recording_enabled}
                        onChange={(e) =>
                          handleInputChange('recording_enabled', e.target.checked)
                        }
                        color="error"
                      />
                    }
                    label={
                      <Box display="flex" alignItems="center" gap={1}>
                        <RecIcon
                          sx={{
                            color: formData.recording_enabled ? '#e53935' : 'grey.400',
                          }}
                        />
                        <Typography fontWeight="bold">
                          {formData.recording_enabled
                            ? 'Запись включена'
                            : 'Запись выключена'}
                        </Typography>
                      </Box>
                    }
                  />
                  <Typography variant="caption" color="text.secondary" display="block">
                    Запись ведётся только для основного потока в формате MP4
                  </Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  label="Длительность сегмента (минуты)"
                  type="number"
                  value={formData.main_segment}
                  onChange={(e) =>
                    handleInputChange('main_segment', parseInt(e.target.value) || 0)
                  }
                  disabled={!formData.recording_enabled}
                  inputProps={{ min: 1, max: 1440 }}
                  helperText={
                    formData.recording_enabled
                      ? 'Длина одного файла записи'
                      : 'Включите запись, чтобы настроить'
                  }
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  disabled
                  label="Местоположение записей"
                  value={`/home/orangepi/records/${
                    formData.name || autoNamePreview
                  }`}
                  helperText="Генерируется автоматически"
                />
              </Grid>
              {formData.recording_enabled && (
                <Grid item xs={12}>
                  <Typography variant="caption" color="text.secondary">
                    💾 Каждый сегмент длится {formData.main_segment} мин.
                    Файлы сохраняются в указанный каталог.
                  </Typography>
                </Grid>
              )}
            </Grid>
          )}

          {/* Tab 3: Probe / Preview */}
          {selectedTab === 3 && (
            <Stack spacing={2}>
              <Alert severity="info">
                Тест создаёт временное подключение к камере и показывает видео-превью.
                При закрытии окна или сохранении временные данные удаляются автоматически.
              </Alert>

              <Box display="flex" gap={1} alignItems="center">
                {probeStatus === 'idle' || probeStatus === 'error' ? (
                  <Button
                    variant="contained"
                    startIcon={<PlayIcon />}
                    onClick={handleTestStream}
                    disabled={!ipValidation.valid || !portValidation.valid}
                    sx={{ bgcolor: RZD_COLORS.primary }}
                  >
                    Тестировать поток
                  </Button>
                ) : (
                  <Button
                    variant="outlined"
                    color="error"
                    startIcon={<StopIcon />}
                    onClick={handleStopTest}
                  >
                    Остановить тест
                  </Button>
                )}

                {probeStatus === 'creating' && (
                  <Chip
                    icon={<CircularProgress size={14} />}
                    label="Подключение..."
                    color="info"
                    variant="outlined"
                  />
                )}
                {probeStatus === 'streaming' && (
                  <Chip
                    icon={<CheckIcon />}
                    label="Поток активен"
                    color="success"
                    variant="outlined"
                  />
                )}
                {probeStatus === 'error' && (
                  <Chip
                    icon={<ErrorIcon />}
                    label="Ошибка"
                    color="error"
                    variant="outlined"
                  />
                )}
              </Box>

              {probeError && <Alert severity="error">{probeError}</Alert>}

              <Box
                sx={{
                  width: '100%',
                  aspectRatio: '16 / 9',
                  bgcolor: '#000',
                  borderRadius: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                }}
              >
                {probeStatus === 'streaming' && probeName ? (
                  <WebRTCPlayer cameraName={probeName} />
                ) : probeStatus === 'creating' ? (
                  <Box textAlign="center" color="white">
                    <CircularProgress color="inherit" />
                    <Typography variant="body2" sx={{ mt: 2 }}>
                      Инициализация потока...
                    </Typography>
                  </Box>
                ) : (
                  <Typography color="grey.500">
                    Нажмите «Тестировать поток» для предпросмотра
                  </Typography>
                )}
              </Box>
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={handleCloseDialog} disabled={loading}>
            Отменить
          </Button>
          <Button
            variant="contained"
            onClick={handleSaveCamera}
            disabled={loading || !isFormValid}
            sx={{ bgcolor: RZD_COLORS.primary }}
          >
            {loading ? (
              <CircularProgress size={24} />
            ) : editMode ? (
              'Обновить'
            ) : (
              'Добавить'
            )}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};

export default CameraSettings;