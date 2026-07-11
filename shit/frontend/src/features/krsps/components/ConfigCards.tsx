import React from 'react';
import { Box, Typography, Button } from '@mui/material';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import { SOFT } from '../ui';
import type { GwIntegrations, GwIntegrationItem } from '../types';

interface Props {
  integrations: GwIntegrations | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onOpenModules: () => void;
}

const Chip: React.FC<{ label: string }> = ({ label }) => (
  <Box
    sx={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 0.6,
      px: 1.1,
      py: 0.5,
      borderRadius: 999,
      bgcolor: SOFT.panel2,
      border: `1px solid ${SOFT.border}`,
      fontSize: '0.72rem',
      fontWeight: 600,
      color: SOFT.dim,
    }}
  >
    <Box sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: SOFT.accent }} />
    {label}
  </Box>
);

const ConfigCard: React.FC<{
  item: GwIntegrationItem;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onOpenModules: () => void;
}> = ({ item, active, busy, onSelect, onOpenModules }) => (
  <Box
    sx={{
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      gap: 1.5,
      p: 2.5,
      bgcolor: SOFT.panel,
      borderRadius: SOFT.radius,
      boxShadow: active ? SOFT.shadowLg : SOFT.shadow,
      border: `1.5px solid ${active ? SOFT.accent : 'transparent'}`,
      overflow: 'hidden',
    }}
  >
    <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
      <Box>
        <Typography sx={{ fontSize: '1.1rem', fontWeight: 800, color: SOFT.ink }}>{item.title}</Typography>
        <Typography sx={{ fontSize: '0.72rem', color: SOFT.mute, fontFamily: 'monospace', mt: 0.25 }}>{item.id}</Typography>
      </Box>
      {active ? (
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.5, borderRadius: 999, bgcolor: SOFT.okTint, color: SOFT.ok, fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          <CheckCircleRoundedIcon sx={{ fontSize: 14 }} /> Активна
        </Box>
      ) : (
        <Box sx={{ px: 1, py: 0.5, borderRadius: 999, bgcolor: SOFT.panel2, border: `1px solid ${SOFT.border}`, color: SOFT.mute, fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Доступна
        </Box>
      )}
    </Box>

    <Typography sx={{ fontSize: '0.82rem', color: SOFT.dim, lineHeight: 1.5, minHeight: 38 }}>
      {item.description || 'Конфигурация интеграции с АС КРСПС.'}
    </Typography>

    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
      {item.modules.map((m) => (
        <Chip key={m.id} label={m.title} />
      ))}
      {item.modules.length === 0 && <Chip label="без модулей" />}
    </Box>

    <Box sx={{ mt: 'auto', pt: 0.5 }}>
      {active ? (
        <Button
          fullWidth
          variant="outlined"
          onClick={onOpenModules}
          sx={{ borderRadius: SOFT.radiusXs, textTransform: 'none', fontWeight: 700, color: SOFT.accentDark, borderColor: SOFT.accentTint2, '&:hover': { borderColor: SOFT.accent, bgcolor: SOFT.accentTint } }}
        >
          Настроить модули
        </Button>
      ) : (
        <Button
          fullWidth
          variant="contained"
          disabled={busy}
          onClick={onSelect}
          sx={{ borderRadius: SOFT.radiusXs, textTransform: 'none', fontWeight: 700, boxShadow: 'none', bgcolor: SOFT.accent, '&:hover': { bgcolor: SOFT.accentDark, boxShadow: 'none' } }}
        >
          Сделать активной
        </Button>
      )}
    </Box>
  </Box>
);

const ConfigCards: React.FC<Props> = ({ integrations, busy, onSelect, onOpenModules }) => {
  const items = integrations?.items ?? [];
  const activeId = integrations?.active;

  return (
    <Box>
      <Box sx={{ mb: 2.5 }}>
        <Typography sx={{ fontSize: '1.3rem', fontWeight: 800, color: SOFT.ink, letterSpacing: '-0.01em' }}>
          Конфигурации
        </Typography>
        <Typography sx={{ fontSize: '0.85rem', color: SOFT.dim, mt: 0.5 }}>
          Конфигурация задаёт набор модулей и их настройки по умолчанию. Активная конфигурация обрабатывает
          кадры от других сервисов.
        </Typography>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' },
          gap: 2,
        }}
      >
        {items.map((it) => (
          <ConfigCard
            key={it.id}
            item={it}
            active={it.id === activeId}
            busy={busy}
            onSelect={() => onSelect(it.id)}
            onOpenModules={onOpenModules}
          />
        ))}
        {items.length === 0 && (
          <Typography sx={{ color: SOFT.mute, fontSize: '0.85rem' }}>Нет доступных конфигураций</Typography>
        )}
      </Box>
    </Box>
  );
};

export default ConfigCards;
