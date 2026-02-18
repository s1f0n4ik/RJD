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
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  AccountCircle as AccountCircleIcon,
  Logout as LogoutIcon,
  AdminPanelSettings as AdminIcon,
  Visibility as ViewerIcon,
} from '@mui/icons-material';
import { RZD_COLORS } from '../theme';

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
    <AppBar position="static" sx={{ bgcolor: RZD_COLORS.primary, mb: 3 }}>
      <Toolbar sx={{ minHeight: 70 }}>
        <Box
          component="img"
          src="/src/assets/logo.png"
          alt="РЖД"
          sx={{
            height: 40,
            mr: 2,
            filter: 'brightness(0) invert(1)', // Белый цвет для SVG
          }}
          onError={(e: any) => {
            // Если логотипа нет, показываем эмодзи
            e.target.style.display = 'none';
          }}
        />

        <Typography
          variant="h6"
          sx={{
            flexGrow: 0,
            mr: 4,
            fontWeight: 700,
            fontSize: '1.1rem',
          }}
        >
          РЖД · Система видеоаналитики
        </Typography>

        <Tabs
          value={currentTab}
          onChange={(_, newValue) => onTabChange(newValue)}
          sx={{
            flexGrow: 1,
            '& .MuiTab-root': {
              color: 'rgba(255,255,255,0.75)',
              fontWeight: 500,
            },
            '& .Mui-selected': {
              color: 'white',
              fontWeight: 600,
            },
            '& .MuiTabs-indicator': {
              backgroundColor: 'white',
              height: 3,
            },
          }}
        >
          <Tab label="Главная" />
          <Tab label="Камеры" />
          <Tab label="Загрузчики" />
          <Tab label="Статус системы" />
        </Tabs>

        {/* WebSocket Status */}
        <Chip
          icon={wsConnected ? <CheckCircleIcon /> : <ErrorIcon />}
          label={wsConnected ? 'Подключено' : 'Отключено'}
          size="small"
          sx={{
            bgcolor: wsConnected ? RZD_COLORS.success : RZD_COLORS.warning,
            color: 'white',
            mr: 2,
            fontWeight: 600,
          }}
        />

        {/* User Menu */}
        <Box display="flex" alignItems="center" gap={1}>
          <Chip
            icon={role === 'admin' ? <AdminIcon /> : <ViewerIcon />}
            label={role === 'admin' ? 'Администратор' : 'Наблюдатель'}
            size="small"
            sx={{
              bgcolor: 'rgba(255,255,255,0.2)',
              color: 'white',
              fontWeight: 600,
              '& .MuiChip-icon': { color: 'white' },
            }}
          />
          <IconButton
            onClick={handleMenuOpen}
            sx={{
              color: 'white',
              bgcolor: 'rgba(255,255,255,0.1)',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.2)' },
            }}
          >
            <AccountCircleIcon sx={{ fontSize: 28 }} />
          </IconButton>
        </Box>

        {/* User Dropdown Menu */}
        <Menu
          anchorEl={anchorEl}
          open={menuOpen}
          onClose={handleMenuClose}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          sx={{ mt: 1 }}
        >
          <Box sx={{ px: 2, py: 1.5, minWidth: 200 }}>
            <Typography variant="subtitle2" fontWeight="bold">
              {username}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {role === 'admin' ? 'Администратор' : 'Наблюдатель'}
            </Typography>
          </Box>
          <Divider />
          <MenuItem onClick={handleLogout} sx={{ py: 1.5 }}>
            <ListItemIcon>
              <LogoutIcon fontSize="small" color="error" />
            </ListItemIcon>
            <ListItemText>Выйти из системы</ListItemText>
          </MenuItem>
        </Menu>
      </Toolbar>
    </AppBar>
  );
};

export default Header;