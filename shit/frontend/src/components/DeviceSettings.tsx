import React, { useCallback, useEffect, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    Container,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Divider,
    FormControl,
    Grid,
    IconButton,
    InputLabel,
    MenuItem,
    Paper,
    Select,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import {
    Delete as DeleteIcon,
    DeviceHub as DeviceHubIcon,
    Edit as EditIcon,
    Memory as MemoryIcon,
    NetworkPing as NetworkPingIcon,
    Radar as RadarIcon,
    Save as SaveIcon,
    Thermostat as ThermostatIcon,
} from '@mui/icons-material';
import { RZD_COLORS } from '../theme';
import {
    devicesApi,
    getDevices,
    getRouting,
    loadDevices,
    type Device,
    type RoutingTable,
    type ScanResult,
} from '../services/devices';

const POLL_INTERVAL_MS = 5_000;

const MODULE_LABELS: Record<string, string> = {
    birdview: 'Система 360',
    neural: 'Техническое зрение',
};

const formatUptime = (sec?: number): string => {
    if (!sec || sec <= 0) return '—';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}д ${h}ч`;
    if (h > 0) return `${h}ч ${m}м`;
    return `${m}м`;
};

const formatBytes = (bytes?: number): string => {
    if (bytes == null) return '—';
    const gb = bytes / 1024 ** 3;
    if (gb >= 1024) return `${(gb / 1024).toFixed(2)} ТБ`;
    return `${gb.toFixed(1)} ГБ`;
};

const formatBitrate = (bps?: number | null): string => {
    if (bps == null) return '—';
    const mbit = (bps * 8) / 1_000_000;
    if (mbit >= 1000) return `${(mbit / 1000).toFixed(2)} Гбит/с`;
    if (mbit >= 1) return `${mbit.toFixed(1)} Мбит/с`;
    return `${Math.round(mbit * 1000)} Кбит/с`;
};

const maxTemp = (device: Device): number | null => {
    const zones = device.telemetry?.temperature ?? [];
    if (!zones.length) return null;
    return Math.max(...zones.map(z => z.celsius));
};

const DeviceSettings: React.FC = () => {
    const [devices, setDevices] = useState<Device[]>(getDevices());
    const [routing, setRouting] = useState<RoutingTable>(getRouting());
    const [routingDirty, setRoutingDirty] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    // Скан сети
    const [scanOpen, setScanOpen] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [scanResults, setScanResults] = useState<ScanResult[]>([]);
    const [addTarget, setAddTarget] = useState<ScanResult | null>(null);
    const [addName, setAddName] = useState('');

    // Переименование
    const [renameTarget, setRenameTarget] = useState<Device | null>(null);
    const [renameValue, setRenameValue] = useState('');

    const refresh = useCallback(async (silent = false) => {
        try {
            const data = await loadDevices();
            setDevices(data.devices);
            // Несохранённые правки маршрутов не затираем фоновым опросом
            setRouting(prev => (routingDirty ? prev : data.routing));
            if (!silent) setError('');
        } catch (e: any) {
            if (!silent) setError(e.message ?? String(e));
        }
    }, [routingDirty]);

    useEffect(() => {
        refresh();
        const timer = window.setInterval(() => refresh(true), POLL_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [refresh]);

    // ── Скан ──

    const handleScan = async () => {
        setScanOpen(true);
        setScanning(true);
        setScanResults([]);
        try {
            const { found } = await devicesApi.scan();
            setScanResults(found);
        } catch (e: any) {
            setError(e.message ?? String(e));
        } finally {
            setScanning(false);
        }
    };

    const handleAdd = async () => {
        if (!addTarget) return;
        try {
            await devicesApi.add({
                id: addTarget.id,
                ip: addTarget.ip,
                name: addName || addTarget.hostname || addTarget.ip,
                modules: addTarget.modules,
            });
            setAddTarget(null);
            setAddName('');
            setSuccess('Устройство добавлено');
            setScanResults(prev => prev.map(r => (r.id === addTarget.id ? { ...r, known: true } : r)));
            await refresh(true);
        } catch (e: any) {
            setError(e.message ?? String(e));
        }
    };

    const handleRemove = async (device: Device) => {
        if (!window.confirm(`Удалить устройство «${device.name}»? Маршруты на него будут сброшены.`)) return;
        try {
            await devicesApi.remove(device.id);
            await refresh(true);
            setRouting(getRouting());
            setSuccess('Устройство удалено');
        } catch (e: any) {
            setError(e.message ?? String(e));
        }
    };

    const handleRename = async () => {
        if (!renameTarget) return;
        try {
            await devicesApi.rename(renameTarget.id, renameValue);
            setRenameTarget(null);
            await refresh(true);
        } catch (e: any) {
            setError(e.message ?? String(e));
        }
    };

    // ── Маршруты ──

    const setModuleRoute = (module: 'birdview' | 'neural', deviceId: string) => {
        setRouting(prev => ({ ...prev, [module]: deviceId || null }));
        setRoutingDirty(true);
    };

    const handleSaveRouting = async () => {
        try {
            await devicesApi.saveRouting(routing);
            setRoutingDirty(false);
            setSuccess('Маршруты сохранены');
        } catch (e: any) {
            setError(e.message ?? String(e));
        }
    };

    const deviceSelect = (value: string | null, onChange: (id: string) => void) => (
        <FormControl size="small" fullWidth>
            <Select
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value)}
                displayEmpty
            >
                <MenuItem value="">
                    <em>Не назначено</em>
                </MenuItem>
                {devices.map(d => (
                    <MenuItem key={d.id} value={d.id}>
                        {d.name}
                    </MenuItem>
                ))}
            </Select>
        </FormControl>
    );

    return (
        <Container maxWidth="xl">
            <Paper sx={{ p: 2, mb: 2 }}>
                <Box display="flex" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={2}>
                    <Box display="flex" alignItems="center" gap={2}>
                        <DeviceHubIcon sx={{ fontSize: 40, color: RZD_COLORS.primary }} />
                        <Box>
                            <Typography variant="h5" fontWeight="bold">
                                Устройства
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                                Вычислительные устройства: обнаружение, состояние, маршрутизация
                            </Typography>
                        </Box>
                    </Box>
                    <Button variant="contained" startIcon={<RadarIcon />} onClick={handleScan}>
                        Сканировать сеть
                    </Button>
                </Box>
            </Paper>

            {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
            {success && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>{success}</Alert>}

            {/* ── Список устройств ── */}
            <Grid container spacing={2} sx={{ mb: 2 }}>
                {devices.length === 0 && (
                    <Grid item xs={12}>
                        <Paper sx={{ p: 6, textAlign: 'center' }}>
                            <Typography variant="h6" color="text.secondary" gutterBottom>
                                Устройства не добавлены
                            </Typography>
                            <Typography color="text.secondary">
                                Нажмите «Сканировать сеть», чтобы найти вычислительные устройства по порту 7777
                            </Typography>
                        </Paper>
                    </Grid>
                )}

                {devices.map(device => {
                    const online = device.status === 'online';
                    const temp = maxTemp(device);
                    const cpu = device.telemetry?.cpu;
                    const memory = device.telemetry?.memory;
                    const storageDisk = device.telemetry?.disks?.find(d => d.label === 'storage');
                    return (
                        <Grid item xs={12} md={6} lg={4} key={device.id}>
                            <Paper sx={{ p: 2, height: '100%', borderTop: `4px solid ${online ? RZD_COLORS.success : RZD_COLORS.error}` }}>
                                <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
                                    <Box display="flex" alignItems="center" gap={1} minWidth={0}>
                                        <Typography variant="h6" fontWeight="bold" noWrap>
                                            {device.name}
                                        </Typography>
                                        <IconButton size="small" onClick={() => { setRenameTarget(device); setRenameValue(device.name); }}>
                                            <EditIcon sx={{ fontSize: 16 }} />
                                        </IconButton>
                                    </Box>
                                    <Chip
                                        label={online ? 'В сети' : 'Не в сети'}
                                        size="small"
                                        sx={{
                                            bgcolor: online ? RZD_COLORS.success : RZD_COLORS.error,
                                            color: 'white',
                                            fontWeight: 600,
                                        }}
                                    />
                                </Box>

                                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', display: 'block' }}>
                                    {device.ip} · {device.id.slice(0, 12)}
                                </Typography>
                                <Typography variant="caption" color="text.secondary" display="block" mb={1}>
                                    {device.telemetry?.platform?.label ?? '—'}
                                    {device.telemetry?.version ? ` · версия ${device.telemetry.version}` : ''}
                                    {` · в работе ${formatUptime(device.telemetry?.uptime_sec)}`}
                                </Typography>

                                <Box display="flex" gap={0.5} flexWrap="wrap" mb={1.5}>
                                    <Chip label="Камеры" size="small" variant="outlined" />
                                    {device.modules.map(m => (
                                        <Chip
                                            key={m}
                                            label={MODULE_LABELS[m] ?? m}
                                            size="small"
                                            sx={{ bgcolor: RZD_COLORS.primary, color: 'white' }}
                                        />
                                    ))}
                                </Box>

                                <Divider sx={{ mb: 1.5 }} />

                                <Grid container spacing={1}>
                                    <Grid item xs={4}>
                                        <Tooltip title="Температура (максимум по датчикам)" arrow>
                                            <Box display="flex" alignItems="center" gap={0.5}>
                                                <ThermostatIcon sx={{ fontSize: 16, color: RZD_COLORS.grey[600] }} />
                                                <Typography variant="body2">
                                                    {temp != null ? `${temp.toFixed(0)}°C` : '—'}
                                                </Typography>
                                            </Box>
                                        </Tooltip>
                                    </Grid>
                                    <Grid item xs={4}>
                                        <Tooltip title={`Загрузка процессора, ядер: ${cpu?.cores ?? '—'}`} arrow>
                                            <Box display="flex" alignItems="center" gap={0.5}>
                                                <MemoryIcon sx={{ fontSize: 16, color: RZD_COLORS.grey[600] }} />
                                                <Typography variant="body2">
                                                    {cpu?.percent != null ? `${cpu.percent.toFixed(0)}%` : '—'}
                                                </Typography>
                                            </Box>
                                        </Tooltip>
                                    </Grid>
                                    <Grid item xs={4}>
                                        <Tooltip title="Отклик устройства (время ответа опроса)" arrow>
                                            <Box display="flex" alignItems="center" gap={0.5}>
                                                <NetworkPingIcon sx={{ fontSize: 16, color: RZD_COLORS.grey[600] }} />
                                                <Typography variant="body2">
                                                    {online && device.ping_ms != null ? `${device.ping_ms} мс` : '—'}
                                                </Typography>
                                            </Box>
                                        </Tooltip>
                                    </Grid>
                                    <Grid item xs={6}>
                                        <Typography variant="caption" color="text.secondary">
                                            Сеть: ↓ {online ? formatBitrate(device.net_rx_bps) : '—'} · ↑ {online ? formatBitrate(device.net_tx_bps) : '—'}
                                        </Typography>
                                    </Grid>
                                    <Grid item xs={6}>
                                        <Typography variant="caption" color="text.secondary">
                                            ОЗУ свободно: {formatBytes(memory?.available_bytes)}
                                        </Typography>
                                    </Grid>
                                    <Grid item xs={12}>
                                        <Typography variant="caption" color="text.secondary">
                                            Диск свободно: {formatBytes(storageDisk?.free_bytes)}
                                        </Typography>
                                    </Grid>
                                </Grid>

                                <Box display="flex" justifyContent="flex-end" mt={1}>
                                    <IconButton size="small" color="error" onClick={() => handleRemove(device)}>
                                        <DeleteIcon fontSize="small" />
                                    </IconButton>
                                </Box>
                            </Paper>
                        </Grid>
                    );
                })}
            </Grid>

            {/* ── Таблица маршрутизации ── */}
            {devices.length > 0 && (
                <Paper sx={{ p: 2 }}>
                    <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
                        <Box>
                            <Typography variant="h6" fontWeight="bold">
                                Маршрутизация
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                                Какое устройство обслуживает модули и где создаются камеры каждого типа
                            </Typography>
                        </Box>
                        <Button
                            variant="contained"
                            startIcon={<SaveIcon />}
                            disabled={!routingDirty}
                            onClick={handleSaveRouting}
                        >
                            Сохранить
                        </Button>
                    </Box>

                    <Grid container spacing={2}>
                        <Grid item xs={12} md={6}>
                            <Typography variant="subtitle2" fontWeight="bold" mb={1}>
                                Модули
                            </Typography>
                            <TableContainer>
                                <Table size="small">
                                    <TableBody>
                                        <TableRow>
                                            <TableCell sx={{ width: '50%' }}>Система 360 (linker, калибровка)</TableCell>
                                            <TableCell>{deviceSelect(routing.birdview, id => setModuleRoute('birdview', id))}</TableCell>
                                        </TableRow>
                                        <TableRow>
                                            <TableCell>Техническое зрение (детекция, журнал)</TableCell>
                                            <TableCell>{deviceSelect(routing.neural, id => setModuleRoute('neural', id))}</TableCell>
                                        </TableRow>
                                    </TableBody>
                                </Table>
                            </TableContainer>
                        </Grid>
                    </Grid>
                </Paper>
            )}

            {/* ── Диалог скана ── */}
            <Dialog open={scanOpen} onClose={() => setScanOpen(false)} maxWidth="md" fullWidth>
                <DialogTitle>Поиск устройств</DialogTitle>
                <DialogContent>
                    {scanning ? (
                        <Box display="flex" alignItems="center" gap={2} py={4} justifyContent="center">
                            <CircularProgress size={28} />
                            <Typography>Сканирование подсети по порту 7777…</Typography>
                        </Box>
                    ) : scanResults.length === 0 ? (
                        <Typography color="text.secondary" py={2}>
                            Устройства не найдены. Проверьте, что вычислительное устройство включено и доступно по сети.
                        </Typography>
                    ) : (
                        <TableContainer>
                            <Table size="small">
                                <TableHead>
                                    <TableRow>
                                        <TableCell>IP</TableCell>
                                        <TableCell>Хост</TableCell>
                                        <TableCell>Версия</TableCell>
                                        <TableCell>Модули</TableCell>
                                        <TableCell align="right" />
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {scanResults.map(result => (
                                        <TableRow key={result.id}>
                                            <TableCell sx={{ fontFamily: 'monospace' }}>{result.ip}</TableCell>
                                            <TableCell>{result.hostname ?? '—'}</TableCell>
                                            <TableCell>{result.version ?? '—'}</TableCell>
                                            <TableCell>
                                                <Box display="flex" gap={0.5}>
                                                    {result.modules.length
                                                        ? result.modules.map(m => (
                                                            <Chip key={m} label={MODULE_LABELS[m] ?? m} size="small" />
                                                        ))
                                                        : <Chip label="Видеорегистратор" size="small" variant="outlined" />}
                                                </Box>
                                            </TableCell>
                                            <TableCell align="right">
                                                {result.known ? (
                                                    <Chip label="добавлено" size="small" variant="outlined" />
                                                ) : (
                                                    <Button
                                                        size="small"
                                                        variant="contained"
                                                        onClick={() => { setAddTarget(result); setAddName(result.hostname ?? ''); }}
                                                    >
                                                        Добавить
                                                    </Button>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleScan} disabled={scanning}>Повторить</Button>
                    <Button onClick={() => setScanOpen(false)}>Закрыть</Button>
                </DialogActions>
            </Dialog>

            {/* ── Диалог добавления ── */}
            <Dialog open={!!addTarget} onClose={() => setAddTarget(null)} maxWidth="xs" fullWidth>
                <DialogTitle>Добавить устройство</DialogTitle>
                <DialogContent>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                        {addTarget?.ip} · {addTarget?.id.slice(0, 12)}
                    </Typography>
                    <TextField
                        autoFocus
                        fullWidth
                        label="Название устройства"
                        value={addName}
                        onChange={(e) => setAddName(e.target.value)}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setAddTarget(null)}>Отмена</Button>
                    <Button variant="contained" onClick={handleAdd}>Добавить</Button>
                </DialogActions>
            </Dialog>

            {/* ── Диалог переименования ── */}
            <Dialog open={!!renameTarget} onClose={() => setRenameTarget(null)} maxWidth="xs" fullWidth>
                <DialogTitle>Переименовать устройство</DialogTitle>
                <DialogContent>
                    <TextField
                        autoFocus
                        fullWidth
                        label="Название"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        sx={{ mt: 1 }}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setRenameTarget(null)}>Отмена</Button>
                    <Button variant="contained" disabled={!renameValue.trim()} onClick={handleRename}>
                        Сохранить
                    </Button>
                </DialogActions>
            </Dialog>
        </Container>
    );
};

export default DeviceSettings;
