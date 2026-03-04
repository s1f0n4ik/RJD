import React from 'react';
import { Container, Paper, Typography } from '@mui/material';
import { Construction as ConstructionIcon } from '@mui/icons-material';

const CameraSettings: React.FC = () => {
  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 6, textAlign: 'center' }}>
        <ConstructionIcon sx={{ fontSize: 80, color: 'text.secondary', mb: 2 }} />
        <Typography variant="h4" color="text.secondary" gutterBottom>
          В разработке
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Управление камерами будет доступно в следующей версии
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
          Используйте прямые запросы к API: POST /api/camera
        </Typography>
      </Paper>
    </Container>
  );
};

export default CameraSettings;