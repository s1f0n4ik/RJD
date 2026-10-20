import { useRef } from 'react';
import type { ZoneDef, ZonePolygon } from '../../features/neural/api/types';
import { zoneRank } from './model-desc';
import { clamp, svgPoint, type Crop } from './stream-geometry';

// Разметка зон на кадре камеры: многоугольники в долях кадра, рисование и правка

export type Pt = [number, number];

export interface ZoneState {
    /** Зона нового контура */
    zone: number;
    /** Выбранный контур камеры */
    poly: number | null;
    /** Зону выбрали в списке: щелчок по контуру начинает новый */
    armed: boolean;
    /** Контур в рисовании и точка под указателем */
    draw: { pts: Pt[]; cur: Pt } | null;
}

// Замыкание первой вершиной и прижим к краю, экранных пикселей
const CLOSE_PX = 12;
const SNAP_PX = 8;
const DOUBLE_MS = 340;

const round = (v: number) => Math.round(v * 1e4) / 1e4;

export function ptsOf(p: ZonePolygon): Pt[] {
    const out: Pt[] = [];
    for (let i = 0; i + 1 < p.points.length; i += 2) out.push([p.points[i], p.points[i + 1]]);
    return out;
}

export const flatOf = (pts: Pt[]) => pts.flatMap(([x, y]) => [round(x), round(y)]);

const replace = (list: ZonePolygon[], i: number, pts: Pt[]) => list.map((p, j) => (j === i ? { ...p, points: flatOf(pts) } : p));

/** Многоугольники каталога в порядке рисования: нижние по приоритету первыми */
export const drawOrder = (polys: ZonePolygon[], catalog: ZoneDef[]) =>
    polys.map((_, i) => i).filter(i => zoneRank(catalog, polys[i].zone) > 0)
        .sort((a, b) => zoneRank(catalog, polys[b].zone) - zoneRank(catalog, polys[a].zone));

type Drag =
    | { kind: 'v'; i: number; k: number; base: ZonePolygon[]; list?: ZonePolygon[] }
    | { kind: 'move'; i: number; x0: number; y0: number; base: ZonePolygon[]; list?: ZonePolygon[] };

interface ZoneOverlayProps {
    polys: ZonePolygon[];
    catalog: ZoneDef[];
    /** Окна тайлов этой камеры: номер тайла и окно */
    windows: { n: number; crop: Crop }[];
    frame: { width: number; height: number };
    u: number;
    /** Затемнять кадр вне окон модели */
    dim: boolean;
    zs: ZoneState;
    setZs: (p: Partial<ZoneState>) => void;
    onPolys: (list: ZonePolygon[], final: boolean) => void;
    onCloseDraw: () => void;
    onDelete: () => void;
}

