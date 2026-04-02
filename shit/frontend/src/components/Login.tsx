import React, { useState } from 'react';
import {
  Container,
  Paper,
  TextField,
  Button,
  Typography,
  Box,
  Alert,
  Chip,
} from '@mui/material';
import { Lock as LockIcon } from '@mui/icons-material';
import { RZD_COLORS } from '../theme';

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
        <Paper
          elevation={8}
          sx={{
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

          <Box mt={4} p={2} bgcolor={RZD_COLORS.grey[100]} borderRadius={2}>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
              Тестовые аккаунты:
            </Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>
              <strong>admin</strong> / admin123{' '}
              <Chip label="Администратор" size="small" color="primary" sx={{ ml: 1 }} />
            </Typography>
            <Typography variant="body2">
              <strong>user</strong> / user123{' '}
              <Chip label="Наблюдатель" size="small" color="default" sx={{ ml: 1 }} />
            </Typography>
          </Box>
        </Paper>
      </Container>
    </Box>
  );
};

export default Login;