import React from 'react';
import {
  AppBar,
  Toolbar,
  Typography,
  Tabs,
  Tab,
  Box,
  Chip,
} from '@mui/material';
import {
  Videocam as VideocamIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
} from '@mui/icons-material';

interface HeaderProps {
  currentTab: number;
  onTabChange: (tab: number) => void;
  wsConnected: boolean;
}

const Header: React.FC<HeaderProps> = ({ currentTab, onTabChange, wsConnected }) => {
  return (
    <AppBar position="static" sx={{ bgcolor: '#1976d2', mb: 3 }}>
      <Toolbar>
        <VideocamIcon sx={{ mr: 2, fontSize: 32 }} />
        <Typography variant="h5" sx={{ flexGrow: 0, mr: 4 }}>
          🚂 RJD Video Processing System
        </Typography>

        <Tabs
          value={currentTab}
          onChange={(_, newValue) => onTabChange(newValue)}
          sx={{
            flexGrow: 1,
            '& .MuiTab-root': { color: 'rgba(255,255,255,0.7)' },
            '& .Mui-selected': { color: 'white' },
            '& .MuiTabs-indicator': { backgroundColor: 'white' },
          }}
        >
          <Tab label="Дашборд" />
          <Tab label="Камеры" />
          <Tab label="Загрузчики" />
          <Tab label="Система" />
        </Tabs>

        <Chip
          icon={wsConnected ? <CheckCircleIcon /> : <ErrorIcon />}
          label={wsConnected ? 'Подключено' : 'Отключено'}
          color={wsConnected ? 'success' : 'error'}
          sx={{ color: 'white' }}
        />
      </Toolbar>
    </AppBar>
  );
};

export default Header;