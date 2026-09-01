import React, { useState } from 'react';
import {
    Container,
    Paper,
    TextField,
    Button,
    Typography,
    Box,
    Alert,
} from '@mui/material';
import { Fullscreen as FullscreenIcon } from '@mui/icons-material';
import { RZD_COLORS } from '../theme';
import { FULL_AUTH } from '../utils/auth';

interface LoginProps {
    onLogin: (token: string, role: string, username: string) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const response = await fetch('/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });

            if (!response.ok) {
                throw new Error('Неверный логин или пароль');
            }

            const data = await response.json();
            onLogin(data.access_token, data.role, data.username);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const goToBroadcast = () => {
        window.location.href = '/translation';
    };

    return (
        <Box
            sx={{
                minHeight: '100vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: `linear-gradient(135deg, ${RZD_COLORS.primary} 0%, ${RZD_COLORS.secondary} 100%)`,
            }}
        >
            <Container maxWidth="sm">
                {/* Обёртка для основной карточки и серой «закладки» */}
                <Box sx={{ position: 'relative' }}>
                    {/* Серая «закладка» — позади основной карточки, чуть смещённая вправо */}
                    {/* В защищённой сборке киоск тоже за логином — переход скрыт */}
                    {!FULL_AUTH && (
                    <Paper
                        elevation={4}
                        onClick={goToBroadcast}
                        sx={{
                            position: 'absolute',
                            top: 20,
                            right: -40,                            // ← вылет вправо
                            width: 90,
                            height: 'calc(100% - 40px)',           // чуть короче основной карточки сверху и снизу
                            bgcolor: RZD_COLORS.grey[300],
                            borderRadius: 3,
                            cursor: 'pointer',
                            // На узких экранах прячем — не помещается рядом с основной карточкой
                            display: { xs: 'none', sm: 'flex' },
                            alignItems: 'center',
                            justifyContent: 'right',
                            transition: 'all 0.2s ease',
                            boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
                            '&:hover': {
                                right: -64,                          // ← при hover чуть «выдвигается»
                                bgcolor: RZD_COLORS.grey[500],
                            },

                        }}
                    >
                        <Box
                            sx={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                gap: 1.5,
                                // Текст вертикальный — повёрнут на 90 градусов
                                transform: 'rotate(180deg)',
                                writingMode: 'vertical-rl',
                            }}
                        >
                            <Typography
                                variant="button"
                                sx={{
                                    pl: 1.5,
                                    color: RZD_COLORS.primary,
                                    fontWeight: 600,
                                    letterSpacing: 1,
                                    fontSize: '0.85rem',
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                Перейти в режим трансляции
                            </Typography>
                        </Box>
                    </Paper>
                    )}

                    {/* Основная карточка логина — поверх «закладки» */}
                    <Paper
                        elevation={8}
                        sx={{
                            position: 'relative',                  // ← чтобы оказаться выше absolute-карточки
                            zIndex: 1,
                            p: 5,
                            borderRadius: 3,
                            boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
                        }}
                    >
                        <Box display="flex" flexDirection="column" alignItems="center" mb={4}>
                            <Box
                                component="img"
                                src="/assets/logo1.png"
                                alt="ВНИИЖТ"
                                sx={{
                                    height: 60,
                                    mb: 2,
                                    objectFit: 'contain',
                                }}
                                onError={(e: any) => {
                                    e.target.style.display = 'none';
                                }}
                            />

                            <Typography
                                variant="h4"
                                fontWeight="bold"
                                sx={{ color: RZD_COLORS.primary, mb: 1 }}
                            >
                                РЖД
                            </Typography>
                            <Typography variant="h6" color="text.secondary">
                                Система видеоаналитики
                            </Typography>
                            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                                Вход в систему
                            </Typography>
                        </Box>

                        <form onSubmit={handleSubmit}>
                            <TextField
                                label="Логин"
                                fullWidth
                                margin="normal"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                required
                                autoFocus
                            />
                            <TextField
                                label="Пароль"
                                type="password"
                                fullWidth
                                margin="normal"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                            />

                            {error && (
                                <Alert severity="error" sx={{ mt: 2 }}>
                                    {error}
                                </Alert>
                            )}

                            <Button
                                type="submit"
                                variant="contained"
                                fullWidth
                                size="large"
                                disabled={loading}
                                sx={{
                                    mt: 3,
                                    py: 1.5,
                                    fontSize: '1rem',
                                    fontWeight: 600,
                                }}
                            >
                                {loading ? 'Вход...' : 'Войти'}
                            </Button>
                        </form>

                        {/* Дублирующая кнопка для мобильных, где «закладка» скрыта */}
                        {!FULL_AUTH && (
                        <Button
                            variant="text"
                            fullWidth
                            startIcon={<FullscreenIcon />}
                            onClick={goToBroadcast}
                            sx={{
                                mt: 2,
                                color: RZD_COLORS.primary,
                                display: { xs: 'flex', sm: 'none' },   // ← только на узких экранах
                            }}
                        >
                            Перейти в режим трансляции
                        </Button>
                        )}
                    </Paper>
                </Box>
            </Container>
        </Box>
    );
};

export default Login;