import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
    Container, Paper, Typography, Box, Button, Table, TableBody, TableCell,
    TableContainer, TableHead, TableRow, IconButton, Chip, Alert, Dialog,
    DialogTitle, DialogContent, DialogActions, TextField, Grid, FormControl,
    InputLabel, Select, MenuItem, FormControlLabel, Switch, Tabs, Tab,
    Divider, CircularProgress, Stack, Stepper, Step, StepLabel,
} from '@mui/material';
import {
    Add as AddIcon, Delete as DeleteIcon, Edit as EditIcon,
    Settings as SettingsIcon, Videocam as VideocamIcon,
    FiberManualRecord as RecIcon, PlayArrow as PlayIcon, Stop as StopIcon,
    CheckCircle as CheckIcon, Error as ErrorIcon,
    ArrowBack as ArrowBackIcon, ArrowForward as ArrowForwardIcon,
    Save as SaveIcon,
} from '@mui/icons-material';
import { RZD_COLORS } from '../theme';
import { wsUrl } from '../utils/constants';
import { type CPPCamera} from '../types'
import { api, MediaCenterError, type CameraPatchBody } from '../services/api';
import WebRTCPlayer from './WebRTCPlayer';

// Используем CPPCamera из api как основной тип камеры
type Camera = CPPCamera;

interface CameraFormData {
    id: string;
    display_name: string;
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
    to_record: boolean;
}

type ProbeStatus = 'idle' | 'creating' | 'streaming' | 'error';

const RESERVED_PREFIXES = ['__probe_'];
const NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_-]{1,31}$/;
const IP_REGEX = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

const IP_POOL_PREFIX = '192.168.1.';
const IP_POOL_FROM = 11;
const IP_POOL_TO = 39;

const buildIpPool = (): string[] => {
    const arr: string[] = [];
    for (let i = IP_POOL_FROM; i <= IP_POOL_TO; i++) {
        arr.push(`${IP_POOL_PREFIX}${i}`);
    }
    return arr;
};

const DEFAULT_FORM: CameraFormData = {
    id: '',
    display_name: '',
    description: 'Test Camera',
    ip_adress: '',
    port: '554',
    user: 'admin',
    password: 'VniiTest',
    production: 2,
    type: 1,
    main_sub: 1,
    main_latency: 0,
    main_use_udp: false,
    main_reconnect: 10,
    main_segment: 10,
    sub_sub: 2,
    sub_latency: 0,
    sub_use_udp: false,
    sub_reconnect: 10,
    to_record: true,
};

