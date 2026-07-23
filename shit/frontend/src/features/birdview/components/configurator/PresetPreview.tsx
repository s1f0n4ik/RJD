/**
 * Схема пресета в модалке загрузки.
 *
 * Пресеты различаются раскладкой, а не именем: по «config_n9ecx» не понять,
 * та ли это конфигурация. Поэтому рисуем то, что в ней лежит — подложки,
 * камеры и области разметки в координатах поля.
 */

export interface PresetPreviewData {
    canvas?: { width?: number; height?: number };
    cameras?: Record<string, { name?: string; canvas_region?: number[][]; dst_points?: number[][] }>;
    images?: Array<{ name?: string; rect?: number[] }>;
}

interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

function boundsOf(points: number[][]): Rect | null {
    const valid = points.filter(p => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite));
    if (valid.length === 0) return null;

    const xs = valid.map(p => p[0]);
    const ys = valid.map(p => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

interface PresetPreviewProps {
    preset: PresetPreviewData | null;
    loading: boolean;
}

export function PresetPreview({ preset, loading }: PresetPreviewProps) {
    if (loading) {
        return <div className="preset-preview-empty">Загрузка схемы...</div>;
    }
    if (!preset) {
        return <div className="preset-preview-empty">Выберите конфигурацию слева</div>;
    }

    const width = Number(preset.canvas?.width) || 0;
    const height = Number(preset.canvas?.height) || 0;
    if (width <= 0 || height <= 0) {
        return <div className="preset-preview-empty">В конфигурации нет размеров поля</div>;
    }

    const overlays = (preset.images ?? [])
        .map(img => (Array.isArray(img?.rect) && img.rect.length >= 4 ? img.rect : null))
        .filter((r): r is number[] => r !== null && r.every(Number.isFinite));

    const cameras = Object.entries(preset.cameras ?? {}).map(([key, cam]) => ({
        key,
        name: cam?.name || key,
        rect: Array.isArray(cam?.canvas_region) ? boundsOf(cam.canvas_region) : null,
        // Каждая четвёрка углов — одна область разметки
        zones: (() => {
            const dst = Array.isArray(cam?.dst_points) ? cam.dst_points : [];
            const out: number[][][] = [];
            for (let i = 0; i + 3 < dst.length; i += 4) {
                const quad = dst.slice(i, i + 4);
                if (quad.every(p => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite))) {
                    out.push(quad);
                }
            }
            return out;
        })(),
    }));

    // Подпись читается на любом масштабе поля: 1000 и 570 дают разный пиксель
    const labelSize = Math.max(width, height) * 0.028;

    return (
        <svg
            className="preset-preview"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Схема конфигурации"
        >
            <rect className="pp-field" x={0} y={0} width={width} height={height} />

            {overlays.map((r, i) => (
                <rect key={`ov-${i}`} className="pp-overlay" x={r[0]} y={r[1]} width={r[2]} height={r[3]} />
            ))}

            {cameras.map(cam => (
                <g key={cam.key}>
                    {cam.rect && (
                        <rect
                            className="pp-camera"
                            x={cam.rect.x}
                            y={cam.rect.y}
                            width={cam.rect.w}
                            height={cam.rect.h}
                        />
                    )}
                    {cam.zones.map((quad, i) => (
                        <polygon
                            key={`z-${i}`}
                            className="pp-zone"
                            points={quad.map(p => `${p[0]},${p[1]}`).join(' ')}
                        />
                    ))}
                    {cam.rect && (
                        <text
                            className="pp-label"
                            x={cam.rect.x + cam.rect.w / 2}
                            y={cam.rect.y + cam.rect.h / 2}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            style={{ fontSize: labelSize }}
                        >
                            {cam.name}
                        </text>
                    )}
                </g>
            ))}
        </svg>
    );
}
