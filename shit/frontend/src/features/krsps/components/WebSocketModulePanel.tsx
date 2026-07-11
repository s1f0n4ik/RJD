import React, { useEffect, useState } from 'react';
import {
  Box,
  Grid,
  Typography,
  TextField,
  Button,
  Switch,
  FormControlLabel,
} from '@mui/material';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import FavoriteBorderRoundedIcon from '@mui/icons-material/FavoriteBorderRounded';
import { SOFT, SoftCard, PanelHead, Pill } from '../ui';
import type { PillState } from '../ui';
import type { GwModule, GwMessageRecord, GwWsConfigPatch } from '../types';
import { formatInt, formatBytes, formatClock } from '../utils/format';

interface Props {
  module: GwModule;
  busy: boolean;
  onSave: (patch: GwWsConfigPatch) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

// Разбор адреса вида ws://host:port/target (схема и target опциональны).
function parseWsUrl(raw: string): { host: string; port: string; target: string } | null {
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^wss?:\/\//i, '');
  const slash = s.indexOf('/');
  const target = slash >= 0 ? s.slice(slash) : '/ws/frames';
  const hostPort = slash >= 0 ? s.slice(0, slash) : s;
  const colon = hostPort.lastIndexOf(':');
  if (colon < 0) return null;
  const host = hostPort.slice(0, colon);
  const port = hostPort.slice(colon + 1);
  if (!host || !/^\d+$/.test(port)) return null;
  return { host, port, target };
}

function connState(m: GwModule): PillState {
  if (m.connection.connected) return 'ok';
  if (m.connection.enabled) return 'wait';
  return 'off';
}

const inputSx = {
  '& .MuiOutlinedInput-root': {
    borderRadius: SOFT.radiusXs,
    bgcolor: SOFT.panel2,
    '& fieldset': { borderColor: SOFT.border },
    '&:hover fieldset': { borderColor: SOFT.borderStrong },
    '&.Mui-focused fieldset': { borderColor: SOFT.accent },
  },
} as const;

const Kpi: React.FC<{ label: string; value: string; unit?: string }> = ({ label, value, unit }) => (
  <Box
    sx={{
      bgcolor: SOFT.panel,
      boxShadow: SOFT.shadow,
      borderRadius: SOFT.radiusSm,
      px: 1.75,
      py: 1.5,
      height: '100%',
    }}
  >
    <Typography sx={{ fontSize: '0.72rem', color: SOFT.dim, fontWeight: 600 }}>{label}</Typography>
    <Typography
      sx={{
        fontSize: '1.55rem',
        fontWeight: 800,
        letterSpacing: '-0.02em',
        mt: 0.4,
        color: SOFT.ink,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {value}
      {unit && (
        <Typography component="span" sx={{ fontSize: '0.82rem', fontWeight: 600, color: SOFT.mute, ml: 0.4 }}>
          {unit}
        </Typography>
      )}
    </Typography>
  </Box>
);

function detWord(n: number): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'обнаружений';
  if (b > 1 && b < 5) return 'обнаружения';
  if (b === 1) return 'обнаружение';
  return 'обнаружений';
}

const RecordRow: React.FC<{ r: GwMessageRecord }> = ({ r }) => {
  const rejected = r.status === 'rejected';
  const heartbeat = r.kind === 'heartbeat';

  const icon = rejected ? (
    <CloseRoundedIcon sx={{ fontSize: 15 }} />
  ) : heartbeat ? (
    <FavoriteBorderRoundedIcon sx={{ fontSize: 14 }} />
  ) : (
    <CheckRoundedIcon sx={{ fontSize: 15 }} />
  );

  const fg = rejected ? SOFT.accent : heartbeat ? SOFT.dim : SOFT.ok;
  const bg = rejected ? SOFT.accentTint : heartbeat ? SOFT.panel2 : SOFT.okTint;

  const title = heartbeat
    ? 'heartbeat'
    : rejected
    ? `#${r.id} · отклонено`
    : `#${r.id} · ${r.detections} ${detWord(r.detections)}`;

  const sub = rejected
    ? `${formatClock(r.ts)} · v${r.ver} · ${r.error ?? 'отклонено'}`
    : heartbeat
    ? `${formatClock(r.ts)} · v${r.ver} · служебное`
    : `${formatClock(r.ts)} · v${r.ver} · КАУС принял`;

  const size = rejected ? '—' : bytesShort(r.wire_size);

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        gap: 1.4,
        alignItems: 'center',
        px: 2.25,
        py: 1.15,
        borderBottom: `1px solid ${SOFT.border}`,
        '&:last-of-type': { borderBottom: 0 },
      }}
    >
      <Box sx={{ width: 26, height: 26, borderRadius: SOFT.radiusXs, display: 'grid', placeItems: 'center', color: fg, bgcolor: bg }}>
        {icon}
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: SOFT.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {title}
        </Typography>
        <Typography sx={{ fontSize: '0.72rem', color: SOFT.mute, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {sub}
        </Typography>
      </Box>
      <Typography sx={{ fontSize: '0.8rem', color: SOFT.dim, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {size}
      </Typography>
    </Box>
  );
};

const WebSocketModulePanel: React.FC<Props> = ({ module, busy, onSave, onConnect, onDisconnect }) => {
  const [url, setUrl] = useState('');
  const [heartbeat, setHeartbeat] = useState('5');
  const [enabled, setEnabled] = useState(true);
  const [urlError, setUrlError] = useState('');

  useEffect(() => {
    setUrl(module.connection.url);
    setHeartbeat(String(module.heartbeat_sec));
    setEnabled(module.connection.enabled);
  }, [module.connection.url, module.heartbeat_sec, module.connection.enabled]);

  const handleSave = () => {
    const parsed = parseWsUrl(url);
    if (!parsed) {
      setUrlError('Ожидается адрес вида ws://host:port/target');
      return;
    }
    setUrlError('');
    const hb = parseInt(heartbeat, 10);
    onSave({
      host: parsed.host,
      port: parsed.port,
      target: parsed.target,
      enabled,
      heartbeat_sec: Number.isFinite(hb) ? hb : undefined,
    });
  };

  const stats = module.stats;
  const bytes = formatBytes(stats.bytes);

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
        <Typography sx={{ fontSize: '1.2rem', fontWeight: 800, color: SOFT.ink, letterSpacing: '-0.01em' }}>
          WebSocket → КАУС
        </Typography>
        <Pill state={connState(module)} />
        <Typography sx={{ ml: 'auto', fontSize: '0.75rem', color: SOFT.mute }}>
          протокол {module.protocol_versions.map((v) => `v${v}`).join(', ') || '—'}
        </Typography>
      </Box>

      <Grid container spacing={2.5}>
        {/* Настройки — прямо здесь, на главной странице модуля. */}
        <Grid item xs={12} md={5}>
          <SoftCard>
            <PanelHead title="Настройки передачи" />
            <Box sx={{ p: 2.25, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <TextField
                label="Адрес WebSocket (КАУС)"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="ws://192.168.1.50:8080/ws/frames"
                fullWidth
                size="small"
                error={!!urlError}
                helperText={urlError || 'Можно менять как угодно'}
                sx={inputSx}
                InputProps={{ sx: { fontFamily: 'monospace', fontSize: '0.85rem' } }}
              />
              <TextField
                label="Сообщение heartbeat, с"
                value={heartbeat}
                onChange={(e) => setHeartbeat(e.target.value.replace(/[^\d]/g, ''))}
                size="small"
                sx={{ ...inputSx, width: 180 }}
                InputProps={{ sx: { fontFamily: 'monospace' } }}
              />
              <FormControlLabel
                control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} color="primary" />}
                label="Передача обнаружений включена"
                sx={{ '& .MuiFormControlLabel-label': { fontSize: '0.85rem', color: SOFT.dim } }}
              />
              <Box sx={{ display: 'flex', gap: 1.25, flexWrap: 'wrap', pt: 0.25 }}>
                <Button
                  variant="contained"
                  onClick={handleSave}
                  disabled={busy}
                  sx={{ bgcolor: SOFT.accent, borderRadius: SOFT.radiusXs, boxShadow: 'none', textTransform: 'none', fontWeight: 700, '&:hover': { bgcolor: SOFT.accentDark, boxShadow: 'none' } }}
                >
                  Сохранить
                </Button>
                <Button
                  variant="outlined"
                  onClick={onConnect}
                  disabled={busy}
                  sx={{ borderRadius: SOFT.radiusXs, textTransform: 'none', fontWeight: 700, color: SOFT.dim, borderColor: SOFT.borderStrong, '&:hover': { borderColor: SOFT.dim } }}
                >
                  Переподключить
                </Button>
                <Button
                  variant="text"
                  onClick={onDisconnect}
                  disabled={busy}
                  sx={{ borderRadius: SOFT.radiusXs, textTransform: 'none', fontWeight: 700, color: SOFT.mute, '&:hover': { color: SOFT.accent, bgcolor: SOFT.accentTint } }}
                >
                  Отключить
                </Button>
              </Box>
            </Box>
          </SoftCard>
        </Grid>

        {/* Состояние: счётчики + последние сообщения. */}
        <Grid item xs={12} md={7}>
          <Grid container spacing={1.75} sx={{ mb: 2.25 }}>
            <Grid item xs={6} sm={3}><Kpi label="Отдано" value={formatInt(stats.messages)} /></Grid>
            <Grid item xs={6} sm={3}><Kpi label="Обнаружений" value={formatInt(stats.detections)} /></Grid>
            <Grid item xs={6} sm={3}><Kpi label="Изображений" value={formatInt(stats.images)} /></Grid>
            <Grid item xs={6} sm={3}><Kpi label="Передано" value={bytes.value} unit={bytes.unit} /></Grid>
          </Grid>

          <SoftCard>
            <PanelHead
              title="Последние сообщения"
              right={
                <Typography sx={{ fontSize: '0.72rem', color: SOFT.mute }}>
                  отклонено {formatInt(stats.rejected)} · {stats.recent.length} записей
                </Typography>
              }
            />
            {stats.recent.length > 0 ? (
              <Box>
                {stats.recent.map((r) => (
                  <RecordRow key={r.seq} r={r} />
                ))}
              </Box>
            ) : (
              <Box sx={{ px: 2.25, py: 5, textAlign: 'center' }}>
                <Typography sx={{ color: SOFT.mute, fontSize: '0.85rem' }}>
                  Сообщений пока не было
                </Typography>
              </Box>
            )}
          </SoftCard>
        </Grid>
      </Grid>
    </Box>
  );
};

function bytesShort(n: number): string {
  const { value, unit } = formatBytes(n);
  return `${value} ${unit}`;
}

export default WebSocketModulePanel;
