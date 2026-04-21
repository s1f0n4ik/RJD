import React, { useMemo, useRef, useEffect, useState } from 'react';
import { Box, Slider, Typography, ToggleButtonGroup, ToggleButton, Chip } from '@mui/material';
import { RZD_COLORS } from '../theme';

interface Recording {
  filename: string;
  size: number;
  created: string;
  modified: string;
}

interface RecordingsTimelineProps {
  camera: string;
  date: Date;
  files: Recording[];
  currentTime?: number; // в минутах от начала дня (0..1440); undefined = нет playhead
  onSeek: (file: Recording) => void;
  selectionMode: boolean;
  selectedRange: { start: number; end: number } | null;
  onRangeSelected: (range: { start: number; end: number }) => void;
}

// Длина одного сегмента по умолчанию (мин). В будущем можно считать из метаданных.
const DEFAULT_SEGMENT_MINUTES = 10;

// Доступные масштабы (ширина окна в минутах)
const ZOOM_OPTIONS: { label: string; minutes: number }[] = [
  { label: '24ч', minutes: 24 * 60 },
  { label: '6ч', minutes: 6 * 60 },
  { label: '1ч', minutes: 60 },
  { label: '15м', minutes: 15 },
];

const RecordingsTimeline: React.FC<RecordingsTimelineProps> = ({
  camera,
  date,
  files,
  currentTime,
  onSeek,
  selectionMode,
  selectedRange,
  onRangeSelected,
}) => {
  const [windowMinutes, setWindowMinutes] = useState<number>(24 * 60);
  const [windowStart, setWindowStart] = useState<number>(0); // начало видимого окна (мин от 00:00)
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; windowStart: number } | null>(null);

  // Преобразование ISO-времени файла в минуты от начала дня
  const fileToMinutes = (iso: string): number => {
    const d = new Date(iso);
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  };

  const segments = useMemo(() => {
    return files.map(f => {
      const start = fileToMinutes(f.created);
      return {
        file: f,
        start,
        end: start + DEFAULT_SEGMENT_MINUTES,
      };
    });
  }, [files]);

  // Центрирование окна на currentTime при смене масштаба / при смене воспроизводимого файла
  useEffect(() => {
    if (currentTime === undefined || currentTime === null) {
      // Если нет playhead — центрируем на первом сегменте, если есть
      if (segments.length > 0 && windowMinutes < 24 * 60) {
        const centerOn = segments[0].start;
        centerWindowOn(centerOn);
      }
      return;
    }
    centerWindowOn(currentTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, windowMinutes]);

  const centerWindowOn = (minute: number) => {
    const half = windowMinutes / 2;
    let ws = minute - half;
    ws = Math.max(0, Math.min(1440 - windowMinutes, ws));
    setWindowStart(ws);
  };

  const windowEnd = windowStart + windowMinutes;

  // Перевод "минут от 00:00" в X-пиксели относительно контейнера
  const minuteToPx = (minute: number, containerWidth: number): number => {
    return ((minute - windowStart) / windowMinutes) * containerWidth;
  };

  const pxToMinute = (x: number, containerWidth: number): number => {
    return windowStart + (x / containerWidth) * windowMinutes;
  };

  // Drag для прокрутки timeline (только когда не selectionMode)
  const handleMouseDown = (e: React.MouseEvent) => {
    if (selectionMode) return;
    isDraggingRef.current = true;
    dragStartRef.current = { x: e.clientX, windowStart };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current || !dragStartRef.current || !containerRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const w = containerRef.current.clientWidth;
    const dMinutes = -(dx / w) * windowMinutes;
    let ws = dragStartRef.current.windowStart + dMinutes;
    ws = Math.max(0, Math.min(1440 - windowMinutes, ws));
    setWindowStart(ws);
  };

  const endDrag = () => {
    isDraggingRef.current = false;
    dragStartRef.current = null;
  };

  // Колесо мыши — прокрутка по времени
  const handleWheel = (e: React.WheelEvent) => {
    if (selectionMode) return;
    const delta = e.deltaY > 0 ? windowMinutes * 0.1 : -windowMinutes * 0.1;
    let ws = windowStart + delta;
    ws = Math.max(0, Math.min(1440 - windowMinutes, ws));
    setWindowStart(ws);
  };

  // Клик по сегменту → seek
  const handleSegmentClick = (e: React.MouseEvent, file: Recording) => {
    if (selectionMode) return;
    e.stopPropagation();
    onSeek(file);
  };

  // Форматирование минут в HH:MM
  const formatMinutes = (m: number): string => {
    const h = Math.floor(m / 60);
    const min = Math.floor(m % 60);
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };

  // Тики времени для отображения
  const ticks = useMemo(() => {
    // Подбираем шаг тиков в зависимости от масштаба
    let step = 60; // минут
    if (windowMinutes <= 30) step = 5;
    else if (windowMinutes <= 120) step = 15;
    else if (windowMinutes <= 360) step = 30;
    else if (windowMinutes <= 720) step = 60;
    else step = 120;

    const result: number[] = [];
    const firstTick = Math.ceil(windowStart / step) * step;
    for (let t = firstTick; t <= windowEnd; t += step) {
      result.push(t);
    }
    return result;
  }, [windowStart, windowMinutes, windowEnd]);

  // === Двухсторонний слайдер для выбора диапазона ===
  // Работает в координатах всего дня (0..1440), но "виртуально",
  // чтобы пользователь мог выбирать диапазон только в пределах текущего окна просмотра.
  const handleRangeSliderChange = (_: Event, value: number | number[]) => {
    if (!Array.isArray(value)) return;
    const [start, end] = value;
    onRangeSelected({ start, end });
  };

  // Значение по умолчанию для слайдера при входе в selectionMode
  const sliderValue: [number, number] = selectedRange
    ? [selectedRange.start, selectedRange.end]
    : [windowStart + windowMinutes * 0.25, windowStart + windowMinutes * 0.75];

  return (
    <Box>
      {/* Панель управления масштабом */}
      <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
        <Typography variant="subtitle2" fontWeight="bold">
          ⏱ Timeline: {date.toLocaleDateString('ru-RU')}
        </Typography>
        <Box display="flex" alignItems="center" gap={1}>
          <Typography variant="caption" color="text.secondary">
            {formatMinutes(windowStart)} – {formatMinutes(windowEnd)}
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={windowMinutes}
            onChange={(_, v) => v && setWindowMinutes(v)}
          >
            {ZOOM_OPTIONS.map(opt => (
              <ToggleButton key={opt.minutes} value={opt.minutes}>
                {opt.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>
      </Box>

      {/* Сам timeline */}
      <Box
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onWheel={handleWheel}
        sx={{
          position: 'relative',
          width: '100%',
          height: 64,
          bgcolor: 'grey.100',
          borderRadius: 1,
          overflow: 'hidden',
          cursor: selectionMode ? 'default' : 'grab',
          userSelect: 'none',
          '&:active': {
            cursor: selectionMode ? 'default' : 'grabbing',
          },
        }}
      >
        {/* Фон с тиками */}
        {containerRef.current &&
          ticks.map(t => {
            const w = containerRef.current!.clientWidth;
            const x = minuteToPx(t, w);
            return (
              <Box
                key={t}
                sx={{
                  position: 'absolute',
                  left: x,
                  top: 0,
                  bottom: 0,
                  width: '1px',
                  bgcolor: 'grey.300',
                }}
              >
                <Typography
                  variant="caption"
                  sx={{
                    position: 'absolute',
                    top: 2,
                    left: 3,
                    fontSize: '0.65rem',
                    color: 'text.secondary',
                    pointerEvents: 'none',
                  }}
                >
                  {formatMinutes(t)}
                </Typography>
              </Box>
            );
          })}

        {/* Сегменты записей */}
        {containerRef.current &&
          segments.map(seg => {
            const w = containerRef.current!.clientWidth;
            // Отсекаем сегменты вне окна
            if (seg.end < windowStart || seg.start > windowEnd) return null;
            const visibleStart = Math.max(seg.start, windowStart);
            const visibleEnd = Math.min(seg.end, windowEnd);
            const x = minuteToPx(visibleStart, w);
            const width = Math.max(2, minuteToPx(visibleEnd, w) - x);

            return (
              <Box
                key={seg.file.filename}
                onClick={(e) => handleSegmentClick(e, seg.file)}
                sx={{
                  position: 'absolute',
                  top: 20,
                  height: 32,
                  left: x,
                  width,
                  bgcolor: RZD_COLORS.secondary,
                  opacity: 0.7,
                  borderRadius: 0.5,
                  cursor: selectionMode ? 'default' : 'pointer',
                  transition: 'opacity 0.15s',
                  '&:hover': {
                    opacity: selectionMode ? 0.7 : 1,
                  },
                }}
                title={`${seg.file.filename} • ${formatMinutes(seg.start)}`}
              />
            );
          })}

        {/* Playhead (текущая позиция воспроизведения) */}
        {currentTime !== undefined &&
          currentTime >= windowStart &&
          currentTime <= windowEnd &&
          containerRef.current && (
            <Box
              sx={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: minuteToPx(currentTime, containerRef.current.clientWidth),
                width: '2px',
                bgcolor: 'error.main',
                boxShadow: '0 0 4px rgba(255,0,0,0.5)',
                pointerEvents: 'none',
                zIndex: 3,
              }}
            />
          )}
      </Box>

      {/* Двухсторонний слайдер для выбора диапазона */}
      {selectionMode && (
        <Box sx={{ px: 2, pt: 2 }}>
          <Typography variant="caption" color="text.secondary">
            Перетащите ручки для выбора диапазона склейки
          </Typography>
          <Slider
            value={sliderValue}
            onChange={handleRangeSliderChange}
            min={windowStart}
            max={windowEnd}
            step={1}
            valueLabelDisplay="auto"
            valueLabelFormat={(v) => formatMinutes(v)}
            sx={{ mt: 1 }}
          />
          {selectedRange && (
            <Box display="flex" gap={1} mt={1}>
              <Chip
                size="small"
                color="success"
                label={`Начало: ${formatMinutes(selectedRange.start)}`}
              />
              <Chip
                size="small"
                color="success"
                label={`Конец: ${formatMinutes(selectedRange.end)}`}
              />
              <Chip
                size="small"
                color="primary"
                variant="outlined"
                label={`Длительность: ${Math.round(selectedRange.end - selectedRange.start)} мин`}
              />
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

export default RecordingsTimeline;