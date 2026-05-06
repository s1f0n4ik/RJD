import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Alert,
} from '@mui/material';
import Header from './components/Header';
import Dashboard from './components/Dashboard';
import CameraSettings from './components/CameraSettings';
// import LoaderSettings from './components/LoaderSettings';
import Login from './components/Login';
import KioskView from './components/KioskView';
import { wsService } from './services/websocket';
import type { SystemState } from './types';
import { RZD_COLORS } from './theme';
import Observation from './components/Observation';
import RecordingsView from './components/RecordingsView';
import { FASTAPI_BASE } from './utils/constants';

const ADMIN_TABS = new Set([1, 3]); // Камеры, Загрузчики

const App: React.FC = () => {
  // === KIOSK ROUTING ===
  // Если URL начинается с /kiosk — рендерим KioskView без Header/авторизации
  const isKioskRoute = window.location.pathname.startsWith('/kiosk');

  const [currentTab, setCurrentTab] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [state, setState] = useState<SystemState>({
    cameras: [],
    loaders: [],
  });

  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [role, setRole] = useState<string | null>(localStorage.getItem('role'));
  const [username, setUsername] = useState<string | null>(localStorage.getItem('username'));

  // Временное повышение прав: храним id вкладки, для которой разрешён доступ
  const [elevatedTab, setElevatedTab] = useState<number | null>(null);

  // Диалог ввода пароля админа
  const [authDialog, setAuthDialog] = useState<{ open: boolean; targetTab: number }>({
    open: false,
    targetTab: 0,
  });
  const [adminPassword, setAdminPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  const handleLogin = (newToken: string, newRole: string, newUsername: string) => {
    localStorage.setItem('token', newToken);
    localStorage.setItem('role', newRole);
    localStorage.setItem('username', newUsername);
    setToken(newToken);
    setRole(newRole);
    setUsername(newUsername);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('role');
    localStorage.removeItem('username');
    setToken(null);
    setRole(null);
    setUsername(null);
    setElevatedTab(null);
  };

  // Перехват смены вкладки: если требуется админ, а роль не админ — просим пароль
  const handleTabChange = (newTab: number) => {
    const needsAdmin = ADMIN_TABS.has(newTab);
    const isAdmin = role === 'admin';

    if (needsAdmin && !isAdmin) {
      // Открываем диалог ввода пароля
      setAuthDialog({ open: true, targetTab: newTab });
      setAdminPassword('');
      setAuthError('');
      return;
    }

    // При уходе с защищённой вкладки — сбрасываем elevated
    if (elevatedTab !== null && elevatedTab !== newTab) {
      setElevatedTab(null);
    }

    setCurrentTab(newTab);
  };

  const handleAdminPasswordSubmit = async () => {
    setAuthLoading(true);
    setAuthError('');
    try {
      // Проверяем пароль админа через /auth/login (без перелогина основного пользователя)
      const response = await fetch(`${FASTAPI_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: adminPassword }),
      });

      if (!response.ok) {
        throw new Error('Неверный пароль администратора');
      }

      const data = await response.json();
      if (data.role !== 'admin') {
        throw new Error('Недостаточно прав');
      }

      // Пароль верный — временно повышаем доступ для этой вкладки
      setElevatedTab(authDialog.targetTab);
      setCurrentTab(authDialog.targetTab);
      setAuthDialog({ open: false, targetTab: 0 });
      setAdminPassword('');
    } catch (err: any) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  useEffect(() => {
    if (isKioskRoute) return; // В киоск-режиме WS не нужен
    if (token) {
      wsService.connect(
        (newState) => setState(newState),
        (connected) => setWsConnected(connected)
      );
    }
    return () => {
      wsService.disconnect();
    };
  }, [token, isKioskRoute]);

  // === РЕНДЕР КИОСК-РЕЖИМА ===
  if (isKioskRoute) {
    return <KioskView />;
  }

  // === РЕНДЕР ОБЫЧНОГО ИНТЕРФЕЙСА ===
  if (!token) {
    return <Login onLogin={handleLogin} />;
  }

  const hasAccessToTab = (tab: number): boolean => {
    if (!ADMIN_TABS.has(tab)) return true;
    if (role === 'admin') return true;
    return elevatedTab === tab; // временное повышение
  };

  const renderDenied = () => (
    <Box textAlign="center" py={8}>
      <Typography variant="h5" color="text.secondary">
        Доступ запрещён
      </Typography>
      <Typography color="text.secondary">
        Требуются права администратора
      </Typography>
    </Box>
  );

  const renderContent = () => {
    switch (currentTab) {
      case 0:
        return <Dashboard state={state} onNavigate={handleTabChange} />;
      case 1:
        return hasAccessToTab(1) ? <CameraSettings /> : renderDenied();
      case 2:
        return <Observation />;
      // case 3:
      //   return hasAccessToTab(3) ? <LoaderSettings /> : renderDenied();
      case 4:
        return <RecordingsView />;
      default:
        return <Dashboard state={state} onNavigate={handleTabChange} />;
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: RZD_COLORS.grey[100] }}>
      <Header
        currentTab={currentTab}
        onTabChange={handleTabChange}
        wsConnected={wsConnected}
        role={role || 'viewer'}
        username={username || ''}
        onLogout={handleLogout}
      />
      <Box sx={{ py: 4 }}>{renderContent()}</Box>

      {/* Диалог пароля администратора */}
      <Dialog
        open={authDialog.open}
        onClose={() => setAuthDialog({ open: false, targetTab: 0 })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>🔒 Требуется пароль администратора</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Для доступа к этой вкладке введите пароль администратора.
            Доступ будет предоставлен только на время просмотра этой вкладки.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            type="password"
            label="Пароль администратора"
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && adminPassword) handleAdminPasswordSubmit();
            }}
            disabled={authLoading}
          />
          {authError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {authError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setAuthDialog({ open: false, targetTab: 0 })}
            disabled={authLoading}
          >
            Отмена
          </Button>
          <Button
            variant="contained"
            onClick={handleAdminPasswordSubmit}
            disabled={authLoading || !adminPassword}
          >
            {authLoading ? 'Проверка...' : 'Подтвердить'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default App;