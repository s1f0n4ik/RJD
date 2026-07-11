import React from 'react';
import { Box, ButtonBase } from '@mui/material';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import { SOFT } from '../ui';

export type KrspsView = 'modules' | 'configs';

interface Props {
  configTitle: string;
  view: KrspsView;
  onOpenConfigs: () => void;
  onBackToModules: () => void;
}

const TopBar: React.FC<Props> = ({ configTitle, view, onOpenConfigs, onBackToModules }) => {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: { xs: 2, md: 3 },
        py: 1.25,
        bgcolor: SOFT.panel,
        borderBottom: `1px solid ${SOFT.border}`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.4 }}>
        <Box
          sx={{
            width: 38,
            height: 38,
            borderRadius: SOFT.radiusXs,
            display: 'grid',
            placeItems: 'center',
            bgcolor: SOFT.accent,
            color: '#fff',
            fontWeight: 800,
            fontSize: '0.9rem',
          }}
        >
          КР
        </Box>
        <Box sx={{ lineHeight: 1.15 }}>
          <Box sx={{ fontWeight: 800, fontSize: '1rem', color: SOFT.ink }}>АС КРСПС</Box>
          <Box sx={{ fontSize: '0.72rem', color: SOFT.mute }}>Шлюз сообщений</Box>
        </Box>
      </Box>

      {/* Активная конфигурация — единственный красный акцент в хедере. */}
      <ButtonBase
        onClick={onOpenConfigs}
        sx={{
          ml: { xs: 0, md: 1 },
          display: 'inline-flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 0.75,
          borderRadius: 999,
          background: `linear-gradient(180deg, ${SOFT.accentTint}, ${SOFT.accentTint2})`,
          color: SOFT.accentDark,
          fontSize: '0.8rem',
          fontWeight: 600,
          transition: 'filter .15s',
          '&:hover': { filter: 'brightness(0.98)' },
        }}
      >
        <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: SOFT.accent }} />
        <Box component="span" sx={{ color: SOFT.dim, fontWeight: 500 }}>
          Конфигурация:
        </Box>
        <Box component="span" sx={{ fontWeight: 800 }}>
          {configTitle}
        </Box>
      </ButtonBase>

      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 0.5 }}>
        {view === 'configs' ? (
          <ButtonBase
            onClick={onBackToModules}
            sx={navLinkSx}
          >
            <ArrowBackRoundedIcon sx={{ fontSize: 17 }} />
            К модулям
          </ButtonBase>
        ) : (
          <ButtonBase onClick={onOpenConfigs} sx={navLinkSx}>
            <TuneRoundedIcon sx={{ fontSize: 17 }} />
            Конфигурации
          </ButtonBase>
        )}
        <ButtonBase
          onClick={() => {
            window.location.href = '/app';
          }}
          sx={navLinkSx}
        >
          На главную
        </ButtonBase>
      </Box>
    </Box>
  );
};

const navLinkSx = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 0.6,
  px: 1.4,
  py: 0.8,
  borderRadius: SOFT.radiusXs,
  fontSize: '0.82rem',
  fontWeight: 600,
  color: SOFT.dim,
  transition: 'background .15s, color .15s',
  '&:hover': { bgcolor: SOFT.panel2, color: SOFT.ink },
} as const;

export default TopBar;
