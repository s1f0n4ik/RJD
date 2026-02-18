import React, { useState } from 'react';
import {
  AppBar,
  Toolbar,
  Typography,
  Tabs,
  Tab,
  Box,
  Chip,
  IconButton,
  Menu,
  MenuItem,
  Divider,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import {
  Videocam as VideocamIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  AccountCircle as AccountCircleIcon,
  Logout as LogoutIcon,
  AdminPanelSettings as AdminIcon,
  Visibility as ViewerIcon,
} from '@mui/icons-material';

interface HeaderProps {
  currentTab: number;
  onTabChange: (tab: number) => void;
  wsConnected: boolean;
  role: string;
  username: string;
  onLogout: () => void;
}

const Header: React.FC<HeaderProps> = ({
  currentTab,
  onTabChange,
  wsConnected,
  role,
  username,
  onLogout
}) => {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const menuOpen = Boolean(anchorEl);

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
  };

  const handleLogout = () => {
    handleMenuClose();
    onLogout();
  };

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

        {/* WebSocket Status */}
        <Chip
          icon={wsConnected ? <CheckCircleIcon /> : <ErrorIcon />}
          label={wsConnected ? 'Подключено' : 'Отключено'}
          color={wsConnected ? 'success' : 'error'}
          sx={{ color: 'white', mr: 2 }}
        />

        {/* User Menu */}
        <Box display="flex" alignItems="center">
          <Chip
            icon={role === 'admin' ? <AdminIcon /> : <ViewerIcon />}
            label={role === 'admin' ? 'Администратор' : 'Наблюдатель'}
            color={role === 'admin' ? 'warning' : 'info'}
            size="small"
            sx={{ mr: 1 }}
          />
          <IconButton
            onClick={handleMenuOpen}
            sx={{ color: 'white' }}
            aria-label="user menu"
          >
            <AccountCircleIcon sx={{ fontSize: 32 }} />
          </IconButton>
        </Box>

        {/* User Dropdown Menu */}
        <Menu
          anchorEl={anchorEl}
          open={menuOpen}
          onClose={handleMenuClose}
          anchorOrigin={{
            vertical: 'bottom',
            horizontal: 'right',
          }}
          transformOrigin={{
            vertical: 'top',
            horizontal: 'right',
          }}
        >
          <Box sx={{ px: 2, py: 1 }}>
            <Typography variant="subtitle2" fontWeight="bold">
              {username}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {role === 'admin' ? 'Администратор' : 'Наблюдатель'}
            </Typography>
          </Box>
          <Divider />
          <MenuItem onClick={handleLogout}>
            <ListItemIcon>
              <LogoutIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Выйти</ListItemText>
          </MenuItem>
        </Menu>
      </Toolbar>
    </AppBar>
  );
};

export default Header;