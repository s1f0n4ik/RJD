import React, { Suspense, lazy, useState, useEffect } from 'react';
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
// import NeuralSettings from './components/NeuralSettings';
const NeuralConfigApp = lazy(() => import('./features/neural/components/NeuralConfigApp'));
const KrspsApp = lazy(() => import('./features/krsps/components/KrspsApp'));
const BirdviewApp = lazy(() =>
    import('./features/birdview/components/BirdviewApp').then(m => ({ default: m.BirdviewApp })));
import Login from './components/Login';
import KioskView from './components/KioskView';
import { wsService } from './services/websocket';
import type { SystemState } from './types';
import { RZD_COLORS } from './theme';
import { FULL_AUTH, readStoredToken } from './utils/auth';
import Observation from './components/Observation';
import RecordingsView from './components/RecordingsView';
import DeviceSettings from './components/DeviceSettings';
// Landing (развилка киоск/админка) умер: «/» решается редиректом ниже
import { getDevices } from './services/devices';
const BirdviewUnavailable = lazy(() =>
    import('./features/birdview/components/ModuleUnavailable').then(m => ({ default: m.BirdviewUnavailable })));
const NeuralUnavailable = lazy(() =>
    import('./features/neural/components/ModuleUnavailable').then(m => ({ default: m.NeuralUnavailable })));
import OnScreenKeyboard from './components/OnScreenKeyboard';
// Переписываемая оболочка живёт на /new: грузится лениво, чтобы её стили
// не попадали в документ на старых экранах
const NewApp = lazy(() => import('./app/NewApp'));
const ADMIN_TABS = new Set([1, 4]); // Камеры, Устройства
// Подроуты /app/*, требующие прав администратора
const ADMIN_ROUTES = ['neural', 'krsps', 'birdview'];

import { MergeJobsProvider, useMergeJobs } from './contexts/MergeJobsContext';
import MergeJobPanel from './components/MergeJobPanel';

const GlobalMergeJobPanel: React.FC = () => {
    const {
        activeJob, minimized, downloading, downloadProgress,
        setMinimized, cancelJob, saveAs, cancelDownload
    } = useMergeJobs();

    if (!activeJob) return null;

    return (
        <MergeJobPanel
            job={activeJob}
            minimized={minimized}
            onMinimize={() => setMinimized(true)}
            onMaximize={() => setMinimized(false)}
            onCancel={cancelJob}
            onSaveAs={saveAs}
            downloading={downloading}
            downloadProgress={downloadProgress}
            onCancelDownload={cancelDownload}
        />
    );
};