export function ZoneOverlay({ polys, catalog, windows, frame, u, dim, zs, setZs, onPolys, onCloseDraw, onDelete }: ZoneOverlayProps) {
    const W = frame.width, H = frame.height;
    const drag = useRef<Drag | null>(null);
    const moved = useRef(false);
    const last = useRef<{ t: number; x: number; y: number } | null>(null);
    const zone = (id: number) => catalog.find(z => z.id === id);
    const rank = (id: number) => zoneRank(catalog, id);
    const xy = ([x, y]: Pt) => `${(x * W).toFixed(1)} ${(y * H).toFixed(1)}`;
    const pathOf = (p: ZonePolygon) => `M${ptsOf(p).map(xy).join('L')}Z`;

    // Точка указателя в долях кадра; у края прижимается к нему
    const point = (svg: SVGSVGElement, e: React.PointerEvent) => {
        const p = svgPoint(svg, e), rx = p.x / W, ry = p.y / H, sn = SNAP_PX * u;
        let x = clamp(rx, 0, 1), y = clamp(ry, 0, 1);
        if (x * W < sn) x = 0;
        if ((1 - x) * W < sn) x = 1;
        if (y * H < sn) y = 0;
        if ((1 - y) * H < sn) y = 1;
        return { x, y, rx, ry };
    };

    const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
        if (e.button !== 0) return;
        const svg = e.currentTarget, a = (e.target as Element).closest('[data-act]') as SVGElement | null, act = a?.dataset.act;
        const p = point(svg, e), now = performance.now(), prev = last.current;
        const dbl = !!prev && now - prev.t < DOUBLE_MS && Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y) < 10;
        last.current = { t: now, x: e.clientX, y: e.clientY };
        const begin = (d: Drag) => {
            svg.setPointerCapture(e.pointerId);
            drag.current = d;
            moved.current = false;
        };

        if (zs.draw) {
            const pts = zs.draw.pts, f = pts[0];
            const near = Math.hypot((p.x - f[0]) * W, (p.y - f[1]) * H) / u < CLOSE_PX;
            if (pts.length >= 3 && (near || dbl)) { onCloseDraw(); return; }
            if (!dbl) setZs({ draw: { pts: [...pts, [p.x, p.y]], cur: [p.x, p.y] } });
            return;
        }
        const i = zs.poly;
        if (act === 'pdel') { onDelete(); return; }
        if (act === 'v' && i != null) {
            const k = Number(a!.dataset.k), pts = ptsOf(polys[i]);
            if (!dbl) { begin({ kind: 'v', i, k, base: polys }); return; }
            last.current = null;
            if (pts.length > 3) { pts.splice(k, 1); onPolys(replace(polys, i, pts), true); }
            return;
        }
        if (act === 'm' && i != null) {
            const k = Number(a!.dataset.k), pts = ptsOf(polys[i]), A = pts[k], B = pts[(k + 1) % pts.length];
            pts.splice(k + 1, 0, [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]);
            const list = replace(polys, i, pts);
            onPolys(list, false);
            last.current = null;
            begin({ kind: 'v', i, k: k + 1, base: list, list });
            moved.current = true;
            return;
        }
        if (!zs.armed && act === 'poly') {
            const j = Number(a!.dataset.i);
            setZs({ poly: j, zone: polys[j].zone });
            begin({ kind: 'move', i: j, x0: p.rx, y0: p.ry, base: polys });
            return;
        }
        if (i != null && !zs.armed) { setZs({ poly: null }); return; }
        setZs({ draw: { pts: [[p.x, p.y]], cur: [p.x, p.y] }, armed: false, poly: null });
    };

    const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
        const d = drag.current;
        if (!d && !zs.draw) return;
        const p = point(e.currentTarget, e);
        if (!d) { setZs({ draw: { pts: zs.draw!.pts, cur: [p.x, p.y] } }); return; }
        moved.current = true;
        let pts = ptsOf(d.base[d.i]);
        if (d.kind === 'v') pts[d.k] = [p.x, p.y];
        else {
            const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
            const dx = clamp(p.rx - d.x0, -Math.min(...xs), 1 - Math.max(...xs)), dy = clamp(p.ry - d.y0, -Math.min(...ys), 1 - Math.max(...ys));
            pts = pts.map(([x, y]) => [x + dx, y + dy]);
        }
        d.list = replace(d.base, d.i, pts);
        onPolys(d.list, false);
    };

    const onUp = () => {
        const d = drag.current;
        drag.current = null;
        if (d?.list && moved.current) onPolys(d.list, true);
    };

    const hole = windows.reduce((acc, w) => {
        const [x, y, ww, hh] = w.crop;
        return `${acc}M${x * W} ${y * H}v${hh * H}h${ww * W}v${-hh * H}Z`;
    }, `M0 0H${W}V${H}H0Z`);
    const order = drawOrder(polys, catalog);
    // Выбранный контур поверх остальных
    const shown = zs.poly != null && order.includes(zs.poly) ? [...order.filter(i => i !== zs.poly), zs.poly] : order;
    const sel = zs.poly != null && order.includes(zs.poly) ? zs.poly : null;

    return (
        <svg className={`ve-svg src${zs.armed || zs.draw ? ' is-draw' : ''}`} viewBox={`0 0 ${W} ${H}`}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
            {/* Поле вокруг кадра: щелчок за краем ставит точку на край */}
            <rect className="zn-out" x={-W} y={-H} width={3 * W} height={3 * H} />
            {shown.map(i => {
                const p = polys[i], d = pathOf(p), on = i === sel;
                return (
                    <g key={i} className={`zn-pg${on ? ' is-sel' : ''}`} data-act="poly" data-i={i} style={{ '--z': zone(p.zone)!.color } as React.CSSProperties}>
                        <path className="f" d={d} />
                        <path className="u" d={d} strokeWidth={(on ? 4.6 : 3.6) * u} />
                        <path className="l" d={d} strokeWidth={(on ? 2.4 : 1.8) * u} />
                    </g>
                );
            })}
            {dim && <path d={hole} className="mask" fillRule="evenodd" pointerEvents="none" />}
            {windows.map(w => {
                const [x, y, ww, hh] = w.crop, bs = 14 * u;
                return (
                    <g key={w.n} pointerEvents="none">
                        <rect className="zn-win" x={x * W} y={y * H} width={ww * W} height={hh * H} strokeWidth={1.2 * u} />
                        <rect x={x * W + 4 * u} y={y * H + 4 * u} width={bs} height={bs} rx={3 * u} className="chip" opacity={0.8} />
                        <text x={x * W + 4 * u + bs / 2} y={y * H + 4 * u + bs * 0.74} textAnchor="middle" fontSize={9 * u} fontWeight={700} className="chip-t" opacity={0.75}>{w.n}</text>
                    </g>
                );
            })}
            {shown.map(i => {
                const p = polys[i], z = zone(p.zone)!, on = i === sel;
                // Ярлык у верхней левой вершины
                const v0 = ptsOf(p).reduce((m, q) => (q[0] < m[0] || (q[0] === m[0] && q[1] < m[1]) ? q : m));
                const txt = on ? `${rank(p.zone)} · ${z.name}` : String(rank(p.zone)), w = (txt.length * 6.9 + 12) * u, h = 19 * u;
                const lx = clamp(v0[0] * W + 8 * u, 2 * u, W - w - 2 * u), ly = clamp(v0[1] * H - h - 8 * u, 2 * u, H - h - 2 * u);
                return (
                    <g key={`l${i}`} pointerEvents="none">
                        <rect x={lx} y={ly} width={w} height={h} rx={4 * u} fill={z.color} stroke="rgba(14,16,21,.86)" strokeWidth={1.2 * u} />
                        <text x={lx + 6 * u} y={ly + 13.4 * u} fontSize={11 * u} fontWeight={700} className="zn-lt">{txt}</text>
                    </g>
                );
            })}
            {sel != null && <Handles key={`h${sel}`} pts={ptsOf(polys[sel])} W={W} H={H} u={u} />}
            {zs.draw && <Draft draw={zs.draw} color={zone(zs.zone)?.color ?? 'var(--acc)'} W={W} H={H} u={u} />}
        </svg>
    );
}

