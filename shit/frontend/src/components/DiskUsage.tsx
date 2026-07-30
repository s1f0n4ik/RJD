import React, { useEffect, useRef, useState } from 'react';
import { Box, Typography, Tooltip, Skeleton, Chip, Divider } from '@mui/material';
import { RZD_COLORS } from '../theme';
import { getDevices, storagePath, type Device } from '../services/devices';

interface DiskState {
    path: string;
    exists: boolean;
    total_bytes: number;
    used_bytes: number;
    free_bytes: number;
    records_bytes: number;
    total_gb: number;
    used_gb: number;
    free_gb: number;
    records_gb: number;
    used_percent: number;
    max_used_percent: number;
}

// Диск устройства: null — storage-service не ответил
type DeviceDisks = Record<string, DiskState | null>;

const POLL_INTERVAL_MS = 20_000;

const formatGb = (gb: number): string => {
    if (gb >= 1024) return `${(gb / 1024).toFixed(2)} ТБ`;
    if (gb >= 10) return `${Math.round(gb)} ГБ`;
    return `${gb.toFixed(1)} ГБ`;
};

// Цвет по занятости: спокойный до трёх четвертей, предупреждающий ближе к порогу
// автоочистки, тревожный когда сервер вот-вот начнёт удалять старые записи.
const usageColor = (percent: number, threshold: number): string => {
    if (percent >= threshold) return RZD_COLORS.error;
    if (percent >= threshold - 15) return RZD_COLORS.warning;
    return RZD_COLORS.success;
};

const DiskUsage: React.FC = () => {
    const [devices, setDevices] = useState<Device[]>(getDevices());
    const [disks, setDisks] = useState<DeviceDisks>({});
    const [loaded, setLoaded] = useState(false);
    const timerRef = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            const known = getDevices();
            const results: DeviceDisks = {};
            await Promise.all(known.map(async (device) => {
                try {
                    const res = await fetch(storagePath(device.id, '/api/recordings/disk'));
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    results[device.id] = await res.json();
                } catch {
                    results[device.id] = null;
                }
            }));
            if (!cancelled) {
                setDevices(known);
                setDisks(results);
                setLoaded(true);
            }
        };

        load();
        timerRef.current = window.setInterval(load, POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            if (timerRef.current) window.clearInterval(timerRef.current);
        };
    }, []);

    const header = (
        <Typography variant="subtitle2" fontWeight="bold" mb={1.5}>
            Хранилище
        </Typography>
    );

    if (!loaded) {
        return (
            <Box>
                {header}
                <Skeleton variant="rounded" height={14} sx={{ mb: 1.5, borderRadius: 999 }} />
                <Skeleton variant="text" width="70%" />
                <Skeleton variant="text" width="45%" />
            </Box>
        );
    }

    if (devices.length === 0) {
        return (
            <Box>
                {header}
                <Typography variant="caption" color="text.secondary">
                    Устройства не настроены
                </Typography>
            </Box>
        );
    }

    return (
        <Box>
            {header}
            {devices.map((device, index) => (
                <Box key={device.id}>
                    {index > 0 && <Divider sx={{ my: 1.5 }} />}
                    <DeviceDisk name={device.name} disk={disks[device.id] ?? null} />
                </Box>
            ))}
        </Box>
    );
};

const DeviceDisk: React.FC<{ name: string; disk: DiskState | null }> = ({ name, disk }) => {
    if (!disk) {
        return (
            <Box>
                <Box display="flex" alignItems="center" justifyContent="space-between">
                    <Typography variant="body2" fontWeight="bold" noWrap>
                        {name}
                    </Typography>
                    <Chip label="недоступно" size="small" sx={{ height: 18, fontSize: '0.65rem' }} />
                </Box>
            </Box>
        );
    }

    const percent = Math.min(100, Math.max(0, disk.used_percent));
    const color = usageColor(percent, disk.max_used_percent);
    const thresholdPos = Math.min(100, Math.max(0, disk.max_used_percent));

    return (
        <Box>
            <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
                <Typography variant="body2" fontWeight="bold" noWrap>
                    {name}
                </Typography>
                <Typography variant="subtitle1" fontWeight="bold" sx={{ color, lineHeight: 1 }}>
                    {percent.toFixed(0)}%
                </Typography>
            </Box>

            <Tooltip
                arrow
                placement="top"
                title={`Занято ${percent.toFixed(1)}%. Автоочистка старых записей при ${disk.max_used_percent}%`}
            >
                <Box
                    sx={{
                        position: 'relative',
                        height: 12,
                        borderRadius: 999,
                        bgcolor: RZD_COLORS.grey[200],
                        overflow: 'hidden',
                        mb: 0.75,
                    }}
                >
                    <Box
                        sx={{
                            position: 'absolute',
                            inset: 0,
                            width: `${percent}%`,
                            bgcolor: color,
                            borderRadius: 999,
                            transition: 'width 0.6s ease, background-color 0.4s ease',
                        }}
                    />
                    {/* Метка порога, за которым сервер начинает удалять старые записи */}
                    <Box
                        sx={{
                            position: 'absolute',
                            top: -2,
                            bottom: -2,
                            left: `${thresholdPos}%`,
                            width: '2px',
                            bgcolor: RZD_COLORS.grey[900],
                            opacity: 0.55,
                        }}
                    />
                </Box>
            </Tooltip>

            <Box display="flex" gap={1}>
                <Stat label="Занято" value={formatGb(disk.used_gb)} dotColor={color} />
                <Stat label="Свободно" value={formatGb(disk.free_gb)} dotColor={RZD_COLORS.grey[300]} />
                <Stat label="Всего" value={formatGb(disk.total_gb)} />
            </Box>

            <Tooltip title={disk.path} placement="bottom" arrow>
                <Typography
                    variant="caption"
                    color="text.disabled"
                    sx={{
                        display: 'block',
                        mt: 1,
                        fontFamily: 'monospace',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    {disk.path}
                </Typography>
            </Tooltip>
        </Box>
    );
};

interface StatProps {
    label: string;
    value: string;
    dotColor?: string;
}

const Stat: React.FC<StatProps> = ({ label, value, dotColor }) => (
    <Box flex={1} minWidth={0}>
        <Box display="flex" alignItems="center" gap={0.5}>
            {dotColor && (
                <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: dotColor, flexShrink: 0 }} />
            )}
            <Typography variant="caption" color="text.secondary" noWrap>
                {label}
            </Typography>
        </Box>
        <Typography variant="body2" fontWeight="bold" noWrap>
            {value}
        </Typography>
    </Box>
);

export default DiskUsage;
