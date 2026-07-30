import React from 'react';
import {
    Box,
    Chip,
    Link,
    Paper,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Typography,
} from '@mui/material';
import { Hub as HubIcon } from '@mui/icons-material';

import { RZD_COLORS } from '../../theme';
import { makeCameraNameResolver, PRODUCER_NAME, PRODUCER_PAGE } from './stream-sources';
import type { CPPCamera, VirtualStream } from '../../types';

// Виртуальные потоки в настройках камер, отдельная таблица со своими столбцами
// Управления нет, пуск и остановка на страницах систем

interface VirtualStreamsTableProps {
    streams: VirtualStream[];
    // Для подстановки имён вместо id камер
    cameras: CPPCamera[];
}

export const VirtualStreamsTable: React.FC<VirtualStreamsTableProps> = ({ streams, cameras }) => {
    const nameOf = makeCameraNameResolver(cameras);
    const running = streams.filter(s => s.running).length;

    return (
        <>
            <Paper
                sx={{
                    p: 3, mt: 3, mb: 3,
                    borderRadius: 1,
                    border: `1px solid ${RZD_COLORS.grey[200]}`,
                }}
            >
                <Box display="flex" alignItems="center" gap={2}>
                    <HubIcon sx={{ fontSize: 36, color: RZD_COLORS.secondary }} />
                    <Box>
                        <Typography variant="h5" fontWeight={700} sx={{ letterSpacing: '-0.01em' }}>
                            Виртуальные потоки
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                            В эфире: {running} из {streams.length}. Собираются на страницах систем.
                        </Typography>
                    </Box>
                </Box>
            </Paper>

            <TableContainer component={Paper} sx={{ borderRadius: 1 }}>
                <Table>
                    <TableHead sx={{ bgcolor: RZD_COLORS.grey[100] }}>
                        <TableRow>
                            <TableCell><strong>Поток</strong></TableCell>
                            <TableCell><strong>Источник</strong></TableCell>
                            <TableCell><strong>Камеры</strong></TableCell>
                            <TableCell><strong>Кадр</strong></TableCell>
                            <TableCell><strong>Статус</strong></TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {streams.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                                    <Typography color="text.secondary">
                                        Потоков нет. Соберите конфигурацию в системе 360
                                        или включите трансляцию у технического зрения.
                                    </Typography>
                                </TableCell>
                            </TableRow>
                        ) : (
                            streams.map(stream => (
                                <TableRow key={stream.id} hover>
                                    <TableCell>
                                        <Typography variant="body2" fontWeight={600}>
                                            {stream.name || stream.id}
                                        </Typography>
                                        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                                            {stream.id}
                                        </Typography>
                                    </TableCell>

                                    <TableCell>
                                        <Link
                                            href={PRODUCER_PAGE[stream.producer]}
                                            underline="hover"
                                            variant="body2"
                                            fontWeight={600}
                                        >
                                            {PRODUCER_NAME[stream.producer]}
                                        </Link>
                                        <Typography variant="caption" color="text.secondary" display="block">
                                            {stream.source_name || stream.source_id}
                                        </Typography>
                                    </TableCell>

                                    <TableCell>
                                        {stream.cameras.length === 0 ? (
                                            <Typography variant="caption" color="text.secondary">
                                                Не назначены
                                            </Typography>
                                        ) : (
                                            <Box display="flex" flexWrap="wrap" gap={0.5}>
                                                {stream.cameras.map(id => (
                                                    <Chip
                                                        key={id}
                                                        label={nameOf(id)}
                                                        size="small"
                                                        variant="outlined"
                                                        sx={{ borderRadius: 1 }}
                                                    />
                                                ))}
                                            </Box>
                                        )}
                                    </TableCell>

                                    {/* Нули - вывода ещё не было */}
                                    <TableCell sx={{ fontFamily: 'monospace' }}>
                                        {stream.width && stream.height
                                            ? `${stream.width} × ${stream.height}`
                                            : '—'}
                                    </TableCell>

                                    <TableCell>
                                        {stream.offline ? (
                                            // Кэшированный статус устарел — устройство модуля не отвечает
                                            <Chip
                                                label="Не в сети"
                                                color="error"
                                                size="small"
                                                sx={{ borderRadius: 1 }}
                                            />
                                        ) : (
                                            <Chip
                                                label={stream.running ? 'В работе' : 'Остановлен'}
                                                color={stream.running ? 'success' : 'default'}
                                                size="small"
                                                sx={{ borderRadius: 1 }}
                                            />
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </TableContainer>
        </>
    );
};
