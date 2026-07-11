import React, { useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import RoomRoundedIcon from '@mui/icons-material/RoomRounded';
import { SOFT, SoftCard, PanelHead } from '../ui';
import type { GwTime } from '../types';
import { formatInt } from '../utils/format';

interface Props {
  time: GwTime | null;
  // Смещение серверного времени относительно локального (мс). Обновляется после
  // каждого ответа ручки /time; таймер тикает локально от этого смещения.
  offsetMs: number;
  synced: boolean;
}

function two(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

const KvRow: React.FC<{ k: string; v: React.ReactNode }> = ({ k, v }) => (
  <Box
    sx={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      py: 1,
      borderBottom: `1px dashed ${SOFT.border}`,
      '&:last-of-type': { borderBottom: 0 },
    }}
  >
    <Typography sx={{ fontSize: '0.8rem', color: SOFT.dim }}>{k}</Typography>
    <Typography sx={{ fontSize: '0.85rem', fontWeight: 600, color: SOFT.ink, fontVariantNumeric: 'tabular-nums', fontFamily: 'monospace' }}>
      {v}
    </Typography>
  </Box>
);

const TimeGpsPanel: React.FC<Props> = ({ time, offsetMs, synced }) => {
  const [nowMs, setNowMs] = useState(() => Date.now() + offsetMs);
  const offsetRef = useRef(offsetMs);
  offsetRef.current = offsetMs;

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now() + offsetRef.current), 100);
    return () => clearInterval(t);
  }, []);

  const d = new Date(nowMs);
  const hh = two(d.getUTCHours());
  const mm = two(d.getUTCMinutes());
  const ss = two(d.getUTCSeconds());
  const mmm = String(d.getUTCMilliseconds()).padStart(3, '0');
  const dateStr = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
  const unixS = Math.floor(nowMs / 1000);

  const gps = time?.gps;

  return (
    <Box sx={{ maxWidth: 860 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
        <Typography sx={{ fontSize: '1.2rem', fontWeight: 800, color: SOFT.ink, letterSpacing: '-0.01em' }}>
          Время и GPS
        </Typography>
        <Typography sx={{ fontSize: '0.75rem', color: SOFT.mute }}>точка входа для всех сервисов</Typography>
      </Box>

      <SoftCard>
        <PanelHead
          title="Единое время (UTC)"
          icon={<ScheduleRoundedIcon sx={{ fontSize: 18 }} />}
          right={
            <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.7, fontSize: '0.72rem', color: synced ? SOFT.ok : SOFT.mute }}>
              <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'currentColor' }} />
              {synced ? 'синхронизировано с сервером' : 'ожидание сервера'}
            </Box>
          }
        />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1.1fr 1fr' } }}>
          <Box
            sx={{
              p: 3,
              borderRight: { sm: `1px solid ${SOFT.border}` },
              borderBottom: { xs: `1px solid ${SOFT.border}`, sm: 0 },
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: 0.75,
            }}
          >
            <Typography sx={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.14em', color: SOFT.mute, fontWeight: 700 }}>
              Текущее время
            </Typography>
            <Typography
              sx={{
                fontSize: { xs: '2.2rem', md: '2.9rem' },
                fontWeight: 800,
                letterSpacing: '-0.02em',
                lineHeight: 1,
                color: SOFT.ink,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {hh}:{mm}:{ss}
              <Typography component="span" sx={{ fontSize: '0.42em', fontWeight: 700, color: SOFT.mute, ml: 0.5 }}>
                .{mmm}
              </Typography>
            </Typography>
            <Typography sx={{ fontSize: '0.85rem', color: SOFT.dim, fontFamily: 'monospace' }}>
              {dateStr} · unix {formatInt(unixS)}
            </Typography>
          </Box>

          <Box sx={{ p: 2.5, display: 'grid', alignContent: 'center' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.7, mb: 0.5, color: SOFT.accent }}>
              <RoomRoundedIcon sx={{ fontSize: 17 }} />
              <Typography sx={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: SOFT.dim, fontWeight: 700 }}>
                Координаты
              </Typography>
            </Box>
            <KvRow k="Широта" v={gps ? `${gps.lat.toFixed(4)}° N` : '—'} />
            <KvRow k="Долгота" v={gps ? `${gps.lon.toFixed(4)}° E` : '—'} />
            <KvRow k="Высота" v={gps ? `${gps.alt.toFixed(1)} м` : '—'} />
            <KvRow k="Спутники" v={gps ? `${gps.sats} · ${gps.valid ? 'фикс' : 'нет'}` : '—'} />
          </Box>
        </Box>
        <Box sx={{ px: 2.25, py: 1.5, borderTop: `1px solid ${SOFT.border}`, bgcolor: SOFT.panel2 }}>
          <Typography sx={{ fontSize: '0.72rem', color: SOFT.mute, lineHeight: 1.5 }}>
            Источник: время — {time?.source.time ?? '—'} (серверное), GPS — {time?.source.gps ?? '—'} (статическая
            заглушка). Реальный приём GNSS появится позже. Таймер идёт локально и синхронизируется по ручке /time.
          </Typography>
        </Box>
      </SoftCard>
    </Box>
  );
};

export default TimeGpsPanel;
