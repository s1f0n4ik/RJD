import React from 'react';
import { Box, ButtonBase } from '@mui/material';
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded';
import SettingsInputComponentRoundedIcon from '@mui/icons-material/SettingsInputComponentRounded';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import { SOFT } from '../ui';
import type { GwModule } from '../types';

export const TIME_SECTION = 'time';

interface Props {
  modules: GwModule[];
  selected: string;
  onSelect: (id: string) => void;
}

function moduleIcon(transport: string) {
  if (transport === 'websocket') return <SwapHorizRoundedIcon sx={{ fontSize: 19 }} />;
  return <SettingsInputComponentRoundedIcon sx={{ fontSize: 19 }} />;
}

const RailItem: React.FC<{
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  dot?: 'ok' | 'off';
}> = ({ active, icon, label, onClick, dot }) => (
  <ButtonBase
    onClick={onClick}
    sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 1.1,
      width: '100%',
      justifyContent: 'flex-start',
      textAlign: 'left',
      px: 1.5,
      py: 1.15,
      borderRadius: SOFT.radiusSm,
      fontSize: '0.88rem',
      fontWeight: active ? 800 : 600,
      color: active ? SOFT.accentDark : SOFT.dim,
      background: active ? `linear-gradient(180deg, ${SOFT.accentTint}, ${SOFT.accentTint2})` : 'transparent',
      transition: 'background .15s, color .15s',
      '&:hover': { background: active ? undefined : SOFT.panel2, color: active ? undefined : SOFT.ink },
    }}
  >
    <Box sx={{ display: 'inline-flex', color: active ? SOFT.accent : SOFT.mute }}>{icon}</Box>
    <Box component="span" sx={{ flex: 1 }}>{label}</Box>
    {dot && (
      <Box
        sx={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          bgcolor: dot === 'ok' ? SOFT.ok : SOFT.border,
        }}
      />
    )}
  </ButtonBase>
);

const railLabelSx = {
  fontSize: '0.66rem',
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  color: SOFT.mute,
  fontWeight: 700,
  px: 1.5,
  pt: 1.5,
  pb: 0.75,
} as const;

const ModuleRail: React.FC<Props> = ({ modules, selected, onSelect }) => {
  return (
    <Box
      sx={{
        bgcolor: SOFT.panel,
        border: '1px solid transparent',
        borderRadius: SOFT.radius,
        boxShadow: SOFT.shadow,
        p: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.4,
        alignSelf: 'flex-start',
        position: { md: 'sticky' },
        top: { md: 16 },
      }}
    >
      <Box sx={railLabelSx}>Модули конфигурации</Box>
      {modules.map((m) => (
        <RailItem
          key={m.id}
          active={selected === m.id}
          icon={moduleIcon(m.transport)}
          label={m.title}
          dot={m.connection.connected ? 'ok' : 'off'}
          onClick={() => onSelect(m.id)}
        />
      ))}
      {modules.length === 0 && (
        <Box sx={{ px: 1.5, py: 1.5, fontSize: '0.8rem', color: SOFT.mute }}>
          В конфигурации нет модулей
        </Box>
      )}

      <Box sx={{ height: '1px', bgcolor: SOFT.border, mx: 1, my: 0.75 }} />

      <Box sx={railLabelSx}>Сервис</Box>
      <RailItem
        active={selected === TIME_SECTION}
        icon={<ScheduleRoundedIcon sx={{ fontSize: 19 }} />}
        label="Время и GPS"
        onClick={() => onSelect(TIME_SECTION)}
      />
    </Box>
  );
};

export default ModuleRail;