const AppContent: React.FC = () => {
  const pathname = window.location.pathname;
  const isNewUiRoute = pathname.startsWith('/new');
  // === KIOSK ROUTING ===
  // Если URL начинается с /kiosk — рендерим KioskView без Header/авторизации
  const isKioskRoute = window.location.pathname.startsWith('/kiosk');
  const isAdminRoute = pathname.startsWith('/app'); // 🆕
  const isLandingRoute = !isKioskRoute && !isAdminRoute && !isNewUiRoute; // 🆕
  const isNeuralRoute = pathname.startsWith('/app/neural');
  const isKrspsRoute = pathname.startsWith('/app/krsps');
  const isBirdviewRoute = pathname.startsWith('/app/birdview');

  const [currentTab, setCurrentTab] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [state, setState] = useState<SystemState>({
    cameras: [],
    loaders: [],
  });

  // Протухший токен отбрасывается здесь; во время работы вкладки проверка не повторяется
  const storedToken = readStoredToken();
  const [token, setToken] = useState<string | null>(storedToken);
  const [role, setRole] = useState<string | null>(storedToken && localStorage.getItem('role'));
  const [username, setUsername] = useState<string | null>(storedToken && localStorage.getItem('username'));

  // Временное повышение прав: ключ цели — 'tab:1' или 'route:neural'
  const [elevated, setElevated] = useState<string | null>(null);

  // Диалог ввода пароля админа
  const [authDialog, setAuthDialog] = useState<{ open: boolean; target: string | null }>({
    open: false,
    target: null,
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
    setElevated(null);
  };

  const openAdminDialog = (target: string) => {
    setAuthDialog({ open: true, target });
    setAdminPassword('');
    setAuthError('');
  };

  // Перехват смены вкладки: если требуется админ, а роль не админ — просим пароль
  const handleTabChange = (newTab: number) => {
    const needsAdmin = ADMIN_TABS.has(newTab);
    const isAdmin = role === 'admin';

    if (needsAdmin && !isAdmin) {
      // В защищённой сборке эскалации нет — переключаем и показываем отказ
      if (FULL_AUTH) {
        setCurrentTab(newTab);
        return;
      }
      openAdminDialog(`tab:${newTab}`);
      return;
    }

    // При уходе с защищённой вкладки — сбрасываем elevated
    if (elevated !== null && elevated !== `tab:${newTab}`) {
      setElevated(null);
    }

    setCurrentTab(newTab);
  };

  const handleAdminPasswordSubmit = async () => {
    setAuthLoading(true);
    setAuthError('');
    try {
      // Проверяем пароль админа через /auth/login (без перелогина основного пользователя)
      const response = await fetch(`/auth/login`, {
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

      // Пароль верный — временно повышаем доступ для этой цели
      const target = authDialog.target;
      setElevated(target);
      if (target?.startsWith('tab:')) {
        setCurrentTab(Number(target.slice(4)));
      }
      setAuthDialog({ open: false, target: null });
      setAdminPassword('');
    } catch (err: any) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  useEffect(() => {
    if (isNewUiRoute || isKioskRoute || isLandingRoute || isNeuralRoute || isKrspsRoute || isBirdviewRoute) return; // В киоск-режиме WS не нужен
    if (token) {
      wsService.connect(
        (newState) => setState(newState),
        (connected) => setWsConnected(connected)
      );
    }
    return () => {
      wsService.disconnect();
    };
  }, [token, isNewUiRoute, isKioskRoute, isLandingRoute, isNeuralRoute, isKrspsRoute, isBirdviewRoute]);

  const hasAccessToTab = (tab: number): boolean => {
    if (!ADMIN_TABS.has(tab)) return true;
    if (role === 'admin') return true;
    return elevated === `tab:${tab}`; // временное повышение
  };

  // showBack — для подроутов, где нет Header и уйти больше некуда
  const renderDenied = (target: string, showBack = false) => (
    <Box textAlign="center" py={8}>
      <Typography variant="h5" color="text.secondary">
        Доступ запрещён
      </Typography>
      <Typography color="text.secondary">
        Требуются права администратора
      </Typography>
      <Box mt={3} display="flex" gap={2} justifyContent="center">
        {!FULL_AUTH && (
          <Button variant="contained" onClick={() => openAdminDialog(target)}>
            Ввести пароль администратора
          </Button>
        )}
        {showBack && (
          <Button variant="outlined" onClick={() => { window.location.href = '/app'; }}>
            Вернуться
          </Button>
        )}
      </Box>
    </Box>
  );

  const adminPasswordDialog = (
    <Dialog
      open={authDialog.open}
      onClose={() => setAuthDialog({ open: false, target: null })}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>🔒 Требуется пароль администратора</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Для доступа к этому разделу введите пароль администратора.
          Доступ будет предоставлен только на время просмотра этого раздела.
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
          onClick={() => setAuthDialog({ open: false, target: null })}
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
  );

  if (isNewUiRoute) {
    return (
      <Suspense fallback={null}>
        <NewApp />
      </Suspense>
    );
  }

  // Защищённая сборка: логин требуется до любого маршрута, включая / и /kiosk
  if (FULL_AUTH && !token) {
    return (
      <>
        <Login onLogin={handleLogin} />
        <OnScreenKeyboard />
      </>
    );
  }

  if (isLandingRoute) {
    // Без FULL_AUTH «/» — это киоск; с FULL_AUTH сюда доходят уже с токеном
    // (проверка выше) и попадают на главную
    window.location.replace(FULL_AUTH ? '/app' : '/kiosk');
    return null;
  }

  // === РЕНДЕР КИОСК-РЕЖИМА ===
  if (isKioskRoute) {
    return <KioskView />;
  }

  // === РЕНДЕР ОБЫЧНОГО ИНТЕРФЕЙСА (/app/*) ===
  if (!token) {
    return (
    <>
      <Login onLogin={handleLogin} />
      <OnScreenKeyboard />
    </>
  );
  }
  // Подроуты-настройки: попадают сюда по прямому URL, минуя handleTabChange
  const adminRoute = ADMIN_ROUTES.find((r) => pathname.startsWith(`/app/${r}`)) ?? null;
  if (adminRoute && role !== 'admin' && elevated !== `route:${adminRoute}`) {
    return (
      <Box sx={{ minHeight: '100vh', bgcolor: RZD_COLORS.grey[100] }}>
        {renderDenied(`route:${adminRoute}`, true)}
        {adminPasswordDialog}
        <OnScreenKeyboard />
      </Box>
    );
  }

  // Модульные страницы доступны только при живом устройстве с нужным модулем
  const hasModule = (m: string) =>
    getDevices().some((d) => d.status === 'online' && d.modules.includes(m));

  if (isNeuralRoute) {
    return (
      <Suspense fallback={null}>
        {!hasModule('neural') ? <NeuralUnavailable /> : (
          <>
            <NeuralConfigApp />
            <OnScreenKeyboard />
          </>
        )}
      </Suspense>
    );
  }
  if (isKrspsRoute) {
    return (
      <Suspense fallback={null}>
        <KrspsApp />
        <OnScreenKeyboard />
      </Suspense>
    );
  }
  if (isBirdviewRoute) {
    return (
      <Suspense fallback={null}>
        {!hasModule('birdview') ? <BirdviewUnavailable /> : (
          <>
            <BirdviewApp />
            <OnScreenKeyboard />
          </>
        )}
      </Suspense>
    );
  }

  const renderContent = () => {
    switch (currentTab) {
      case 0:
        return <Dashboard onNavigate={handleTabChange} />;
      case 1:
        return hasAccessToTab(1) ? <CameraSettings /> : renderDenied('tab:1');
      case 2:
        return <Observation />;
      case 3:
        return <RecordingsView />;
      case 4:
        return hasAccessToTab(4) ? <DeviceSettings /> : renderDenied('tab:4');
      default:
        return <Dashboard onNavigate={handleTabChange} />;
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
      <Box sx={{ pb: 4 }}>{renderContent()}</Box>

      {/* Диалог пароля администратора */}
      {adminPasswordDialog}
      <OnScreenKeyboard />
        <GlobalMergeJobPanel />
    </Box>
  );
};

const App: React.FC = () => {
    return (
        <MergeJobsProvider>
            <AppContent />
        </MergeJobsProvider>
    );
};

export default App;