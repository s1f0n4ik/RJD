import React from 'react';
import { Container, Paper, Typography } from '@mui/material';
import { Construction as ConstructionIcon } from '@mui/icons-material';

const SystemStatus: React.FC = () => {
  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 6, textAlign: 'center' }}>
        <ConstructionIcon sx={{ fontSize: 80, color: 'text.secondary', mb: 2 }} />
        <Typography variant="h4" color="text.secondary" gutterBottom>
          В разработке
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Статус системы и логи будут доступны в следующей версии
        </Typography>
      </Paper>
    </Container>
  );
};

export default SystemStatus;