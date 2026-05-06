import React from 'react';
import { Box, Typography, Button, Stack } from '@mui/material';
import {
  Fullscreen as FullscreenIcon,
  AdminPanelSettings as AdminIcon,
} from '@mui/icons-material';

const Landing: React.FC = () => {
  const goToKiosk = () => {
    // Если есть сохранённые layouts — открываем киоск без имени,
    // KioskView сам возьмёт первый доступный.
    window.location.href = '/kiosk';
  };

  const goToAdmin = () => {
    window.location.href = '/app';
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        bgcolor: '#000',
        color: 'white',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        p: 4,
      }}
    >
      <Typography variant="h2" sx={{ mb: 1, fontWeight: 700 }}>
        🎥 Система видеонаблюдения
      </Typography>
      <Typography variant="h6" sx={{ color: 'grey.500', mb: 6 }}>
        Выберите режим работы
      </Typography>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
        <Button
          variant="contained"
          size="large"
          startIcon={<FullscreenIcon />}
          onClick={goToKiosk}
          sx={{
            fontSize: '1.2rem',
            px: 5,
            py: 2.5,
            minWidth: 260,
          }}
        >
          Киоск
        </Button>

        <Button
          variant="outlined"
          size="large"
          startIcon={<AdminIcon />}
          onClick={goToAdmin}
          sx={{
            fontSize: '1.2rem',
            px: 5,
            py: 2.5,
            minWidth: 260,
            color: 'white',
            borderColor: 'grey.500',
            '&:hover': {
              borderColor: 'white',
              bgcolor: 'rgba(255,255,255,0.05)',
            },
          }}
        >
          Админка
        </Button>
      </Stack>

      <Typography variant="caption" color="grey.600" sx={{ mt: 6 }}>
        Киоск — просмотр сохранённых layout'ов на полный экран • Админка — настройка и управление
      </Typography>
    </Box>
  );
};

export default Landing;