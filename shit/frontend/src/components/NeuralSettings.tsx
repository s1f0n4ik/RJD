import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  Divider,
  FormControl,
  Grid,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Save as SaveIcon,
  PlayArrow as PlayIcon,
  Stop as StopIcon,
  RestartAlt as RestartIcon,
  UploadFile as UploadFileIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { RZD_COLORS } from '../theme';
import { api } from '../services/api';
import type {
  CPPCamera,
  NeuralConfigurationBody,
  NeuralConfigurationListItem,
  NeuralRuntimeStatusItem,
  NeuralStateItem,
} from '../types';

type ImportMode = 'слияние' | 'замена';

const defaultConfigBody = (): NeuralConfigurationBody => ({
  name: 'Новая конфигурация',
  draw_groups: true,
  model_path: '',
  model_width: 640,
  model_height: 640,
  thresholds: { nms: 0.45, confidence: 0.5 },
  superclasses: {},
  classes: {},
});

const NeuralSettings: React.FC = () => {
  const [tab, setTab] = useState(0);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Раздел 1: конфигурации
  const [configs, setConfigs] = useState<NeuralConfigurationListItem[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState<string>('');
  const [editConfigId, setEditConfigId] = useState<string>('');
  const [editConfig, setEditConfig] = useState<NeuralConfigurationBody | null>(null);

  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Раздел 2: state
  const [stateSlots, setStateSlots] = useState<NeuralStateItem[]>([]);
  const [cameras, setCameras] = useState<CPPCamera[]>([]);

  // Раздел 3: status
  const [statusItems, setStatusItems] = useState<NeuralRuntimeStatusItem[]>([]);

  const loadAll = async () => {
    setLoading(true);
    setError('');
    try {
      const [cfgList, st, stt, cams] = await Promise.all([
        api.getNeuralConfigurations(),
        api.getNeuralState(),
        api.getNeuralStatus(),
        api.getCameras(),
      ]);

      setConfigs(cfgList);
      setStateSlots(st);
      setStatusItems(stt);
      setCameras(cams.filter((c) => c.type === 2)); // только Neural-камеры

      if (!selectedConfigId && cfgList.length > 0) {
        setSelectedConfigId(cfgList[0].id);
      }
    } catch (e: any) {
      setError(e?.message || 'Ошибка загрузки данных');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const loadConfig = async () => {
      if (!selectedConfigId) return;
      try {
        const cfg = await api.getNeuralConfigurationById(selectedConfigId);
        setEditConfigId(selectedConfigId);
        setEditConfig(cfg);
      } catch (e: any) {
        setError(e?.message || 'Ошибка загрузки конфигурации');
      }
    };
    loadConfig();
  }, [selectedConfigId]);

  const usedCores = useMemo(() => {
    return stateSlots
      .map((s) => (Array.isArray(s.cores) ? s.cores[0] : s.cores))
      .filter((x): x is number => typeof x === 'number');
  }, [stateSlots]);

  const duplicateCoreError = useMemo(() => {
    const set = new Set<number>();
    for (const c of usedCores) {
      if (set.has(c)) return true;
      set.add(c);
    }
    return false;
  }, [usedCores]);

  const handleCreateNewConfig = () => {
    const id = `config_${Date.now()}`;
    setEditConfigId(id);
    setEditConfig(defaultConfigBody());
    setSelectedConfigId('');
  };

  const handleSaveConfigMerge = async () => {
    if (!editConfig || !editConfigId.trim()) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await api.postNeuralConfigurations('merge', {
        [editConfigId.trim()]: editConfig,
      });
      setSuccess('Конфигурация сохранена');
      await loadAll();
      setSelectedConfigId(editConfigId.trim());
    } catch (e: any) {
      setError(e?.message || 'Ошибка сохранения конфигурации');
    } finally {
      setSaving(false);
    }
  };

  const handleImportFile = async (file: File) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      await api.postNeuralConfigurations(importMode, parsed);
      setSuccess(`Импорт выполнен (${importMode})`);
      await loadAll();
    } catch (e: any) {
      setError(e?.message || 'Ошибка импорта JSON');
    } finally {
      setSaving(false);
    }
  };

  const addSuperclass = () => {
    if (!editConfig) return;
    const nextId = `group_${Date.now()}`;
    setEditConfig({
      ...editConfig,
      superclasses: {
        ...editConfig.superclasses,
        [nextId]: { name: 'Новая группа', color: '#4287f5' },
      },
    });
  };

  const removeSuperclass = (id: string) => {
    if (!editConfig) return;
    const usedBy = Object.entries(editConfig.classes).filter(
      ([, cls]) => cls.superclass === id
    );
    if (usedBy.length > 0) {
      if (
        !window.confirm(
          `Группа "${id}" используется в ${usedBy.length} класс(ах). Удалить всё равно?`
        )
      ) {
        return;
      }
    }
    const next = { ...editConfig.superclasses };
    delete next[id];
    setEditConfig({ ...editConfig, superclasses: next });
  };

  const addClass = () => {
    if (!editConfig) return;
    const nextId = String(Date.now());
    const firstGroup = Object.keys(editConfig.superclasses)[0] || '';
    setEditConfig({
      ...editConfig,
      classes: {
        ...editConfig.classes,
        [nextId]: {
          name: 'Новый класс',
          server_id: 'new_class',
          superclass: firstGroup,
          color: '#D82626',
        },
      },
    });
  };

  const removeClass = (id: string) => {
    if (!editConfig) return;
    const next = { ...editConfig.classes };
    delete next[id];
    setEditConfig({ ...editConfig, classes: next });
  };

  const addStateSlot = () => {
    setStateSlots((prev) => [
      ...prev,
      { config_id: '', camera_matrix: [['']], cores: [] },
    ]);
  };

  const saveState = async () => {
    if (duplicateCoreError) {
      setError('Одно и то же ядро назначено нескольким слотам');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      // normalize cores -> number[]
      const payload = stateSlots.map((s) => ({
        ...s,
        cores: Array.isArray(s.cores) ? s.cores : [s.cores as any].filter((x) => x !== undefined),
        camera_matrix:
          s.camera_matrix?.length && s.camera_matrix[0]?.length
            ? s.camera_matrix
            : [['']],
      }));
      await api.postNeuralState(payload);
      setSuccess('Save-state сохранён');
    } catch (e: any) {
      setError(e?.message || 'Ошибка сохранения save-state');
    } finally {
      setSaving(false);
    }
  };

  const refreshStatus = async () => {
    try {
      setStatusItems(await api.getNeuralStatus());
    } catch (e: any) {
      setError(e?.message || 'Ошибка загрузки статуса');
    }
  };

  const control = async (cmd: 'start' | 'stop' | 'restart') => {
    setSaving(true);
    setError('');
    try {
      if (cmd === 'start') await api.postNeuralStart();
      if (cmd === 'stop') await api.postNeuralStop();
      if (cmd === 'restart') await api.postNeuralRestart();
      await refreshStatus();
      setSuccess(`Команда ${cmd.toUpperCase()} выполнена`);
    } catch (e: any) {
      setError(e?.message || `Ошибка команды ${cmd}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Container maxWidth="xl">
      <Paper sx={{ p: 3, mb: 3, borderRadius: 1, border: `1px solid ${RZD_COLORS.grey[200]}` }}>
        <Typography variant="h5" fontWeight={700}>Конфигурация нейронок</Typography>
        <Typography variant="body2" color="text.secondary">
          Конфигурации • Установка • Состояние
        </Typography>
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>{success}</Alert>}

      <Paper sx={{ mb: 2 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab label="1. Конфигурации" />
          <Tab label="2. Установка" />
          <Tab label="3. Состояние" />
        </Tabs>
      </Paper>

      {/* РАЗДЕЛ 1 */}
      {tab === 0 && (
        <Grid container spacing={2}>
          <Grid item xs={12} md={3}>
            <Paper sx={{ p: 2 }}>
              <Stack spacing={1}>
                <Button startIcon={<RefreshIcon />} onClick={loadAll} disabled={loading}>Обновить</Button>
                <Button variant="contained" startIcon={<AddIcon />} onClick={handleCreateNewConfig}>Новая</Button>

                <FormControl size="small" fullWidth>
                  <InputLabel>Импорт</InputLabel>
                  <Select
                    label="Импорт"
                    value={importMode}
                    onChange={(e) => setImportMode(e.target.value as ImportMode)}
                  >
                    <MenuItem value="merge">слияние</MenuItem>
                    <MenuItem value="replace">замена</MenuItem>
                  </Select>
                </FormControl>

                <Button
                  startIcon={<UploadFileIcon />}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Импорт JSON
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleImportFile(f);
                    e.currentTarget.value = '';
                  }}
                />

                <Divider />
                {configs.map((c) => (
                  <Button
                    key={c.id}
                    variant={selectedConfigId === c.id ? 'contained' : 'outlined'}
                    onClick={() => setSelectedConfigId(c.id)}
                    sx={{ justifyContent: 'flex-start' }}
                  >
                    {c.name || c.id}
                  </Button>
                ))}
              </Stack>
            </Paper>
          </Grid>

          <Grid item xs={12} md={9}>
            <Paper sx={{ p: 2 }}>
              {!editConfig ? (
                <Typography color="text.secondary">Выберите конфигурацию или создайте новую</Typography>
              ) : (
                <Stack spacing={2}>
                  <Grid container spacing={2}>
                    <Grid item xs={12} sm={6}>
                      <TextField
                        fullWidth
                        label="ID конфигурации"
                        value={editConfigId}
                        onChange={(e) => setEditConfigId(e.target.value)}
                      />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField
                        fullWidth
                        label="Имя"
                        value={editConfig.name}
                        onChange={(e) => setEditConfig({ ...editConfig, name: e.target.value })}
                      />
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <TextField
                        fullWidth
                        type="number"
                        label="ширина"
                        value={editConfig.model_width}
                        onChange={(e) => setEditConfig({ ...editConfig, model_width: Number(e.target.value) || 0 })}
                      />
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <TextField
                        fullWidth
                        type="number"
                        label="высота"
                        value={editConfig.model_height}
                        onChange={(e) => setEditConfig({ ...editConfig, model_height: Number(e.target.value) || 0 })}
                      />
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <FormControl fullWidth>
                        <InputLabel>draw_groups</InputLabel>
                        <Select
                          label="отрисовка групп"
                          value={editConfig.draw_groups ? 'true' : 'false'}
                          onChange={(e) =>
                            setEditConfig({ ...editConfig, draw_groups: e.target.value === 'true' })
                          }
                        >
                          <MenuItem value="true">Да</MenuItem>
                          <MenuItem value="false">Нет</MenuItem>
                        </Select>
                      </FormControl>
                    </Grid>
                    <Grid item xs={12}>
                      <TextField
                        fullWidth
                        label="путь до модели"
                        value={editConfig.model_path}
                        onChange={(e) => setEditConfig({ ...editConfig, model_path: e.target.value })}
                      />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField
                        fullWidth type="number" label="threshold nms"
                        value={editConfig.thresholds.nms}
                        onChange={(e) =>
                          setEditConfig({
                            ...editConfig,
                            thresholds: { ...editConfig.thresholds, nms: Number(e.target.value) || 0 },
                          })
                        }
                      />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField
                        fullWidth type="number" label="threshold confidence"
                        value={editConfig.thresholds.confidence}
                        onChange={(e) =>
                          setEditConfig({
                            ...editConfig,
                            thresholds: { ...editConfig.thresholds, confidence: Number(e.target.value) || 0 },
                          })
                        }
                      />
                    </Grid>
                  </Grid>

                  <Divider />
                  <Box display="flex" justifyContent="space-between" alignItems="center">
                    <Typography variant="h6">Супер-классы</Typography>
                    <Button startIcon={<AddIcon />} onClick={addSuperclass}>Добавить группу</Button>
                  </Box>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>ID</TableCell>
                        <TableCell>Имя</TableCell>
                        <TableCell>Цвет</TableCell>
                        <TableCell width={60} />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {Object.entries(editConfig.superclasses).map(([id, sc]) => (
                        <TableRow key={id}>
                          <TableCell>{id}</TableCell>
                          <TableCell>
                            <TextField
                              fullWidth size="small"
                              value={sc.name}
                              onChange={(e) =>
                                setEditConfig({
                                  ...editConfig,
                                  superclasses: {
                                    ...editConfig.superclasses,
                                    [id]: { ...sc, name: e.target.value },
                                  },
                                })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <TextField
                              fullWidth size="small"
                              value={sc.color}
                              onChange={(e) =>
                                setEditConfig({
                                  ...editConfig,
                                  superclasses: {
                                    ...editConfig.superclasses,
                                    [id]: { ...sc, color: e.target.value },
                                  },
                                })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <IconButton color="error" onClick={() => removeSuperclass(id)}>
                              <DeleteIcon />
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>

                  <Divider />
                  <Box display="flex" justifyContent="space-between" alignItems="center">
                    <Typography variant="h6">Классы</Typography>
                    <Button startIcon={<AddIcon />} onClick={addClass}>Добавить класс</Button>
                  </Box>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>ID</TableCell>
                        <TableCell>Имя</TableCell>
                        <TableCell>ID_сервера</TableCell>
                        <TableCell>Супер-класс</TableCell>
                        <TableCell>Цвет</TableCell>
                        <TableCell width={60} />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {Object.entries(editConfig.classes).map(([id, cls]) => (
                        <TableRow key={id}>
                          <TableCell>{id}</TableCell>
                          <TableCell>
                            <TextField
                              fullWidth size="small"
                              value={cls.name}
                              onChange={(e) =>
                                setEditConfig({
                                  ...editConfig,
                                  classes: {
                                    ...editConfig.classes,
                                    [id]: { ...cls, name: e.target.value },
                                  },
                                })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <TextField
                              fullWidth size="small"
                              value={cls.server_id}
                              onChange={(e) =>
                                setEditConfig({
                                  ...editConfig,
                                  classes: {
                                    ...editConfig.classes,
                                    [id]: { ...cls, server_id: e.target.value },
                                  },
                                })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <FormControl fullWidth size="small">
                              <Select
                                value={cls.superclass}
                                onChange={(e) =>
                                  setEditConfig({
                                    ...editConfig,
                                    classes: {
                                      ...editConfig.classes,
                                      [id]: { ...cls, superclass: e.target.value },
                                    },
                                  })
                                }
                              >
                                {Object.keys(editConfig.superclasses).map((scid) => (
                                  <MenuItem key={scid} value={scid}>{scid}</MenuItem>
                                ))}
                              </Select>
                            </FormControl>
                          </TableCell>
                          <TableCell>
                            <TextField
                              fullWidth size="small"
                              value={cls.color}
                              onChange={(e) =>
                                setEditConfig({
                                  ...editConfig,
                                  classes: {
                                    ...editConfig.classes,
                                    [id]: { ...cls, color: e.target.value },
                                  },
                                })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <IconButton color="error" onClick={() => removeClass(id)}>
                              <DeleteIcon />
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>

                  <Box>
                    <Button
                      variant="contained"
                      startIcon={<SaveIcon />}
                      onClick={handleSaveConfigMerge}
                      disabled={saving}
                      sx={{ bgcolor: RZD_COLORS.primary }}
                    >
                      Сохранить
                    </Button>
                  </Box>
                </Stack>
              )}
            </Paper>
          </Grid>
        </Grid>
      )}

      {/* РАЗДЕЛ 2 */}
      {tab === 1 && (
        <Paper sx={{ p: 2 }}>
          <Box mb={2} display="flex" justifyContent="space-between">
            <Typography variant="h6">Слоты состояний</Typography>
            <Button startIcon={<AddIcon />} onClick={addStateSlot}>Добавить слот</Button>
          </Box>

          {duplicateCoreError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              Дублирование ядер недопустимо: одно ядро может использоваться только одним слотом.
            </Alert>
          )}

          <Stack spacing={2}>
            {stateSlots.map((slot, idx) => {
              const coreValue = Array.isArray(slot.cores) ? slot.cores[0] : (slot.cores as any);
              const cameraValue = slot.camera_matrix?.[0]?.[0] ?? '';
              return (
                <Paper key={idx} variant="outlined" sx={{ p: 2 }}>
                  <Grid container spacing={2} alignItems="center">
                    <Grid item xs={12} md={4}>
                      <FormControl fullWidth size="small">
                        <InputLabel>Конфигурация</InputLabel>
                        <Select
                          label="Конфигурация"
                          value={slot.config_id}
                          onChange={(e) =>
                            setStateSlots((prev) =>
                              prev.map((s, i) => (i === idx ? { ...s, config_id: e.target.value } : s))
                            )
                          }
                        >
                          {configs.map((c) => (
                            <MenuItem key={c.id} value={c.id}>{c.name || c.id}</MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    </Grid>

                    <Grid item xs={12} md={2}>
                      <FormControl fullWidth size="small">
                        <InputLabel>Ядро</InputLabel>
                        <Select
                          label="Ядро"
                          value={coreValue ?? ''}
                          onChange={(e) =>
                            setStateSlots((prev) =>
                              prev.map((s, i) =>
                                i === idx ? { ...s, cores: [Number(e.target.value)] } : s
                              )
                            )
                          }
                        >
                          {[0, 1, 2].map((core) => (
                            <MenuItem key={core} value={core}>
                              {core}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    </Grid>

                    <Grid item xs={12} md={5}>
                      <FormControl fullWidth size="small">
                        <InputLabel>Камера (type=2)</InputLabel>
                        <Select
                          label="Камера (type=2)"
                          value={cameraValue}
                          onChange={(e) =>
                            setStateSlots((prev) =>
                              prev.map((s, i) =>
                                i === idx ? { ...s, camera_matrix: [[e.target.value]] } : s
                              )
                            )
                          }
                        >
                          {cameras.map((c) => (
                            <MenuItem key={c.id} value={c.id}>
                              {c.display_name || c.id}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    </Grid>

                    <Grid item xs={12} md={1}>
                      <IconButton
                        color="error"
                        onClick={() =>
                          setStateSlots((prev) => prev.filter((_, i) => i !== idx))
                        }
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Grid>
                  </Grid>
                </Paper>
              );
            })}
          </Stack>

          <Box mt={2}>
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              onClick={saveState}
              disabled={saving || duplicateCoreError}
              sx={{ bgcolor: RZD_COLORS.primary }}
            >
              Сохранить состояние
            </Button>
          </Box>
        </Paper>
      )}

      {/* РАЗДЕЛ 3 */}
      {tab === 2 && (
        <Paper sx={{ p: 2 }}>
          <Box mb={2} display="flex" gap={1} flexWrap="wrap">
            <Button variant="contained" color="success" startIcon={<PlayIcon />} onClick={() => control('start')} disabled={saving}>
              Старт
            </Button>
            <Button variant="contained" color="error" startIcon={<StopIcon />} onClick={() => control('stop')} disabled={saving}>
              Стоп
            </Button>
            <Button variant="contained" color="warning" startIcon={<RestartIcon />} onClick={() => control('restart')} disabled={saving}>
              Рестарт
            </Button>
            <Button startIcon={<RefreshIcon />} onClick={refreshStatus}>Обновить статус</Button>
          </Box>

          <Table>
            <TableHead>
              <TableRow>
                <TableCell>ID Конфигурации</TableCell>
                <TableCell>Ядра</TableCell>
                <TableCell>Камеры</TableCell>
                <TableCell>Статус</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {statusItems.map((row, idx) => (
                <TableRow key={`${row.config_id}-${idx}`}>
                  <TableCell>{row.config_id}</TableCell>
                  <TableCell>{Array.isArray(row.cores) ? row.cores.join(', ') : String(row.cores)}</TableCell>
                  <TableCell>
                    {(row.camera_matrix || []).flat().map((cam) => (
                      <Chip key={cam} label={cam} size="small" sx={{ mr: 0.5 }} />
                    ))}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      color={row.running ? 'success' : 'default'}
                      label={row.running ? 'running' : 'stopped'}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}
    </Container>
  );
};

export default NeuralSettings;