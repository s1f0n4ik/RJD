import React from 'react';
import { Box, Paper, styled } from '@mui/material';
import { RZD_COLORS } from '../../theme';

// Направление оформления «Тёплый свет»: тёплый почти-белый фон, белые карточки
// с мягкой тенью и крупным скруглением, статусы-пилюли, красный РЖД как акцент.
export const SOFT = {
  bg: '#F6F4F2',
  panel: '#FFFFFF',
  panel2: '#F5F6F7',
  border: '#ECE8E5',
  borderStrong: '#E1DCD8',
  ink: '#2A3742',
  dim: '#5A6A75',
  mute: '#94A1AB',
  accent: RZD_COLORS.primary,
  accentDark: RZD_COLORS.primaryDark,
  accentTint: '#FDECEC',
  accentTint2: '#FBE3E3',
  ok: '#3AA759',
  okTint: '#EAF6EE',
  warn: '#D9822B',
  warnTint: '#FBF0E3',
  radius: '16px',
  radiusSm: '11px',
  radiusXs: '8px',
  shadow: '0 1px 2px rgba(30,40,50,.05), 0 10px 26px -14px rgba(30,40,50,.18)',
  shadowLg: '0 2px 4px rgba(30,40,50,.05), 0 22px 48px -22px rgba(30,40,50,.26)',
} as const;

export const SoftCard = styled(Paper)(() => ({
  backgroundColor: SOFT.panel,
  border: '1px solid transparent',
  borderRadius: SOFT.radius,
  boxShadow: SOFT.shadow,
  overflow: 'hidden',
}));

// Заголовок панели: мягкая подпись, опционально действие справа.
export const PanelHead: React.FC<{
  title: React.ReactNode;
  right?: React.ReactNode;
  icon?: React.ReactNode;
}> = ({ title, right, icon }) => (
  <Box
    sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 1,
      px: 2.25,
      py: 1.75,
      borderBottom: `1px solid ${SOFT.border}`,
    }}
  >
    {icon && <Box sx={{ display: 'inline-flex', color: SOFT.accent }}>{icon}</Box>}
    <Box sx={{ fontWeight: 700, fontSize: '0.92rem', color: SOFT.ink }}>{title}</Box>
    {right && (
      <Box sx={{ ml: 'auto', display: 'inline-flex', alignItems: 'center' }}>{right}</Box>
    )}
  </Box>
);

export type PillState = 'ok' | 'off' | 'wait';

const PILL: Record<PillState, { fg: string; bg: string; label: string }> = {
  ok: { fg: SOFT.ok, bg: SOFT.okTint, label: 'Соединено' },
  wait: { fg: SOFT.warn, bg: SOFT.warnTint, label: 'Подключение' },
  off: { fg: SOFT.mute, bg: SOFT.panel2, label: 'Нет связи' },
};

// Статус-пилюля с точкой; в состоянии ok точка мягко пульсирует.
export const Pill: React.FC<{ state: PillState; label?: string }> = ({ state, label }) => {
  const p = PILL[state];
  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.9,
        px: 1.3,
        py: 0.55,
        borderRadius: 999,
        bgcolor: p.bg,
        color: p.fg,
        fontSize: '0.74rem',
        fontWeight: 700,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      <Box
        sx={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          bgcolor: 'currentColor',
          '@media (prefers-reduced-motion: no-preference)': {
            animation: state === 'ok' ? 'krspsPulse 2s ease-out infinite' : 'none',
          },
          '@keyframes krspsPulse': {
            '0%': { boxShadow: `0 0 0 0 ${p.fg}66` },
            '70%': { boxShadow: `0 0 0 6px ${p.fg}00` },
            '100%': { boxShadow: `0 0 0 0 ${p.fg}00` },
          },
        }}
      />
      {label ?? p.label}
    </Box>
  );
};