// Вершины, ручки на серединах рёбер и корзина выбранного контура
function Handles({ pts, W, H, u }: { pts: Pt[]; W: number; H: number; u: number }) {
    const a = 10.5 * u, hit = 22 * u, n = pts.length;
    // Корзина у верхней правой вершины
    const t = pts.reduce((m, q) => (q[0] - q[1] > m[0] - m[1] ? q : m)), r = 13 * u;
    const cx = clamp(t[0] * W + 30 * u, r, W - r), cy = clamp(t[1] * H - 20 * u, r, H - r);
    return (
        <g className="fade">
            {pts.map((A, k) => {
                const B = pts[(k + 1) % n], mx = (A[0] + B[0]) / 2 * W, my = (A[1] + B[1]) / 2 * H;
                return (
                    <g key={`m${k}`}>
                        <circle className="zn-mh" data-act="m" data-k={k} cx={mx} cy={my} r={9 * u} />
                        <g className="zn-mid" pointerEvents="none"><circle cx={mx} cy={my} r={3.8 * u} strokeWidth={1.4 * u} /></g>
                    </g>
                );
            })}
            {pts.map(([x, y], k) => (
                <g key={`v${k}`}>
                    <rect className="hit-anc" data-act="v" data-k={k} x={x * W - hit / 2} y={y * H - hit / 2} width={hit} height={hit} style={{ cursor: 'move' }} />
                    <g className="anc" pointerEvents="none"><rect x={x * W - a / 2} y={y * H - a / 2} width={a} height={a} rx={2 * u} strokeWidth={1.6 * u} /></g>
                </g>
            ))}
            <g className="del" data-act="pdel">
                <title>Удалить контур · Delete</title>
                <circle cx={cx} cy={cy} r={r} strokeWidth={u} />
                <use href="#i-trash" x={cx - 7 * u} y={cy - 7 * u} width={14 * u} height={14 * u} pointerEvents="none" />
            </g>
        </g>
    );
}

// Контур в рисовании: резинка к указателю, первая вершина подсвечена, когда можно замкнуть
function Draft({ draw, color, W, H, u }: { draw: { pts: Pt[]; cur: Pt }; color: string; W: number; H: number; u: number }) {
    const { pts, cur } = draw, f = pts[0], last = pts[pts.length - 1];
    const xy = ([x, y]: Pt) => `${(x * W).toFixed(1)} ${(y * H).toFixed(1)}`;
    const ready = pts.length >= 3, near = ready && Math.hypot((cur[0] - f[0]) * W, (cur[1] - f[1]) * H) / u < CLOSE_PX;
    const all = near ? pts : [...pts, cur];
    const line = pts.map(xy).join(' ');
    return (
        <g pointerEvents="none" style={{ '--z': color } as React.CSSProperties}>
            <path className="zn-dfill" d={`M${all.map(xy).join('L')}Z`} />
            <polyline className="zn-du" points={line} strokeWidth={3.6 * u} />
            <polyline className="zn-dl" points={line} strokeWidth={1.8 * u} />
            {near
                ? <path className="zn-drub" d={`M${xy(last)}L${xy(f)}`} strokeWidth={1.8 * u} />
                : <>
                    <path className="zn-drub" d={`M${xy(last)}L${xy(cur)}`} strokeWidth={1.6 * u} strokeDasharray={`${7 * u} ${6 * u}`} />
                    {ready && <path className="zn-drub2" d={`M${xy(cur)}L${xy(f)}`} strokeWidth={1.2 * u} strokeDasharray={`${4 * u} ${6 * u}`} />}
                </>}
            {pts.slice(1).map(([x, y], k) => (
                <rect key={k} className="zn-dv" x={x * W - 4.5 * u} y={y * H - 4.5 * u} width={9 * u} height={9 * u} rx={2 * u} strokeWidth={1.4 * u} />
            ))}
            <circle className={`zn-first${ready ? ' is-ready' : ''}${near ? ' is-near' : ''}`} cx={f[0] * W} cy={f[1] * H} r={(near ? 11 : 8) * u} strokeWidth={2 * u} />
            {!near && <path className="zn-cur" d={`M${cur[0] * W - 9 * u} ${cur[1] * H}h${18 * u}M${cur[0] * W} ${cur[1] * H - 9 * u}v${18 * u}`} strokeWidth={1.4 * u} />}
        </g>
    );
}
