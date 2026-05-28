import React, { useMemo, useRef, useEffect, useState } from 'react';
import { Box, Slider, Typography, ToggleButtonGroup, ToggleButton, IconButton, Tooltip } from '@mui/material';
import { MyLocation } from '@mui/icons-material';
import { RZD_COLORS } from '../theme';
import { currentTimeBus } from '../utils/currentTimeBus';

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
    /** Имя текущего файла — нужно для подсветки сегмента и авто-центрирования */
    currentFileName?: string;
    onSeek: (file: Recording) => void;
    selectionMode: boolean;
    selectedRange: { start: number; end: number } | null;
    onRangeSelected: (range: { start: number; end: number }) => void;
}

const DEFAULT_SEGMENT_MINUTES = 10;

const ZOOM_OPTIONS: { label: string; minutes: number }[] = [
    { label: '24ч', minutes: 24 * 60 },
    { label: '6ч', minutes: 6 * 60 },
    { label: '1ч', minutes: 60 },
    { label: '15м', minutes: 15 },
];

const RecordingsTimeline: React.FC<RecordingsTimelineProps> = ({
                                                                   date,
                                                                   files,
                                                                   currentFileName,
                                                                   onSeek,
                                                                   selectionMode,
                                                                   selectedRange,
                                                                   onRangeSelected,
                                                               }) => {

    const [windowMinutes, setWindowMinutes] = useState<number>(24 * 60);
    const [windowStart, setWindowStart] = useState<number>(0);
    const [userScrolled, setUserScrolled] = useState(false);

    // Отслеживание Drag
    const containerRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);
    const dragStartRef = useRef<{ x: number; windowStart: number } | null>(null);
    const wasDraggingRef = useRef(false);     // ← НОВОЕ: был ли реальный drag
    const lastCenteredFileRef = useRef<string | undefined>(undefined);
    const lastCenteredZoomRef = useRef<number>(windowMinutes);

    // currentTime теперь живёт локально и подписан на шину
    const [currentTime, setCurrentTime] = useState<number | undefined>(
        currentTimeBus.get()
    );
    useEffect(() => {
        const unsub = currentTimeBus.subscribe(setCurrentTime);
        return unsub;
    }, []);

    // В режиме выбора диапазона playhead не нужен — гасим
    const effectiveCurrentTime = selectionMode ? undefined : currentTime;

    const fileToMinutes = (iso: string): number => {
        const d = new Date(iso);
        return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    };

    const segments = useMemo(() => {
        return files.map(f => {
            const start = fileToMinutes(f.created);
            return { file: f, start, end: start + DEFAULT_SEGMENT_MINUTES };
        });
    }, [files]);

    const centerWindowOn = (minute: number) => {
        const half = windowMinutes / 2;
        let ws = minute - half;
        ws = Math.max(0, Math.min(Math.max(0, 1440 - windowMinutes), ws));
        setWindowStart(ws);
    };

    useEffect(() => {
        const fileChanged = currentFileName !== lastCenteredFileRef.current;
        const zoomChanged = windowMinutes !== lastCenteredZoomRef.current;

        if (!fileChanged && !zoomChanged) return;

        lastCenteredFileRef.current = currentFileName;
        lastCenteredZoomRef.current = windowMinutes;

        if (fileChanged) setUserScrolled(false);

        if (!userScrolled || fileChanged) {
            if (effectiveCurrentTime !== undefined) {
                centerWindowOn(effectiveCurrentTime);
            } else if (segments.length > 0) {
                centerWindowOn(segments[0].start);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentFileName, windowMinutes]);

    useEffect(() => {
        setUserScrolled(false);
        setWindowStart(0);
        lastCenteredFileRef.current = undefined;
    }, [date]);

    const windowEnd = windowStart + windowMinutes;

    const minuteToPx = (minute: number, containerWidth: number): number => {
        return ((minute - windowStart) / windowMinutes) * containerWidth;
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        // убрана блокировка по selectionMode — drag доступен всегда
        isDraggingRef.current = true;
        wasDraggingRef.current = false;
        dragStartRef.current = { x: e.clientX, windowStart };
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDraggingRef.current || !dragStartRef.current || !containerRef.current) return;
        const dx = e.clientX - dragStartRef.current.x;

        // Если сдвинули мышь хоть на 3px — это уже настоящий drag
        if (Math.abs(dx) > 3) {
            wasDraggingRef.current = true;
        }

        const w = containerRef.current.clientWidth;
        const dMinutes = -(dx / w) * windowMinutes;
        let ws = dragStartRef.current.windowStart + dMinutes;
        ws = Math.max(0, Math.min(Math.max(0, 1440 - windowMinutes), ws));
        setWindowStart(ws);
        setUserScrolled(true);
    };

    const endDrag = () => {
        isDraggingRef.current = false;
        dragStartRef.current = null;
        // wasDraggingRef НЕ сбрасываем здесь — он нужен в handleSegmentClick,
        // который вызовется СРАЗУ после mouseup. Сбросим в следующем tick.
        if (wasDraggingRef.current) {
            setTimeout(() => { wasDraggingRef.current = false; }, 0);
        }
    };

    const handleWheel = (e: React.WheelEvent) => {
        // убрана блокировка по selectionMode — zoom доступен всегда
        const delta = e.deltaY > 0 ? windowMinutes * 0.1 : -windowMinutes * 0.1;
        let ws = windowStart + delta;
        ws = Math.max(0, Math.min(Math.max(0, 1440 - windowMinutes), ws));
        setWindowStart(ws);
        setUserScrolled(true);
    };

    const handleSegmentClick = (e: React.MouseEvent, file: Recording) => {
        // Защита от "ложного клика" после drag — браузер триггерит click
        // на элементе, над которым отпустили mouse, даже если был drag.
        if (wasDraggingRef.current) return;

        // В режиме выбора клик по сегменту запрещён — чтобы случайно не сбить выбор.
        if (selectionMode) return;

        e.stopPropagation();
        onSeek(file);
        setUserScrolled(false);
    };

    const recenterOnPlayhead = () => {
        if (effectiveCurrentTime !== undefined) {
            centerWindowOn(effectiveCurrentTime);
            setUserScrolled(false);
        }
    };

    const formatMinutes = (m: number): string => {
        const h = Math.floor(m / 60);
        const min = Math.floor(m % 60);
        return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    };

    const ticks = useMemo(() => {
        let step = 60;
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

    const handleRangeSliderChange = (_: Event, value: number | number[]) => {
        if (!Array.isArray(value)) return;
        const [start, end] = value;
        onRangeSelected({ start, end });
    };

    const sliderValue: [number, number] = selectedRange
        ? [selectedRange.start, selectedRange.end]
        : [windowStart + windowMinutes * 0.25, windowStart + windowMinutes * 0.75];

    return (
        <Box>
            <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
                <Typography variant="subtitle2" fontWeight="bold">
                    Timeline: {date.toLocaleDateString('ru-RU')}
                </Typography>
                <Box display="flex" alignItems="center" gap={1}>
                    <Typography variant="caption" color="text.secondary">
                        {formatMinutes(windowStart)} – {formatMinutes(windowEnd)}
                    </Typography>
                    {effectiveCurrentTime !== undefined && userScrolled && (
                        <Tooltip title="Вернуться к текущей позиции">
                            <IconButton size="small" onClick={recenterOnPlayhead} color="error">
                                <MyLocation fontSize="small" />
                            </IconButton>
                        </Tooltip>
                    )}
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
                    cursor: 'grab',
                    userSelect: 'none',
                    '&:active': {
                        cursor: 'grabbing',
                    },
                }}
            >
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

                {containerRef.current &&
                    segments.map(seg => {
                        const w = containerRef.current!.clientWidth;
                        if (seg.end < windowStart || seg.start > windowEnd) return null;
                        const visibleStart = Math.max(seg.start, windowStart);
                        const visibleEnd = Math.min(seg.end, windowEnd);
                        const x = minuteToPx(visibleStart, w);
                        const width = Math.max(2, minuteToPx(visibleEnd, w) - x);
                        const isCurrentSegment = seg.file.filename === currentFileName;

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
                                    bgcolor: isCurrentSegment ? RZD_COLORS.primary : RZD_COLORS.secondary,
                                    opacity: isCurrentSegment ? 0.9 : 0.7,
                                    borderRadius: 0.5,
                                    cursor: selectionMode ? 'grab' : 'pointer',   // ← в режиме выбора курсор drag
                                    transition: 'opacity 0.15s',
                                    '&:hover': {
                                        opacity: selectionMode ? 0.7 : 1,           // ← без hover-эффекта в selectionMode
                                    },
                                }}
                                title={`${seg.file.filename} • ${formatMinutes(seg.start)}`}
                            />
                        );
                    })}

                {effectiveCurrentTime !== undefined &&
                    effectiveCurrentTime >= windowStart &&
                    effectiveCurrentTime <= windowEnd &&
                    containerRef.current && (
                        <Box
                            sx={{
                                position: 'absolute',
                                top: 0,
                                bottom: 0,
                                left: minuteToPx(effectiveCurrentTime, containerRef.current.clientWidth),
                                width: '2px',
                                bgcolor: 'error.main',
                                boxShadow: '0 0 4px rgba(255,0,0,0.5)',
                                pointerEvents: 'none',
                                zIndex: 3,
                            }}
                        />
                    )}
            </Box>

            {selectionMode && (
                <Box sx={{ mt: 0, px: 0.0}}>
                    <Box display="flex" alignItems="center" gap={1.5}>
                        <Slider
                            value={sliderValue}
                            onChange={handleRangeSliderChange}
                            min={windowStart}
                            max={windowEnd}
                            step={1}
                            valueLabelDisplay="auto"
                            valueLabelFormat={(v) => formatMinutes(v)}
                            size="small"
                            sx={{
                                py: 0,                  // убираем вертикальные отступы
                                '& .MuiSlider-rail': {
                                    // делаем rail тонким и прозрачным, чтобы он не выделялся
                                    height: 2,
                                    opacity: 0.3,
                                },
                                '& .MuiSlider-track': {
                                    height: 4,            // активный диапазон чуть толще
                                },
                                '& .MuiSlider-thumb': {
                                    width: 12,
                                    height: 12,
                                },
                            }}
                        />
                    </Box>
                </Box>
            )}
        </Box>
    );
};

export default React.memo(RecordingsTimeline);