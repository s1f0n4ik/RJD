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
      <Toolbar sx={{ minHeight: 70, gap: 2 }}>
        <Box
          component="img"
          src="/assets/logo1.png"
          alt="ВНИИЖТ"
          sx={{
            height: 40,
            objectFit: 'contain',
          }}
          onError={(e: any) => {
            e.target.style.display = 'none';
          }}
        />

        <Typography
          variant="h6"
          sx={{
            fontWeight: 700,
            fontSize: '1rem',
            whiteSpace: 'nowrap',
          }}
        >
          Система видеоаналитики
        </Typography>

        <Tabs
          value={currentTab}
          onChange={(_, newValue) => onTabChange(newValue)}
          sx={{
            flexGrow: 1,
            minWidth: 0,
            '& .MuiTab-root': {
              color: 'rgba(255,255,255,0.7)',
              fontWeight: 500,
              minWidth: 100,
              fontSize: '0.9rem',
              transition: 'all 0.2s',
              '&:hover': {
                color: 'white',
                bgcolor: 'rgba(255,255,255,0.1)',
              },
            },
            '& .Mui-selected': {
              color: 'white !important',
              fontWeight: 700,
              bgcolor: 'rgba(255,255,255,0.15)',
              borderRadius: '8px 8px 0 0',
            },
            '& .MuiTabs-indicator': {
              backgroundColor: 'white',
              height: 4,
              borderRadius: '4px 4px 0 0',
            },
          }}
        >
          <Tab label="Главная" />
          <Tab label="Камеры" />
          <Tab label="Наблюдение" />
          {/*<Tab label="Машинное зрение" />*/}
          <Tab label="Архив" />
        </Tabs>

        <Box display="flex" alignItems="center" gap={1} sx={{ flexShrink: 0 }}>
          <Chip
            icon={wsConnected ? <CheckCircleIcon sx={{ fontSize: 16 }} /> : <ErrorIcon sx={{ fontSize: 16 }} />}
            label={wsConnected ? 'Онлайн' : 'Офлайн'}
            size="small"
            sx={{
              bgcolor: wsConnected ? RZD_COLORS.success : RZD_COLORS.warning,
              color: 'white',
              fontWeight: 600,
              fontSize: '0.75rem',
              height: 28,
              '& .MuiChip-icon': { color: 'white' },
            }}
          />

          <Chip
            icon={role === 'admin' ? <AdminIcon sx={{ fontSize: 16 }} /> : <ViewerIcon sx={{ fontSize: 16 }} />}
            label={role === 'admin' ? 'Админ' : 'Наблюдатель'}
            size="small"
            sx={{
              bgcolor: 'rgba(255,255,255,0.2)',
              color: 'white',
              fontWeight: 600,
              fontSize: '0.75rem',
              height: 28,
              '& .MuiChip-icon': { color: 'white' },
            }}
          />

          <IconButton
            onClick={handleMenuOpen}
            size="small"
            sx={{
              color: 'white',
              bgcolor: 'rgba(255,255,255,0.15)',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.25)' },
              width: 36,
              height: 36,
            }}
          >
            <AccountCircleIcon sx={{ fontSize: 24 }} />
          </IconButton>
        </Box>

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
            <ListItemText>Выйти</ListItemText>
          </MenuItem>
        </Menu>
      </Toolbar>
    </AppBar>
  );
};

export default Header;