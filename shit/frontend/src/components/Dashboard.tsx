import React, { useEffect, useState } from 'react';
import {
  Container,
  Card,
  CardContent,
  Grid,
  Typography,
} from '@mui/material';
import {
  Videocam as VideocamIcon,
  Search as SearchIcon,
  Memory as MemoryIcon,
  ThreeSixty as ThreeSixtyIcon,
  Settings as SettingsIcon,
  Hub as HubIcon,
  DeviceHub as DeviceHubIcon,
} from '@mui/icons-material';
import { AddToQueue } from "@mui/icons-material";
import { getDevices, loadDevices } from '../services/devices';
interface DashboardProps {
  onNavigate: (tabIndex: number) => void;
}

interface Module {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  gradient: string;
  tabIndex: number;
  disabled?: boolean;   // 👈 NEW
  kiosk?: boolean;

  externalUrl?: string;
  // Модуль media-center, без которого плитка недоступна
  requiresModule?: string;
}

const modules: Module[] = [
  {
    id: 'kiosk',
    title: 'Режим просмотра',
    description: 'Просмотр камер в реальном времени',
    icon: VideocamIcon,
    gradient: 'linear-gradient(135deg, #4caf50 0%, #2e7d32 100%)',
    tabIndex: 5,
    kiosk: true,
  },
    {
        id: 'maintain',
        title: 'Настройки',
        description: 'Настройки камер',
        icon: SettingsIcon,
        gradient: 'linear-gradient(135deg, #ff9800 0%, #e65100 100%)',
        tabIndex: 1, // CameraSettings
    },
  {
    id: 'search',
    title: 'Поиск',
    description: 'Архив записей',
    icon: SearchIcon,
    gradient: 'linear-gradient(135deg, #2196f3 0%, #1565c0 100%)',
    tabIndex: 3, // Recordings
  },
    {
        id: 'live',
        title: 'Редактор сеток',
        description: 'Изменение сеток просмотра камер для режима просмотра',
        icon: AddToQueue,
        gradient: 'linear-gradient(135deg, #757575 0%, #424242 100%)',
        tabIndex: 2,
    },
  {
      id: 'ai',
      title: 'AI',
      description: 'Компьютерное зрение',
      icon: MemoryIcon,
      gradient: 'linear-gradient(135deg, #9c27b0 0%, #6a1b9a 100%)',
      tabIndex: -1,               // ← больше не вкладка
      externalUrl: '/app/neural', // ← переход на отдельную страницу
      requiresModule: 'neural',
    },
  {
    id: 'birdview',
    title: '360°',
    description: 'Система кругового обзора',
    icon: ThreeSixtyIcon,
    gradient: 'linear-gradient(135deg, #00bcd4 0%, #0097a7 100%)',
    tabIndex: -1,
      externalUrl: '/app/birdview',
      requiresModule: 'birdview',
  },
  {
    id: 'devices',
    title: 'Устройства',
    description: 'Одноплатники системы: состояние и маршрутизация',
    icon: DeviceHubIcon,
    gradient: 'linear-gradient(135deg, #3f51b5 0%, #283593 100%)',
    tabIndex: 4, // DeviceSettings
  },
  {
    id: 'krsps',
    title: 'АС КРСПС',
    description: 'Интеграция и передача обнаружений (шлюз сообщений)',
    icon: HubIcon,
    gradient: 'linear-gradient(135deg, #E21A1A 0%, #B31515 100%)',
    tabIndex: -1,
    externalUrl: '/app/krsps',
  },
];

const Dashboard: React.FC<DashboardProps> = ({ onNavigate }) => {
  // Свежий реестр устройств: от него зависит доступность модульных плиток
  const [, setDevicesTick] = useState(0);
  useEffect(() => {
    const refresh = () =>
      loadDevices().then(() => setDevicesTick(t => t + 1)).catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  // Модуль доступен, только когда устройство с ним живо прямо сейчас
  const moduleAvailable = (module: Module) =>
    !module.requiresModule
    || getDevices().some(d => d.status === 'online' && d.modules.includes(module.requiresModule!));

  const handleModuleClick = (module: Module) => {
    // Повторная проверка на клике: реестр мог измениться после рендера
    if (module.disabled || !moduleAvailable(module)) return;

    if (module.kiosk) {
      window.location.href = '/kiosk';
      return;
    }

      if (module.externalUrl) {
          window.location.href = module.externalUrl;
          return;
      }

    if (module.tabIndex >= 0) {
      onNavigate(module.tabIndex);
    } else {
      alert(`${module.title} будет доступен в следующей версии`);
    }
  };

  return (
    <Container maxWidth="xl">
      {/* Модульная сетка 3x2 */}
      <Grid container spacing={3}>
        {modules.map((module) => {
          const Icon = module.icon;
          const unavailable = !moduleAvailable(module);
          const disabled = module.disabled || unavailable;
          return (
            <Grid item xs={12} sm={6} md={4} key={module.id}>
              <Card
                onClick={() => handleModuleClick(module)}
                sx={{
                  background: module.gradient,
                  color: 'white',
                  height: 240,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.45 : 1,
                  filter: disabled ? 'grayscale(0.7)' : 'none',
                  '&:hover': {
                    transform: disabled ? 'none' : 'translateY(-8px)',
                    boxShadow: disabled
                      ? '0 4px 20px rgba(0,0,0,0.15)'
                      : '0 12px 40px rgba(0,0,0,0.3)',
                  },
                  '&:active': {
                    transform: disabled ? 'none' : 'translateY(-4px)',
                  },
                  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                  borderRadius: 2,
                  boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                }}
              >
                <CardContent sx={{ textAlign: 'center', p: 3 }}>
                  <Icon sx={{ fontSize: 80, mb: 2, opacity: 0.95 }} />
                  <Typography
                    variant="h4"
                    fontWeight="bold"
                    gutterBottom
                    sx={{
                      textShadow: '0 2px 4px rgba(0,0,0,0.2)',
                      letterSpacing: '0.5px'
                    }}
                  >
                    {module.title}
                  </Typography>
                  <Typography
                    variant="body1"
                    sx={{
                      opacity: 0.9,
                      fontSize: '0.95rem'
                    }}
                  >
                    {unavailable
                      ? 'Модуль не запущен ни на одном устройстве'
                      : module.description}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
          );
        })}
      </Grid>

    </Container>
  );
};

export default Dashboard;