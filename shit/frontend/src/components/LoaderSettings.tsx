import React from 'react';
import { Container, Paper, Typography, Box } from '@mui/material';
import { Construction as ConstructionIcon } from '@mui/icons-material';

const LoaderSettings: React.FC = () => {
  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 6, textAlign: 'center' }}>
        <ConstructionIcon sx={{ fontSize: 80, color: 'text.secondary', mb: 2 }} />
        <Typography variant="h4" color="text.secondary" gutterBottom>
          В разработке
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Управление нейронными загрузчиками будет доступно в следующей версии
        </Typography>
      </Paper>
    </Container>
  );
};

export default LoaderSettings;