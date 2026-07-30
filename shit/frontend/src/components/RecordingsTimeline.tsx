import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { Box, Slider, Typography, ToggleButtonGroup, ToggleButton, IconButton, Tooltip } from '@mui/material';
import { MyLocation } from '@mui/icons-material';
import { RZD_COLORS } from '../theme';
import { currentTimeBus } from '../utils/currentTimeBus';
import { storagePath } from '../services/devices';

interface Recording {
    filename: string;
    size: number;
    created: string;
    modified: string;
}

interface RecordingsTimelineProps {
    camera: string;
    // Устройство, чей storage-service хранит записи камеры
    deviceId: string;
    date: Date;
    // Все файлы камеры (не только за выбранный день) — чтобы листать соседние дни.
    files: Recording[];
    currentFileName?: string;
    onSeek: (file: Recording) => void;
    selectionMode: boolean;
    selectedRange: { start: number; end: number } | null;
    onRangeSelected: (range: { start: number; end: number }) => void;
}

const DEFAULT_SEGMENT_MINUTES = 10;
// Верхний предел длительности одного сегмента. Длину берём как интервал до
// следующего файла (нарезка у камер разная — 1, 10 минут и т.д.), но ограничиваем
// этим значением, чтобы сегмент перед разрывом не растягивался на всю паузу.
const MAX_SEGMENT_MINUTES = 20;
const MINUTES_PER_DAY = 1440;
const PREVIEW_DELAY_MS = 220;

const ZOOM_OPTIONS: { label: string; minutes: number }[] = [
    { label: '2д', minutes: 48 * 60 },
    { label: '24ч', minutes: 24 * 60 },
    { label: '6ч', minutes: 6 * 60 },
    { label: '1ч', minutes: 60 },
    { label: '15м', minutes: 15 },
];

const startOfDayEpochMinutes = (d: Date): number => {
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return s.getTime() / 60000;
};