const findNextFreeCameraId = (cameras: Camera[]): string => {
    const usedNumbers = new Set<number>();
    const re = /^camera_(\d+)$/;
    for (const c of cameras) {
        const m = c.id.match(re);
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

const validateCameraName = (name: string, existingNames: string[], editMode: boolean): NameValidation => {
    if (!name) return { valid: true };
    if (RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
        return { valid: false, error: 'Этот префикс зарезервирован системой' };
    }
    if (!NAME_REGEX.test(name)) {
        return { valid: false, error: 'Только латиница, цифры, _ и -. Длина 2–32, не начинается с цифры' };
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

/** Единое место форматирования ошибок для UI. */
const formatError = (err: unknown): string => {
    if (err instanceof MediaCenterError) return err.message;
    if (err instanceof Error) return err.message;
    return String(err);
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

    const [probeStatus, setProbeStatus] = useState<ProbeStatus>('idle');
    const [probeError, setProbeError] = useState('');
    const [probeName, setProbeName] = useState<string | null>(null);
    const probeNameRef = useRef<string | null>(null);
    const editOriginalRef = useRef<Camera | null>(null);

    useEffect(() => {
        loadCameras();
    }, []);

    // === cleanup probe на beforeunload ===
    // Тут оставляем прямой fetch — нам нужен флаг keepalive,
    // которого нет в нашей обёртке. И тут ошибки нас не интересуют.
    useEffect(() => {
        const handler = () => {
            if (probeNameRef.current) {
                fetch(`/api/camera/${encodeURIComponent(probeNameRef.current)}`, {
                    method: 'DELETE',
                    keepalive: true,
                }).catch(() => {});
            }
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, []);

    const existingNames = useMemo(() => cameras.map((c) => c.id), [cameras]);
    const usedIps = useMemo(
        () => new Set(
            cameras
                .filter(c => !editMode || c.id !== editOriginalRef.current?.id)
                .map(c => c.ip_adress)
        ),
        [cameras, editMode]
    );
    const ipPool = useMemo(() => buildIpPool(), []);

    const nameValidation = useMemo(
        () => validateCameraName(formData.id, existingNames, editMode),
        [formData.id, existingNames, editMode]
    );
    const ipValidation = useMemo(() => validateIp(formData.ip_adress), [formData.ip_adress]);
    const portValidation = useMemo(() => validatePort(formData.port), [formData.port]);

    const isFormValid = nameValidation.valid && ipValidation.valid && portValidation.valid;

    const cleanupAllProbeCameras = useCallback(async (probes: Camera[]) => {
        if (probes.length === 0) return;
        console.log(`[CameraSettings] 🧹 Cleaning ${probes.length} stale probes`);
        await Promise.allSettled(probes.map((c) => api.deleteCamera(c.id)));
    }, []);

    const loadCameras = async () => {
        setLoading(true);
        try {
            const all = await api.getCameras();

            // Удаляем зависшие probe-камеры (фоном, не ждём)
            const stale = all.filter(
                (c) =>
                    RESERVED_PREFIXES.some((p) => c.id.startsWith(p)) &&
                    c.id !== probeNameRef.current
            );
            if (stale.length > 0) cleanupAllProbeCameras(stale);

            // В UI — только обычные камеры
            const visible = all.filter(
                (c) => !RESERVED_PREFIXES.some((p) => c.id.startsWith(p))
            );
            setCameras(visible);
            setError('');
        } catch (err) {
            setError(formatError(err));
        } finally {
            setLoading(false);
        }
    };

    const handleInputChange = (field: keyof CameraFormData, value: any) => {
        setFormData((prev) => ({ ...prev, [field]: value }));
    };

    const handleOpenAddDialog = () => {
        setEditMode(false);
        setFormData({ ...DEFAULT_FORM });
        setSelectedTab(0);
        setOpenDialog(true);
    };

    const handleOpenEditDialog = (camera: Camera) => {
        setEditMode(true);
        setFormData({
            id: camera.id,
            display_name: camera.display_name || camera.id,
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
            to_record: camera.streams.main.to_record,
        });
        editOriginalRef.current = camera;
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
            await api.deleteCamera(name);
        } catch {
            /* тихо */
        }
    }, []);

    const handleTestStream = async () => {
        if (!ipValidation.valid || !portValidation.valid) {
            setProbeError('Заполните корректные IP и порт');
            setProbeStatus('error');
            return;
        }

        await cleanupProbe();

        setProbeError('');
        setProbeStatus('creating');

        const tempName = `__probe_${Date.now()}`;
        const probePayload: any = {
            id: tempName,
            display_name: `Probe ${formData.ip_adress}`,
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
                    record_path: '/storage/internal',
                    segment: 0,
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
            await api.createCamera(probePayload);
            probeNameRef.current = tempName;
            setProbeName(tempName);
            setTimeout(() => setProbeStatus('streaming'), 1500);
        } catch (err) {
            setProbeError(formatError(err));
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

        const cameraId = formData.id || findNextFreeCameraId(cameras);
        const recordPath = '/storage/internal';

        try {
            if (editMode) {
                const original = editOriginalRef.current;
                if (!original) throw new Error('Нет исходных данных камеры для PATCH');

                const body: CameraPatchBody = {};

                if (formData.display_name !== original.display_name) {
                    body.meta = { display_name: formData.display_name };
                }

                const passwordChanged = !!formData.password;
                const otherCriticalChanged =
                    formData.ip_adress !== original.ip_adress ||
                    formData.port !== original.port ||
                    formData.user !== original.user ||
                    formData.production !== original.production ||
                    formData.type !== original.type ||
                    formData.main_sub !== original.streams.main.sub ||
                    formData.main_latency !== original.streams.main.latency ||
                    formData.main_use_udp !== original.streams.main.use_udp ||
                    formData.main_reconnect !== original.streams.main.reconnect ||
                    formData.sub_sub !== original.streams.sub.sub ||
                    formData.sub_latency !== original.streams.sub.latency ||
                    formData.sub_use_udp !== original.streams.sub.use_udp ||
                    formData.sub_reconnect !== original.streams.sub.reconnect ||
                    formData.main_segment !== original.streams.main.segment ||
                    formData.to_record !== original.streams.main.to_record ||
                    recordPath !== original.streams.main.record_path;

                if (passwordChanged || otherCriticalChanged) {
                    const critical: any = {
                        ip_adress: formData.ip_adress,
                        port: formData.port,
                        user: formData.user,
                        production: formData.production,
                        type: formData.type,
                        streams: {
                            main: {
                                sub: formData.main_sub,
                                type: 1,
                                latency: formData.main_latency,
                                use_udp: formData.main_use_udp,
                                reconnect: formData.main_reconnect,
                                record_path: recordPath,
                                segment: formData.main_segment,
                                to_record: formData.to_record
                            },
                            sub: {
                                sub: formData.sub_sub,
                                type: 2,
                                latency: formData.sub_latency,
                                use_udp: formData.sub_use_udp,
                                reconnect: formData.sub_reconnect,
                                record_path: '',
                                segment: 0,
                                to_record: false,
                            },
                        },
                    };
                    // Пароль шлём ТОЛЬКО при реальной смене (договорённость с Ваней 05.05)
                    if (formData.password) critical.password = formData.password;
                    body.critical = critical;
                }

                const result = await api.updateCamera(cameraId, body);
                if ((result as any)?.noop) {
                    setSuccess('Изменений нет');
                } else {
                    setSuccess(`Камера ${cameraId} успешно обновлена!`);
                }
            } else {
                const payload: any = {
                    id: cameraId,
                    display_name: formData.display_name || cameraId,
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
                            to_record: formData.to_record
                        },
                        sub: {
                            type: 2,
                            sub: formData.sub_sub,
                            latency: formData.sub_latency,
                            use_udp: formData.sub_use_udp,
                            reconnect: formData.sub_reconnect,
                            record_path: '',
                            segment: 0,
                            to_record: false,
                        },
                    },
                };
                await api.createCamera(payload);
                setSuccess(`Камера ${cameraId} успешно добавлена!`);
            }

            await cleanupProbe();
            setProbeStatus('idle');
            setOpenDialog(false);
            loadCameras();
        } catch (err) {
            setError(formatError(err));
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

    const handleDeleteCamera = async (id: string) => {
        if (!window.confirm(`Удалить камеру ${id}?`)) return;
        setLoading(true);
        try {
            await api.deleteCamera(id);
            setSuccess(`Камера ${id} удалена`);
            loadCameras();
        } catch (err) {
            setError(formatError(err));
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
        const map: Record<number, string> = {
            0: 'Отсутствует', 1: 'Готов', 2: 'Остановлен',
            3: 'В работе', 4: 'Перезапуск', 5: 'Инициализирован',
        };
        return map[status ?? 0] || 'Неизвестно';
    };

    const getProductionName = (prod: number) => {
        const map: Record<number, string> = { 1: 'Dahua', 2: 'Hikvision', 3: 'ACE' };
        return map[prod] || 'Unknown';
    };

    const autoNamePreview = useMemo(() => findNextFreeCameraId(cameras), [cameras]);

    const [activeStep, setActiveStep] = useState(0);
    const STEPS = ['Подключение', 'Параметры потоков', 'Запись', 'Подтверждение'];
    const isLastStep = activeStep === STEPS.length - 1;

    // Сброс шага при открытии/закрытии диалога
    useEffect(() => {
        if (openDialog) setActiveStep(0);
    }, [openDialog]);

    // Автозапуск превью на шаге подтверждения
    useEffect(() => {
        if (!openDialog) return;
        if (activeStep === STEPS.length - 1) {
            // входим на шаг подтверждения — запускаем probe, если данные валидны
            if (ipValidation.valid && portValidation.valid && probeStatus === 'idle') {
                handleTestStream();
            }
        } else {
            // уходим со шага подтверждения — гасим probe
            if (probeStatus !== 'idle') {
                handleStopTest();
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeStep, openDialog]);

    // Можно ли уйти со шага вперёд
    const canGoNext = useMemo(() => {
        if (activeStep === 0) return isFormValid;       // основные поля валидны
        return true;                                     // на остальных шагах нет блокирующих проверок
    }, [activeStep, isFormValid]);

    return (
        <Container maxWidth="xl">
            {/* Header */}
            <Paper
                sx={{
                    p: 3, mb: 3,
                    borderRadius: 1,
                    border: `1px solid ${RZD_COLORS.grey[200]}`,
                }}
            >
                <Box display="flex" justifyContent="space-between" alignItems="center">
                    <Box display="flex" alignItems="center" gap={2}>
                        <SettingsIcon sx={{ fontSize: 36, color: RZD_COLORS.primary }} />
                        <Box>
                            <Typography variant="h5" fontWeight={700} sx={{ letterSpacing: '-0.01em' }}>
                                Настройки камер
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                Подключено устройств: {cameras.length}
                            </Typography>
                        </Box>
                    </Box>
                    <Button
                        variant="contained"
                        startIcon={<AddIcon />}
                        onClick={handleOpenAddDialog}
                        sx={{ bgcolor: RZD_COLORS.primary, borderRadius: 1 }}
                    >
                        Добавить камеру
                    </Button>
                </Box>
            </Paper>

            {error && (
                <Alert severity="error" sx={{ mb: 2, borderRadius: 1 }} onClose={() => setError('')}>
                    {error}
                </Alert>
            )}
            {success && (
                <Alert severity="success" sx={{ mb: 2, borderRadius: 1 }} onClose={() => setSuccess('')}>
                    {success}
                </Alert>
            )}

            {/* Table — оставляем как есть */}
            <TableContainer component={Paper} sx={{ borderRadius: 1 }}>
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
                                const recOn = (camera.streams?.main?.segment ?? 0) > 0 &&
                                    (camera.streams?.main?.record_path ?? "") !== "";
                                return (
                                    <TableRow key={camera.id} hover>
                                        <TableCell>
                                            <Box display="flex" alignItems="center" gap={1}>
                                                <VideocamIcon sx={{ color: RZD_COLORS.primary, fontSize: 20 }} />
                                                <Typography variant="body2" fontWeight={600} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                                    #{index + 1}
                                                </Typography>
                                            </Box>
                                        </TableCell>
                                        <TableCell sx={{ fontFamily: 'monospace' }}>{camera.ip_adress}</TableCell>
                                        <TableCell sx={{ fontFamily: 'monospace' }}>{camera.port}</TableCell>
                                        <TableCell>{getProductionName(camera.production)}</TableCell>
                                        <TableCell>
                                            <Typography variant="body2" fontWeight={600}>
                                                {camera.display_name || camera.id}
                                            </Typography>
                                            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                                                {camera.id} • {camera.description}
                                            </Typography>
                                        </TableCell>
                                        <TableCell>
                                            {recOn ? (
                                                <Chip
                                                    icon={<RecIcon sx={{ color: '#e53935 !important' }} />}
                                                    label={`REC ${camera.streams.main.segment}мин`}
                                                    size="small"
                                                    variant="outlined"
                                                    sx={{ borderColor: '#e53935', color: '#e53935', borderRadius: 1 }}
                                                />
                                            ) : (
                                                <Chip label="Выкл" size="small" variant="outlined" sx={{ borderRadius: 1 }} />
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            <Chip
                                                label={getStatusText(camera.streams?.main?.status)}
                                                color={getStatusColor(camera.streams?.main?.status)}
                                                size="small"
                                                sx={{ borderRadius: 1 }}
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
                                                onClick={() => handleDeleteCamera(camera.id)}
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

            {/* Add/Edit Dialog — пошаговая форма */}
            <Dialog
                open={openDialog}
                onClose={handleCloseDialog}
                maxWidth="md"
                fullWidth
                PaperProps={{ sx: { borderRadius: 1 } }}
            >
                <DialogTitle
                    sx={{
                        bgcolor: RZD_COLORS.primary,
                        color: 'white',
                        py: 1.25,                          // меньше вертикали
                        fontSize: '1rem',                  // меньше шрифт
                        letterSpacing: '0.02em',
                    }}
                >
                    {editMode ? 'Изменить камеру' : 'Добавить камеру'}
                    {editMode && (
                        <Typography
                            component="span"
                            variant="caption"
                            sx={{ ml: 1, opacity: 0.85, fontFamily: 'monospace' }}
                        >
                            {formData.id}
                        </Typography>
                    )}
                </DialogTitle>

                <DialogContent sx={{ p: 0 }}>
                    {/* Stepper */}
                    <Box sx={{ px: 3, py: 2, borderBottom: `1px solid ${RZD_COLORS.grey[200]}` }}>
                        <Stepper activeStep={activeStep}>
                            {STEPS.map((label) => (
                                <Step key={label}>
                                    <StepLabel
                                        sx={{
                                            '& .MuiStepLabel-label': { fontSize: '0.8rem' },
                                        }}
                                    >
                                        {label}
                                    </StepLabel>
                                </Step>
                            ))}
                        </Stepper>
                    </Box>

                    {/* Slide-контейнер */}
                    <Box sx={{ overflow: 'hidden', position: 'relative' }}>
                        <Box
                            sx={{
                                display: 'flex',
                                width: `${STEPS.length * 100}%`,
                                transform: `translateX(-${activeStep * (100 / STEPS.length)}%)`,
                                transition: 'transform 0.35s ease',
                            }}
                        >
                            {/* === Шаг 1: Подключение === */}
                            <Box sx={{ width: `${100 / STEPS.length}%`, flexShrink: 0, p: 3 }}>
                                <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 2.5 }}>
                                    Параметры подключения
                                </Typography>

                                <Grid container spacing={2}>
                                    <Grid item xs={12} sm={6}>
                                        <TextField
                                            fullWidth
                                            label="Отображаемое имя"
                                            placeholder={autoNamePreview}
                                            value={formData.display_name}
                                            onChange={(e) => handleInputChange('display_name', e.target.value)}
                                            error={!nameValidation.valid}
                                            helperText={
                                                nameValidation.error ||
                                                (formData.id ? ' ' : `По умолчанию: ${autoNamePreview}`)
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
                                        <FormControl
                                            fullWidth required
                                            error={!!formData.ip_adress && !ipValidation.valid}
                                        >
                                            <InputLabel id="ip-select-label">IP-адрес</InputLabel>
                                            <Select
                                                labelId="ip-select-label"
                                                label="IP-адрес"
                                                value={formData.ip_adress}
                                                onChange={(e) => handleInputChange('ip_adress', e.target.value)}
                                                sx={{ fontFamily: 'monospace' }}
                                            >
                                                <MenuItem value="">
                                                    <em>— не выбран —</em>
                                                </MenuItem>
                                                {ipPool.map(ip => {
                                                    const taken = usedIps.has(ip);
                                                    return (
                                                        <MenuItem
                                                            key={ip} value={ip} disabled={taken}
                                                            sx={{ fontFamily: 'monospace' }}
                                                        >
                                                            {ip}{taken ? ' — занят' : ''}
                                                        </MenuItem>
                                                    );
                                                })}
                                            </Select>
                                            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, ml: 1.5 }}>
                                                Пул: {IP_POOL_PREFIX}{IP_POOL_FROM}–{IP_POOL_TO}
                                            </Typography>
                                        </FormControl>
                                    </Grid>
                                    <Grid item xs={12} sm={4}>
                                        <TextField
                                            fullWidth
                                            label="Порт"
                                            value={formData.port}
                                            onChange={(e) => handleInputChange('port', e.target.value)}
                                            error={!portValidation.valid}
                                            helperText={portValidation.error || ' '}
                                            InputProps={{ sx: { fontFamily: 'monospace' } }}
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
                                            helperText={
                                                editMode ? 'Оставьте пустым, чтобы сохранить текущий' : ' '
                                            }
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
                            </Box>

                            {/* === Шаг 2: Параметры потоков === */}
                            <Box sx={{ width: `${100 / STEPS.length}%`, flexShrink: 0, p: 3 }}>
                                <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 2.5 }}>
                                    Параметры потоков
                                </Typography>

                                <Grid container spacing={2}>
                                    {/* Главный поток */}
                                    <Grid item xs={12}>
                                        <Box display="flex" alignItems="center" gap={1} mb={1}>
                                            <Box sx={{ width: 4, height: 16, bgcolor: RZD_COLORS.primary }} />
                                            <Typography variant="subtitle2" fontWeight={700}>
                                                Главный поток
                                            </Typography>
                                        </Box>
                                    </Grid>
                                    <Grid item xs={12} sm={4}>
                                        <TextField
                                            fullWidth label="Подтип" type="number"
                                            value={formData.main_sub}
                                            onChange={(e) => handleInputChange('main_sub', parseInt(e.target.value))}
                                            InputProps={{ sx: { fontFamily: 'monospace' } }}
                                        />
                                    </Grid>
                                    <Grid item xs={12} sm={4}>
                                        <TextField
                                            fullWidth label="Задержка, мс" type="number"
                                            value={formData.main_latency}
                                            onChange={(e) => handleInputChange('main_latency', parseInt(e.target.value))}
                                            InputProps={{ sx: { fontFamily: 'monospace' } }}
                                        />
                                    </Grid>
                                    <Grid item xs={12} sm={4}>
                                        <TextField
                                            fullWidth label="Переподключение, сек" type="number"
                                            value={formData.main_reconnect}
                                            onChange={(e) => handleInputChange('main_reconnect', parseInt(e.target.value))}
                                            InputProps={{ sx: { fontFamily: 'monospace' } }}
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
                                            label="Использовать UDP-транспорт"
                                        />
                                    </Grid>

                                    {/* Второй поток */}
                                    <Grid item xs={12}>
                                        <Box display="flex" alignItems="center" gap={1} mt={2} mb={1}>
                                            <Box sx={{ width: 4, height: 16, bgcolor: RZD_COLORS.secondary }} />
                                            <Typography variant="subtitle2" fontWeight={700}>
                                                Второй поток
                                            </Typography>
                                        </Box>
                                    </Grid>
                                    <Grid item xs={12} sm={4}>
                                        <TextField
                                            fullWidth label="Подтип" type="number"
                                            value={formData.sub_sub}
                                            onChange={(e) => handleInputChange('sub_sub', parseInt(e.target.value))}
                                            InputProps={{ sx: { fontFamily: 'monospace' } }}
                                        />
                                    </Grid>
                                    <Grid item xs={12} sm={4}>
                                        <TextField
                                            fullWidth label="Задержка, мс" type="number"
                                            value={formData.sub_latency}
                                            onChange={(e) => handleInputChange('sub_latency', parseInt(e.target.value))}
                                            InputProps={{ sx: { fontFamily: 'monospace' } }}
                                        />
                                    </Grid>
                                    <Grid item xs={12} sm={4}>
                                        <TextField
                                            fullWidth label="Переподключение, сек" type="number"
                                            value={formData.sub_reconnect}
                                            onChange={(e) => handleInputChange('sub_reconnect', parseInt(e.target.value))}
                                            InputProps={{ sx: { fontFamily: 'monospace' } }}
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
                                            label="Использовать UDP-транспорт"
                                        />
                                    </Grid>
                                </Grid>
                            </Box>

                            {/* === Шаг 3: Запись === */}
                            <Box sx={{ width: `${100 / STEPS.length}%`, flexShrink: 0, p: 3 }}>
                                <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 2.5 }}>
                                    Параметры записи
                                </Typography>

                                <Box
                                    sx={{
                                        p: 2.5,
                                        border: `1px solid ${formData.to_record ? '#e53935' : RZD_COLORS.grey[300]}`,
                                        borderRadius: 1,
                                        bgcolor: formData.to_record ? 'rgba(229, 57, 53, 0.04)' : 'transparent',
                                        mb: 3,
                                        transition: 'all 0.2s',
                                    }}
                                >
                                    <FormControlLabel
                                        control={
                                            <Switch
                                                checked={formData.to_record}
                                                onChange={(e) => handleInputChange('to_record', e.target.checked)}
                                                color="error"
                                            />
                                        }
                                        label={
                                            <Typography fontWeight={600}>
                                                {formData.to_record ? 'Запись включена' : 'Запись выключена'}
                                            </Typography>
                                        }
                                    />
                                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                                        Запись ведётся только для основного потока в формате MP4
                                    </Typography>
                                </Box>

                                <Grid container spacing={2}>
                                    <Grid item xs={12} sm={6}>
                                        <TextField
                                            fullWidth
                                            label="Длительность сегмента, мин"
                                            type="number"
                                            value={formData.main_segment}
                                            onChange={(e) => handleInputChange('main_segment', parseInt(e.target.value) || 0)}
                                            disabled={!formData.to_record}
                                            inputProps={{ min: 1, max: 1440 }}
                                            InputProps={{ sx: { fontFamily: 'monospace' } }}
                                            helperText={
                                                formData.to_record ? 'Длина одного файла записи' : 'Включите запись, чтобы настроить'
                                            }
                                        />
                                    </Grid>
                                    <Grid item xs={12} sm={6}>
                                        <TextField
                                            fullWidth
                                            disabled
                                            label="Каталог записей"
                                            value="/storage/internal"
                                            InputProps={{ sx: { fontFamily: 'monospace' } }}
                                            helperText="Генерируется автоматически"
                                        />
                                    </Grid>
                                </Grid>
                            </Box>

                            {/* === Шаг 4: Подтверждение === */}
                            <Box sx={{ width: `${100 / STEPS.length}%`, flexShrink: 0, p: 3 }}>
                                <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 2.5 }}>
                                    Подтверждение
                                </Typography>

                                <Grid container spacing={2}>
                                    {/* Превью потока */}
                                    <Grid item xs={12} sm={6}>
                                        <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
                                            <Typography variant="subtitle2" fontWeight={600}>
                                                Предпросмотр
                                            </Typography>
                                            {probeStatus === 'creating' && (
                                                <Chip
                                                    icon={<CircularProgress size={12} sx={{ color: 'inherit !important' }} />}
                                                    label="Подключение" color="info" variant="outlined" size="small"
                                                    sx={{ borderRadius: 1 }}
                                                />
                                            )}
                                            {probeStatus === 'streaming' && (
                                                <Chip icon={<CheckIcon />} label="Активен" color="success" variant="outlined" size="small" sx={{ borderRadius: 1 }} />
                                            )}
                                            {probeStatus === 'error' && (
                                                <Chip icon={<ErrorIcon />} label="Ошибка" color="error" variant="outlined" size="small" sx={{ borderRadius: 1 }} />
                                            )}
                                        </Box>

                                        <Box
                                            sx={{
                                                width: '100%', aspectRatio: '16 / 9', bgcolor: '#000',
                                                borderRadius: 1, display: 'flex', alignItems: 'center',
                                                justifyContent: 'center', overflow: 'hidden',
                                            }}
                                        >
                                            {probeStatus === 'streaming' && probeName ? (
                                                <WebRTCPlayer
                                                    cameraId={probeName}
                                                    signalingUrl={wsUrl(`/signaling/client/${probeName}`)}
                                                    onError={(err) => { setProbeError(err); setProbeStatus('error'); }}
                                                />
                                            ) : probeStatus === 'creating' ? (
                                                <Box textAlign="center" color="white">
                                                    <CircularProgress color="inherit" size={28} />
                                                    <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>Инициализация</Typography>
                                                </Box>
                                            ) : (
                                                <Box textAlign="center" color="grey.500">
                                                    <Typography variant="caption">
                                                        {probeError || 'Превью недоступно'}
                                                    </Typography>
                                                    <Button
                                                        size="small" startIcon={<PlayIcon />} onClick={handleTestStream}
                                                        disabled={!ipValidation.valid || !portValidation.valid}
                                                        sx={{ display: 'block', mx: 'auto', mt: 1, color: 'grey.300' }}
                                                    >
                                                        Повторить
                                                    </Button>
                                                </Box>
                                            )}
                                        </Box>
                                    </Grid>

                                    {/* Сводка */}
                                    <Grid item xs={12} sm={6}>
                                        <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>
                                            Параметры
                                        </Typography>
                                        <Box
                                            sx={{
                                                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5,
                                                fontFamily: 'monospace', fontSize: '0.85rem',
                                            }}
                                        >
                                            <Box>
                                                <Typography variant="caption" color="text.secondary">Имя</Typography>
                                                <Typography sx={{ fontFamily: 'monospace' }}>{formData.display_name || autoNamePreview}</Typography>
                                            </Box>
                                            <Box>
                                                <Typography variant="caption" color="text.secondary">Адрес</Typography>
                                                <Typography sx={{ fontFamily: 'monospace' }}>{formData.ip_adress || '—'}:{formData.port}</Typography>
                                            </Box>
                                            <Box>
                                                <Typography variant="caption" color="text.secondary">Производитель</Typography>
                                                <Typography sx={{ fontFamily: 'monospace' }}>{getProductionName(formData.production)}</Typography>
                                            </Box>
                                            <Box>
                                                <Typography variant="caption" color="text.secondary">Запись</Typography>
                                                <Typography sx={{ fontFamily: 'monospace' }}>
                                                    {formData.to_record ? `вкл, ${formData.main_segment} мин` : 'выкл'}
                                                </Typography>
                                            </Box>
                                        </Box>

                                        <Alert severity="info" sx={{ mt: 2, borderRadius: 1 }}>
                                            Проверьте параметры и предпросмотр, затем подтвердите.
                                        </Alert>
                                    </Grid>
                                </Grid>
                            </Box>
                        </Box>
                    </Box>
                </DialogContent>

                {/* Footer: навигация */}
                <DialogActions
                    sx={{
                        p: 2.5,
                        borderTop: `1px solid ${RZD_COLORS.grey[200]}`,
                        display: 'flex',
                        justifyContent: 'space-between',
                    }}
                >
                    <Button onClick={handleCloseDialog} disabled={loading}>
                        Отменить
                    </Button>

                    <Box display="flex" gap={1}>
                        <Button
                            onClick={() => setActiveStep(s => Math.max(0, s - 1))}
                            disabled={activeStep === 0 || loading}
                            startIcon={<ArrowBackIcon />}
                        >
                            Назад
                        </Button>

                        {!isLastStep ? (
                            <Button
                                variant="contained"
                                onClick={() => setActiveStep(s => Math.min(STEPS.length - 1, s + 1))}
                                disabled={!canGoNext || loading}
                                endIcon={<ArrowForwardIcon />}
                                sx={{ bgcolor: RZD_COLORS.primary }}
                            >
                                Далее
                            </Button>
                        ) : (
                            <Button
                                variant="contained"
                                onClick={handleSaveCamera}
                                disabled={loading || !isFormValid}
                                startIcon={loading ? <CircularProgress size={18} color="inherit" /> : <SaveIcon />}
                                sx={{ bgcolor: RZD_COLORS.primary }}
                            >
                                {editMode ? 'Сохранить камеру' : 'Добавить камеру'}
                            </Button>
                        )}
                    </Box>
                </DialogActions>
            </Dialog>
        </Container>
    );
};

export default CameraSettings;