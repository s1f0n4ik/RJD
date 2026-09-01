/**
 * Обнаружения технического зрения: типы и отрисовка рамок.
 *
 * Рамки приходят по сигналинг-WS сообщениями neural / neural_tracks и
 * рисуются клиентом поверх обычного потока камеры — в кадр они не врисованы
 * (в кадре они только у виртуального потока нейронки).
 */

export interface Detection {
    id:          number;
    name:        string;
    color:       string;       // hex из конфига класса
    superclass:  string;
    confidence?: number;       // 0..1, опционально
    // rect: сервер шлёт либо массив [x1,y1,x2,y2], либо объект {x,y,w,h}
    rect: [number, number, number, number] | { x: number; y: number; w: number; h: number };
}

export type TrackState = 'tentative' | 'confirmed' | 'lost';

/** Трек из neural_tracks (slot.cpp send_tracks). */
export interface Track {
    track_id:    number;
    class_id:    number;
    name:        string;
    color:       string;
    superclass:  string;
    confidence?: number;
    state:       TrackState;
    age?:        number;
    lost_frames?: number;
    rect: [number, number, number, number] | { x: number; y: number; w: number; h: number };
}

const FONT_SIZE    = 12;
const FONT_FAMILY  = 'monospace';
const RECT_LINE_W  = 2;
const LABEL_PAD_H  = 2;
const LABEL_PAD_W  = 6;
const LABEL_OFFSET = -2;

const FALLBACK_COLORS = [
    '#f44336', '#e91e63', '#9c27b0', '#3f51b5',
    '#2196f3', '#00bcd4', '#4caf50', '#ff9800',
];

export function colorForId(id: number): string {
    return FALLBACK_COLORS[id % FALLBACK_COLORS.length];
}

/**
 * Рисует рамки поверх кадра. Канвас должен быть уже размечен под devicePixelRatio.
 * Ничего не рисует, пока в видео нет кадра: иначе рамки повисают на чёрном.
 */
export function drawDetections(
    canvas: HTMLCanvasElement,
    video: HTMLVideoElement | null,
    detections: Detection[],
    tracks: Track[],
): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;
    if (detections.length === 0 && tracks.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.scale(dpr, dpr);

    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;

    const toPx = (rect: Detection['rect']): [number, number, number, number] => {
        const [nx1, ny1, nx2, ny2] = Array.isArray(rect)
            ? rect
            : [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h];
        const x1 = nx1 * cssW, y1 = ny1 * cssH;
        return [x1, y1, nx2 * cssW - x1, ny2 * cssH - y1];
    };

    const drawBox = (x1: number, y1: number, bw: number, bh: number, color: string, dashed: boolean) => {
        ctx.setLineDash(dashed ? [6, 4] : []);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = RECT_LINE_W + 1.5;
        ctx.strokeRect(x1, y1, bw, bh);
        ctx.strokeStyle = color;
        ctx.lineWidth = RECT_LINE_W;
        ctx.strokeRect(x1, y1, bw, bh);
        ctx.setLineDash([]);
    };

    const drawLabel = (x1: number, y1: number, label: string, color: string) => {
        ctx.font = `bold ${FONT_SIZE}px ${FONT_FAMILY}`;
        const lw = ctx.measureText(label).width + LABEL_PAD_W * 2;
        const lh = FONT_SIZE + LABEL_PAD_H * 2;
        const labelY = y1 - LABEL_OFFSET >= lh ? y1 - LABEL_OFFSET - lh : y1 + LABEL_OFFSET;
        ctx.fillStyle = color;
        ctx.fillRect(x1, labelY, lw, lh);
        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.fillText(label, x1 + LABEL_PAD_W, labelY + LABEL_PAD_H);
    };

    for (const det of detections) {
        const [x1, y1, bw, bh] = toPx(det.rect);
        const color = det.color || colorForId(det.id);
        drawBox(x1, y1, bw, bh, color, false);
        const conf = det.confidence != null ? ` ${Math.round(det.confidence * 100)}%` : '';
        drawLabel(x1, y1, (det.name || `class ${det.id}`) + conf, color);
    }

    // tentative — пунктир без подписи, confirmed — сплошной с номером, lost — пунктир с меткой L
    for (const t of tracks) {
        const [x1, y1, bw, bh] = toPx(t.rect);
        const color = t.color || colorForId(t.class_id);
        drawBox(x1, y1, bw, bh, color, t.state !== 'confirmed');

        const clsName = t.name || `class ${t.class_id}`;
        const hasCurrent = (t.lost_frames ?? 0) === 0;
        const conf = hasCurrent && t.confidence != null ? ` ${Math.round(t.confidence * 100)}%` : '';

        if (t.state === 'confirmed') drawLabel(x1, y1, `${clsName} #${t.track_id}${conf}`, color);
        else if (t.state === 'lost') drawLabel(x1, y1, `${clsName} L`, color);
    }

    ctx.restore();
}
