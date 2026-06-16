import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import {
    Visibility as VisibilityIcon,
    VisibilityOff as VisibilityOffIcon,
    Warning as WarningIcon,
} from '@mui/icons-material';
import WebRTCPlayer, { type Detection } from './WebRTCPlayer';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface NeuralWebRTCPlayerProps {
    cameraId: string;
    cameraName?: string;
    signalingUrl: string;
    onError?: (error: string) => void;
}

// ─────────────────────────────────────────────────────────────
// Drawing constants
// ─────────────────────────────────────────────────────────────

const FONT_SIZE    = 12;   // px
const FONT_FAMILY  = 'monospace';
const RECT_LINE_W  = 2;    // px
const LABEL_PAD_H  = 4;    // px
const LABEL_PAD_W  = 6;    // px
const LABEL_OFFSET = 2;    // px above rect

// Fallback palette when server doesn't provide color
const FALLBACK_COLORS = [
    '#f44336', '#e91e63', '#9c27b0', '#3f51b5',
    '#2196f3', '#00bcd4', '#4caf50', '#ff9800',
];
function colorForId(id: number): string {
    return FALLBACK_COLORS[id % FALLBACK_COLORS.length];
}

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────

const NeuralWebRTCPlayer: React.FC<NeuralWebRTCPlayerProps> = ({
                                                                   cameraId,
                                                                   cameraName,
                                                                   signalingUrl,
                                                                   onError,
                                                               }) => {
    // Refs
    const containerRef    = useRef<HTMLDivElement>(null);
    const canvasRef       = useRef<HTMLCanvasElement>(null);
    const videoRef        = useRef<HTMLVideoElement | null>(null);
    const detectionsRef   = useRef<Detection[]>([]);
    const rafRef          = useRef<number | null>(null);
    const prevVideoRect   = useRef<DOMRect | null>(null);

    // State
    const [showDetections, setShowDetections] = useState(true);
    const [noSource, setNoSource]             = useState(false); // камеры нет в loader

    // ── Проверка наличия камеры в neural loader ──────────────────
    useEffect(() => {
        let cancelled = false;
        fetch(`/neural/camera?camera_id=${encodeURIComponent(cameraId)}`)
            .then(r => r.json())
            .then(data => {
                if (!cancelled && data?.data?.found === false) {
                    setNoSource(true);
                }
            })
            .catch(() => {
                // Молча — если endpoint не ответил, не показываем предупреждение
            });
        return () => { cancelled = true; };
    }, [cameraId]);

    // ── Получаем <video> изнутри WebRTCPlayer через DOM-поиск ────
    // WebRTCPlayer не экспортирует videoRef наружу, поэтому ищем
    // ближайший <video> внутри нашего контейнера.
    useEffect(() => {
        let found = false;
        const poll = setInterval(() => {
            if (!containerRef.current) return;
            const vid = containerRef.current.querySelector<HTMLVideoElement>('video');
            if (vid && !found) {
                found = true;
                videoRef.current = vid;
                clearInterval(poll);
            }
        }, 100);
        return () => clearInterval(poll);
    }, []);

    // ── Коллбэк детекций ─────────────────────────────────────────
    const handleDetections = useCallback((dets: Detection[]) => {
        detectionsRef.current = dets;
    }, []);

    // ─────────────────────────────────────────────────────────────
    // Letterbox: вычисляем реальный прямоугольник видеоконтента
    // внутри элемента <video> (object-fit: contain).
    // Canvas позиционируется точно над этим прямоугольником.
    // ─────────────────────────────────────────────────────────────
    function getVideoContentRect(video: HTMLVideoElement): DOMRect | null {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) return null;

        const elem = video.getBoundingClientRect();
        const ew   = elem.width;
        const eh   = elem.height;
        if (!ew || !eh) return null;

        const videoAspect     = vw / vh;
        const containerAspect = ew / eh;

        let contentW: number, contentH: number;
        if (videoAspect > containerAspect) {
            contentW = ew;
            contentH = ew / videoAspect;
        } else {
            contentH = eh;
            contentW = eh * videoAspect;
        }

        const offsetX = (ew - contentW) / 2;
        const offsetY = (eh - contentH) / 2;

        // Возвращаем прямоугольник относительно самого элемента (не viewport)
        return new DOMRect(offsetX, offsetY, contentW, contentH);
    }

    // ─────────────────────────────────────────────────────────────
    // Обновление позиции и размера canvas строго по видеоконтенту
    // ─────────────────────────────────────────────────────────────
    function syncCanvasToVideo() {
        const canvas = canvasRef.current;
        const video  = videoRef.current;
        if (!canvas || !video) return;

        const rect = getVideoContentRect(video);
        if (!rect) return;

        // Сравниваем с предыдущим — не трогаем DOM без изменений
        const prev = prevVideoRect.current;
        if (
            prev &&
            Math.abs(prev.x      - rect.x)      < 0.5 &&
            Math.abs(prev.y      - rect.y)      < 0.5 &&
            Math.abs(prev.width  - rect.width)  < 0.5 &&
            Math.abs(prev.height - rect.height) < 0.5
        ) return;

        prevVideoRect.current = rect;

        const dpr = window.devicePixelRatio || 1;
        canvas.style.left   = `${rect.x}px`;
        canvas.style.top    = `${rect.y}px`;
        canvas.style.width  = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        canvas.width        = Math.round(rect.width  * dpr);
        canvas.height       = Math.round(rect.height * dpr);
    }

    // ─────────────────────────────────────────────────────────────
    // RAF draw loop
    // ─────────────────────────────────────────────────────────────
    useEffect(() => {
        const draw = () => {
            rafRef.current = requestAnimationFrame(draw);

            syncCanvasToVideo();

            const canvas = canvasRef.current;
            if (!canvas) return;

            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (!showDetections || detectionsRef.current.length === 0) return;

            const dpr = window.devicePixelRatio || 1;
            const W   = canvas.width;
            const H   = canvas.height;

            ctx.save();
            ctx.scale(dpr, dpr);

            // CSS-пиксели canvas
            const cssW = canvas.width  / dpr;
            const cssH = canvas.height / dpr;

            for (const det of detectionsRef.current) {
                const rect  = det.rect;

                // rect — массив [x1, y1, x2, y2] в нормализованных координатах
                // пространства видеоконтента (сервер уже убрал letterbox)
                const [nx1, ny1, nx2, ny2] = Array.isArray(rect)
                    ? rect
                    : [rect.x, rect.y, (rect as any).x + (rect as any).w, (rect as any).y + (rect as any).h];

                const x1 = nx1 * cssW;
                const y1 = ny1 * cssH;
                const x2 = nx2 * cssW;
                const y2 = ny2 * cssH;
                const bw = x2 - x1;
                const bh = y2 - y1;

                const color = det.color || colorForId(det.id);

                // ── Рамка ─────────────────────────────────────────────
                ctx.strokeStyle = color;
                ctx.lineWidth   = RECT_LINE_W;
                ctx.strokeRect(x1, y1, bw, bh);

                // ── Подложка рамки (тонкая тень) ──────────────────────
                ctx.strokeStyle = 'rgba(0,0,0,0.5)';
                ctx.lineWidth   = RECT_LINE_W + 1.5;
                ctx.strokeRect(x1, y1, bw, bh);
                ctx.strokeStyle = color;
                ctx.lineWidth   = RECT_LINE_W;
                ctx.strokeRect(x1, y1, bw, bh);

                // ── Лейбл: "Имя класса  92%" ──────────────────────────
                const conf    = det.confidence != null
                    ? ` ${Math.round(det.confidence * 100)}%`
                    : '';
                const label   = (det.name || `class ${det.id}`) + conf;

                ctx.font = `bold ${FONT_SIZE}px ${FONT_FAMILY}`;
                const textW  = ctx.measureText(label).width;
                const textH  = FONT_SIZE;
                const lw     = textW + LABEL_PAD_W * 2;
                const lh     = textH + LABEL_PAD_H * 2;

                // Позиция лейбла: над рамкой если есть место, иначе внутри сверху
                const labelY = y1 - LABEL_OFFSET >= lh
                    ? y1 - LABEL_OFFSET - lh
                    : y1 + LABEL_OFFSET;

                // Фон лейбла
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.roundRect(x1, labelY, lw, lh, 0);
                ctx.fill();

                // Текст
                ctx.fillStyle    = '#ffffff';
                ctx.textBaseline = 'top';
                ctx.textAlign    = 'left';
                ctx.fillText(label, x1 + LABEL_PAD_W, labelY + LABEL_PAD_H);
            }

            ctx.restore();
        };

        rafRef.current = requestAnimationFrame(draw);
        return () => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        };
        // showDetections меняет поведение внутри draw через замыкание — пересоздавать не нужно
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showDetections]);

    // ─────────────────────────────────────────────────────────────
    // Render
    // ─────────────────────────────────────────────────────────────

    return (
        <Box
            ref={containerRef}
            sx={{ position: 'relative', width: '100%', height: '100%' }}
        >
            {/* Базовый WebRTC плеер — занимает весь блок */}
            <WebRTCPlayer
                cameraId={cameraId}
                cameraName={cameraName}
                signalingUrl={signalingUrl}
                onError={onError}
                onDetections={handleDetections}
            />

            {/*
        Canvas — абсолютно позиционирован, размер и позиция
        обновляются в RAF-цикле строго по реальному видеоконтенту.
        pointerEvents: none — не перехватывает клики.
      */}
            <canvas
                ref={canvasRef}
                style={{
                    position:      'absolute',
                    pointerEvents: 'none',
                    zIndex:        10,
                    // Начальное положение — 0,0; RAF сдвинет его как только
                    // появится видео и станет известен videoWidth/videoHeight
                    top:  0,
                    left: 0,
                }}
            />

            {/*
        Панель управления: располагается рядом с кнопкой fullscreen
        из CellMenu (та — bottom: 6, right: 6; мы — bottom: 6, right: 44)
      */}
            <Box
                sx={{
                    position:   'absolute',
                    bottom:     6,
                    right:      44,   // сдвинуто влево от кнопки fullscreen
                    zIndex:     20,
                    display:    'flex',
                    alignItems: 'center',
                    gap:        0.5,
                }}
            >
                {/* Предупреждение: камера не найдена в loader */}
                {noSource && (
                    <Tooltip
                        title="Камера не найдена в источнике обнаружений (neural loader). Детекции недоступны."
                        placement="top"
                        arrow
                    >
                        <Box
                            sx={{
                                display:         'flex',
                                alignItems:      'center',
                                bgcolor:         'rgba(0,0,0,0.55)',
                                borderRadius:    1,
                                px:              0.75,
                                height:          32,
                                color:           'warning.main',
                                cursor:          'default',
                            }}
                        >
                            <WarningIcon sx={{ fontSize: 18 }} />
                        </Box>
                    </Tooltip>
                )}

                {/* Тоггл отображения детекций */}
                <Tooltip
                    title={showDetections ? 'Скрыть детекции' : 'Показать детекции'}
                    placement="top"
                    arrow
                >
                    <IconButton
                        size="small"
                        onClick={() => setShowDetections(v => !v)}
                        sx={{
                            bgcolor: 'rgba(0,0,0,0.55)',
                            color:   showDetections ? 'success.light' : 'grey.500',
                            width:   32,
                            height:  32,
                            '&:hover': { bgcolor: 'rgba(0,0,0,0.8)' },
                        }}
                    >
                        {showDetections
                            ? <VisibilityIcon     fontSize="small" />
                            : <VisibilityOffIcon  fontSize="small" />}
                    </IconButton>
                </Tooltip>
            </Box>
        </Box>
    );
};

export default NeuralWebRTCPlayer;