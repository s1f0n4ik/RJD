import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Typography } from '@mui/material';
import { loadDevices } from '../services/devices';
import { RZD_COLORS } from '../theme';

/**
 * Шлагбаум перед App: реестр устройств должен лежать в кэше до первого рендера,
 * потому что App и Dashboard читают getDevices() синхронно прямо в разметке.
 *
 * Ожидание закрывает сплэш из index.html — он уже на экране к моменту, когда
 * этот компонент монтируется, и снимается только при уходе из состояния loading.
 * Поэтому в loading здесь рендерится null: два спиннера подряд не нужны.
 */

// Страховка от подвисшего nginx: живой бэкенд отвечает из памяти за миллисекунды
const TIMEOUT_MS = 8000;

type Status = 'loading' | 'ready' | 'failed';

export const Bootstrap: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [status, setStatus] = useState<Status>('loading');
    const [error, setError] = useState('');

    const attempt = useCallback(() => {
        setStatus('loading');
        setError('');

        const controller = new AbortController();
        // AbortSignal.timeout не используется: версия движка на плате не гарантирована
        const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);

        loadDevices(controller.signal)
            .then(() => setStatus('ready'))
            .catch((e: unknown) => {
                setError(
                    controller.signal.aborted
                        ? `Мастер не ответил за ${TIMEOUT_MS / 1000} с`
                        : (e as Error)?.message || String(e),
                );
                setStatus('failed');
            })
            .finally(() => window.clearTimeout(timer));
    }, []);

    useEffect(attempt, [attempt]);

    useEffect(() => {
        if (status === 'loading') return;
        document.getElementById('boot')?.remove();
    }, [status]);

    if (status === 'loading') return null;
    if (status === 'ready') return <>{children}</>;

    return (
        <Box
            sx={{
                minHeight: '100vh',
                bgcolor: RZD_COLORS.grey[100],
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                p: 3,
            }}
        >
            <Box sx={{ width: '100%', maxWidth: 540, bgcolor: '#fff', borderRadius: 2, p: 4, boxShadow: 2 }}>
                <Typography variant="h6" gutterBottom>
                    Реестр устройств недоступен
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Не удалось получить список устройств от мастера. Без него модули 360 и ИИ
                    показываются недоступными, а маршрутизация не работает. Остальные разделы,
                    включая настройку устройств, открываются.
                </Typography>

                <Alert severity="error" sx={{ mb: 3 }}>
                    {error}
                </Alert>

                <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                    <Button variant="contained" onClick={attempt}>
                        Повторить
                    </Button>
                    {/* Выход обязателен: реестр чинят на вкладке «Устройства» внутри приложения */}
                    <Button variant="outlined" onClick={() => setStatus('ready')}>
                        Продолжить без реестра
                    </Button>
                </Box>
            </Box>
        </Box>
    );
};

export default Bootstrap;