const clockFromAbs = (absMinutes: number): string => {
    const d = new Date(absMinutes * 60000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const pickStep = (windowMinutes: number): number => {
    if (windowMinutes <= 10) return 2;
    if (windowMinutes <= 30) return 5;
    if (windowMinutes <= 120) return 15;
    if (windowMinutes <= 360) return 30;
    if (windowMinutes <= 720) return 60;
    if (windowMinutes <= 1440) return 120;
    if (windowMinutes <= 2880) return 180;
    return 360;
};

const roundRect = (
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, r: number,
) => {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
};

const RecordingsTimeline: React.FC<RecordingsTimelineProps> = ({
                                                                   camera,
                                                                   deviceId,
                                                                   date,
                                                                   files,
                                                                   currentFileName,
                                                                   onSeek,
                                                                   selectionMode,
                                                                   selectedRange,
                                                                   onRangeSelected,
                                                               }) => {
    // Внутренние координаты — абсолютное время в минутах эпохи. За счёт этого
    // смена выбранной даты не сдвигает окно, а листать можно бесконечно.
    const dayAnchor = useMemo(() => startOfDayEpochMinutes(date), [date]);

    const [windowMinutes, setWindowMinutes] = useState<number>(24 * 60);
    const [viewStart, setViewStart] = useState<number>(() => startOfDayEpochMinutes(date));
    const [containerWidth, setContainerWidth] = useState(0);
    const [userScrolled, setUserScrolled] = useState(false);

    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const isDraggingRef = useRef(false);
    const dragStartRef = useRef<{ x: number; viewStart: number } | null>(null);
    const wasDraggingRef = useRef(false);
    const hoverNameRef = useRef<string | undefined>(undefined);

    const [currentAbs, setCurrentAbs] = useState<number | undefined>(currentTimeBus.get());
    useEffect(() => currentTimeBus.subscribe(setCurrentAbs), []);
    const playhead = selectionMode ? undefined : currentAbs;

    // Наведение: hoverAbs — позиция курсора во времени (для палки и превью),
    // previewFile — запись под курсором (для видео).
    const [hoverAbs, setHoverAbs] = useState<number | undefined>(undefined);
    const [previewFile, setPreviewFile] = useState<Recording | undefined>(undefined);
    const previewTimerRef = useRef<number | null>(null);

    const viewEnd = viewStart + windowMinutes;

    // Сегменты в абсолютных минутах, отсортированы по времени.
    // Конец сегмента — начало следующего файла (реальная длительность), но не
    // больше MAX_SEGMENT_MINUTES, чтобы не тянуть его через разрыв записи.
    const segments = useMemo(() => {
        const arr = files
            .map(f => ({ file: f, start: new Date(f.created).getTime() / 60000 }))
            .sort((a, b) => a.start - b.start);
        return arr.map((s, i) => {
            const next = arr[i + 1];
            const end = next
                ? Math.min(next.start, s.start + MAX_SEGMENT_MINUTES)
                : s.start + DEFAULT_SEGMENT_MINUTES;
            return { file: s.file, start: s.start, end };
        });
    }, [files]);

    // Непрерывные интервалы записи — рисуем одной полосой вместо сотен сегментов.
    const spans = useMemo(() => {
        const res: { start: number; end: number }[] = [];
        for (const s of segments) {
            const last = res[res.length - 1];
            if (last && s.start <= last.end + 0.5) last.end = Math.max(last.end, s.end);
            else res.push({ start: s.start, end: s.end });
        }
        return res;
    }, [segments]);

    const absToPx = useCallback(
        (abs: number): number => ((abs - viewStart) / windowMinutes) * containerWidth,
        [viewStart, windowMinutes, containerWidth],
    );
    const pxToAbs = useCallback(
        (px: number): number => viewStart + (px / containerWidth) * windowMinutes,
        [viewStart, windowMinutes, containerWidth],
    );

    const clearPreview = useCallback(() => {
        if (previewTimerRef.current) {
            window.clearTimeout(previewTimerRef.current);
            previewTimerRef.current = null;
        }
        hoverNameRef.current = undefined;
        setHoverAbs(undefined);
        setPreviewFile(undefined);
    }, []);

    // Ширина контейнера через ResizeObserver.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        setContainerWidth(el.clientWidth);
        const ro = new ResizeObserver(entries => {
            for (const e of entries) setContainerWidth(e.contentRect.width);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Смена даты в календаре — перецентрируемся только если выбранный день не виден.
    // Если пользователь кликнул сегмент видимого дня — окно не дёргается.
    useEffect(() => {
        const dayStart = startOfDayEpochMinutes(date);
        const dayEnd = dayStart + MINUTES_PER_DAY;
        if (dayEnd < viewStart || dayStart > viewEnd) {
            const first = segments.find(s => s.start >= dayStart && s.start < dayEnd);
            const focus = first ? first.start : dayStart + MINUTES_PER_DAY / 2;
            setViewStart(focus - windowMinutes / 2);
            setUserScrolled(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [date]);

    // Следование за playhead — сдвигаем окно только когда линия у края.
    useEffect(() => {
        if (playhead === undefined || userScrolled) return;
        const margin = windowMinutes * 0.1;
        if (playhead < viewStart + margin || playhead > viewEnd - margin) {
            setViewStart(playhead - windowMinutes * 0.3);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playhead]);

    // Отрисовка дорожки на canvas — тысячи сегментов за один проход, без DOM.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !containerWidth) return;
        const H = 64;
        const dpr = window.devicePixelRatio || 1;
        const bw = Math.round(containerWidth * dpr);
        const bh = Math.round(H * dpr);
        if (canvas.width !== bw) canvas.width = bw;
        if (canvas.height !== bh) canvas.height = bh;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, containerWidth, H);
        ctx.fillStyle = RZD_COLORS.grey[100];
        ctx.fillRect(0, 0, containerWidth, H);

        // Тики с подписью времени
        const step = pickStep(windowMinutes);
        const d0 = new Date(viewStart * 60000);
        d0.setHours(0, 0, 0, 0);
        const anchorAbs = d0.getTime() / 60000;
        const firstTick = anchorAbs + Math.ceil((viewStart - anchorAbs) / step) * step;
        ctx.font = '10px Verdana, sans-serif';
        ctx.textBaseline = 'top';
        for (let t = firstTick; t <= viewEnd; t += step) {
            const x = absToPx(t);
            ctx.strokeStyle = RZD_COLORS.grey[200];
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + 0.5, 0);
            ctx.lineTo(Math.round(x) + 0.5, H);
            ctx.stroke();
            ctx.fillStyle = RZD_COLORS.grey[700];
            ctx.fillText(clockFromAbs(t), x + 3, 3);
        }

        // Границы суток с датой
        const dm = new Date(viewStart * 60000);
        dm.setHours(0, 0, 0, 0);
        while (dm.getTime() / 60000 <= viewEnd) {
            const absM = dm.getTime() / 60000;
            if (absM >= viewStart) {
                const x = absToPx(absM);
                ctx.strokeStyle = RZD_COLORS.secondary;
                ctx.globalAlpha = 0.5;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(Math.round(x), 0);
                ctx.lineTo(Math.round(x), H);
                ctx.stroke();
                ctx.globalAlpha = 1;
                ctx.fillStyle = RZD_COLORS.secondary;
                ctx.font = 'bold 10px Verdana, sans-serif';
                ctx.textBaseline = 'bottom';
                ctx.fillText(dm.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }), x + 4, H - 2);
                ctx.font = '10px Verdana, sans-serif';
                ctx.textBaseline = 'top';
            }
            dm.setDate(dm.getDate() + 1);
        }

        // Полоса записей (слитые непрерывные интервалы)
        const top = 22, sh = 30;
        ctx.fillStyle = RZD_COLORS.secondary;
        ctx.globalAlpha = 0.7;
        for (const sp of spans) {
            if (sp.end < viewStart || sp.start > viewEnd) continue;
            const x = absToPx(Math.max(sp.start, viewStart));
            const xe = absToPx(Math.min(sp.end, viewEnd));
            roundRect(ctx, x, top, Math.max(1.5, xe - x), sh, 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        // Текущий сегмент
        const cur = currentFileName ? segments.find(s => s.file.filename === currentFileName) : undefined;
        if (cur && cur.end >= viewStart && cur.start <= viewEnd) {
            const x = absToPx(Math.max(cur.start, viewStart));
            const xe = absToPx(Math.min(cur.end, viewEnd));
            ctx.fillStyle = RZD_COLORS.primary;
            roundRect(ctx, x, top, Math.max(2, xe - x), sh, 2);
            ctx.fill();
        }

        // Playhead
        if (playhead !== undefined && playhead >= viewStart && playhead <= viewEnd) {
            const x = absToPx(playhead);
            ctx.strokeStyle = RZD_COLORS.primary;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, H);
            ctx.stroke();
        }

        // Полупрозрачная палка под курсором
        if (hoverAbs !== undefined && !selectionMode && hoverAbs >= viewStart && hoverAbs <= viewEnd) {
            const x = absToPx(hoverAbs);
            ctx.strokeStyle = 'rgba(226, 26, 26, 0.45)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, H);
            ctx.stroke();
        }
    }, [viewStart, windowMinutes, containerWidth, spans, segments, currentFileName, playhead, hoverAbs, selectionMode, absToPx]);

    // Нативный wheel-слушатель (passive:false) — зум к курсору без прокрутки страницы.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const width = rect.width || 1;
            const px = e.clientX - rect.left;
            const absUnder = viewStart + (px / width) * windowMinutes;
            const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
            const newWin = Math.min(14 * MINUTES_PER_DAY, Math.max(5, windowMinutes * factor));
            setViewStart(absUnder - (px / width) * newWin);
            setWindowMinutes(newWin);
            setUserScrolled(true);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [viewStart, windowMinutes]);

    // Запись под курсором: самый правый сегмент с началом <= abs, если abs ещё
    // внутри его длительности. Так превью соответствует именно точке под палкой.
    const segmentAtAbs = (abs: number) => {
        for (let i = segments.length - 1; i >= 0; i--) {
            if (segments[i].start <= abs) {
                return abs <= segments[i].end ? segments[i] : null;
            }
        }
        return null;
    };

    const absFromClientX = (clientX: number): number | null => {
        const el = containerRef.current;
        if (!el) return null;
        return pxToAbs(clientX - el.getBoundingClientRect().left);
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        isDraggingRef.current = true;
        wasDraggingRef.current = false;
        dragStartRef.current = { x: e.clientX, viewStart };
        clearPreview();
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (isDraggingRef.current && dragStartRef.current && containerWidth) {
            const dx = e.clientX - dragStartRef.current.x;
            if (Math.abs(dx) > 3) wasDraggingRef.current = true;
            const dMinutes = -(dx / containerWidth) * windowMinutes;
            setViewStart(dragStartRef.current.viewStart + dMinutes);
            setUserScrolled(true);
            return;
        }
        if (selectionMode) { clearPreview(); return; }
        const abs = absFromClientX(e.clientX);
        if (abs === null) return;
        // Палка следует за курсором сразу.
        setHoverAbs(abs);
        // Видео-превью меняем только при смене сегмента и с небольшой задержкой,
        // чтобы при быстром проведении не дёргать загрузку.
        const seg = segmentAtAbs(abs);
        const name = seg?.file.filename;
        if (name === hoverNameRef.current) return;
        hoverNameRef.current = name;
        if (previewTimerRef.current) window.clearTimeout(previewTimerRef.current);
        if (!seg) { setPreviewFile(undefined); return; }
        previewTimerRef.current = window.setTimeout(() => {
            setPreviewFile(seg.file);
        }, PREVIEW_DELAY_MS);
    };

    const endDrag = () => {
        isDraggingRef.current = false;
        dragStartRef.current = null;
        if (wasDraggingRef.current) {
            setTimeout(() => { wasDraggingRef.current = false; }, 0);
        }
    };

    const handleClick = (e: React.MouseEvent) => {
        if (wasDraggingRef.current || selectionMode) return;
        const abs = absFromClientX(e.clientX);
        if (abs === null) return;
        const seg = segmentAtAbs(abs);
        if (seg) {
            onSeek(seg.file);
            setUserScrolled(false);
        }
    };

    const handleZoomPreset = (next: number) => {
        const center = viewStart + windowMinutes / 2;
        setViewStart(center - next / 2);
        setWindowMinutes(next);
    };

    const recenterOnPlayhead = () => {
        if (playhead !== undefined) {
            setViewStart(playhead - windowMinutes / 2);
            setUserScrolled(false);
        }
    };

    const handleRangeSliderChange = (_: Event, value: number | number[]) => {
        if (!Array.isArray(value)) return;
        onRangeSelected({ start: value[0] - dayAnchor, end: value[1] - dayAnchor });
    };

    const sliderValue: [number, number] = selectedRange
        ? [dayAnchor + selectedRange.start, dayAnchor + selectedRange.end]
        : [viewStart + windowMinutes * 0.25, viewStart + windowMinutes * 0.75];

    const showPreview = previewFile !== undefined && hoverAbs !== undefined;
    const previewLeft = hoverAbs !== undefined
        ? Math.min(Math.max(absToPx(hoverAbs), 130), Math.max(130, containerWidth - 130))
        : 0;

    return (
        <Box>
            <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
                <Typography variant="subtitle2" fontWeight="bold">
                    Timeline: {date.toLocaleDateString('ru-RU')}
                </Typography>
                <Box display="flex" alignItems="center" gap={1}>
                    <Typography variant="caption" color="text.secondary">
                        {clockFromAbs(viewStart)} – {clockFromAbs(viewEnd)}
                    </Typography>
                    {playhead !== undefined && userScrolled && (
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
                        onChange={(_, v) => v && handleZoomPreset(v)}
                    >
                        {ZOOM_OPTIONS.map(opt => (
                            <ToggleButton key={opt.minutes} value={opt.minutes}>
                                {opt.label}
                            </ToggleButton>
                        ))}
                    </ToggleButtonGroup>
                </Box>
            </Box>

            <Box sx={{ position: 'relative' }}>
                {/* Видео-превью в точке под курсором */}
                {showPreview && (
                    <Box
                        sx={{
                            position: 'absolute',
                            bottom: 'calc(100% + 8px)',
                            left: previewLeft,
                            transform: 'translateX(-50%)',
                            width: 240,
                            bgcolor: 'black',
                            borderRadius: 1,
                            overflow: 'hidden',
                            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                            zIndex: 20,
                            pointerEvents: 'none',
                            border: `1px solid ${RZD_COLORS.grey[700]}`,
                        }}
                    >
                        <video
                            key={previewFile!.filename}
                            src={storagePath(deviceId, `/api/recordings/stream/${camera}/${previewFile!.filename}`)}
                            muted
                            autoPlay
                            loop
                            playsInline
                            style={{ width: '100%', height: 135, objectFit: 'cover', display: 'block' }}
                        />
                        <Box sx={{ px: 1, py: 0.5, bgcolor: 'rgba(0,0,0,0.85)' }}>
                            <Typography variant="caption" sx={{ color: 'white', fontWeight: 700 }}>
                                {clockFromAbs(hoverAbs!)}
                            </Typography>
                        </Box>
                    </Box>
                )}

                <Box
                    ref={containerRef}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={endDrag}
                    onMouseLeave={() => { endDrag(); clearPreview(); }}
                    onClick={handleClick}
                    sx={{
                        position: 'relative',
                        width: '100%',
                        height: 64,
                        borderRadius: 1,
                        overflow: 'hidden',
                        cursor: 'grab',
                        userSelect: 'none',
                        '&:active': { cursor: 'grabbing' },
                    }}
                >
                    <canvas
                        ref={canvasRef}
                        style={{ width: '100%', height: '100%', display: 'block' }}
                    />
                </Box>
            </Box>

            {selectionMode && (
                <Box sx={{ mt: 0 }}>
                    <Slider
                        value={sliderValue}
                        onChange={handleRangeSliderChange}
                        min={viewStart}
                        max={viewEnd}
                        step={1}
                        valueLabelDisplay="auto"
                        valueLabelFormat={(v) => clockFromAbs(v)}
                        size="small"
                        sx={{
                            py: 0,
                            '& .MuiSlider-rail': { height: 2, opacity: 0.3 },
                            '& .MuiSlider-track': { height: 4 },
                            '& .MuiSlider-thumb': { width: 12, height: 12 },
                        }}
                    />
                </Box>
            )}
        </Box>
    );
};

export default React.memo(RecordingsTimeline);