import type maplibregl from 'maplibre-gl';
import Supercluster from 'supercluster';
import type { Verdict } from '../../api/journal-types';

// Точка журнала на карте: цвет уже высветлен для тёмной подложки
export interface MapPoint {
    id: number;
    lng: number;
    lat: number;
    ts: number;
    color: string;
    name: string;
    time: string;
    verdict: Verdict;
}

interface ClusterProps {
    shares: Record<string, number>;
}

// Элемент кадра в экранных координатах
export interface DrawItem {
    key: string;
    x: number;
    y: number;
    scale: number;
    alpha: number;
    point?: MapPoint;
    cluster?: { id: number; count: number; r0: number; shares: Array<[string, number]> };
}

// Элемент уровня кластеризации: координаты и состав
interface LevelItem {
    key: string;
    lng: number;
    lat: number;
    point?: MapPoint;
    cluster?: DrawItem['cluster'];
    leaves: number[];
}

// Радиус точки, радиус кольца выбора и толщина его линии
const R = 14;
const RING = 19;
const RING_W = 1.8;
const DARK = '#0a0e16';
const RING_COLOR = '#6aa6ff';
const HOVER_POINT = 1.25;
const HOVER_CLUSTER = 1.12;
const SELECT = 1.3;
const SCALE_MS = 260;
const RING_MS = 380;
const SPREAD_MS = 700;
// Скопления как в прежнем источнике MapLibre
const CLUSTER_RADIUS = 44;
const CLUSTER_MAX_ZOOM = 15;
const TAU = Math.PI * 2;

// Кривая cubic-bezier, как в CSS
function bezier(x1: number, y1: number, x2: number, y2: number) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
    const sy = (t: number) => ((ay * t + by) * t + cy) * t;
    const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
    return (x: number) => {
        let t = x;
        for (let i = 0; i < 8; i++) {
            const e = sx(t) - x;
            const d = dx(t);
            if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break;
            t = Math.min(1, Math.max(0, t - e / d));
        }
        return sy(t);
    };
}

const BOUNCE = bezier(0.34, 1.56, 0.64, 1);
const EASE_OUT = bezier(0.2, 0.8, 0.2, 1);
const inOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (v: number) => Math.max(0, Math.min(1, v));

// Плавное значение: при смене цели продолжает с текущего
class Tween {
    private from: number;
    private to: number;
    private t0 = 0;
    private readonly ms: number;
    private readonly ease: (t: number) => number;

    constructor(value: number, ms: number, ease: (t: number) => number) {
        this.from = value;
        this.to = value;
        this.ms = ms;
        this.ease = ease;
    }

    value(now: number): number {
        const k = this.ms ? clamp((now - this.t0) / this.ms) : 1;
        return this.from + (this.to - this.from) * this.ease(k);
    }

    set(to: number, now: number) {
        if (to === this.to) return;
        this.from = this.value(now);
        this.to = to;
        this.t0 = now;
    }

    busy(now: number): boolean {
        return now - this.t0 < this.ms;
    }
}

// Тёмный цвет класса на тёмной карте пропадает — высветляем до заметного
export function mapColor(color: string): string {
    const [r, g, b] = rgb(color);
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    if (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) >= 0.06) return color;
    const mix = (c: number) => Math.round((c * 0.62 + 0.38) * 255).toString(16).padStart(2, '0');
    return `#${mix(r)}${mix(g)}${mix(b)}`;
}

const rgbCache = new Map<string, [number, number, number]>();
const probe = document.createElement('canvas').getContext('2d')!;

// Цвет CSS в доли 0..1; браузер сам приводит любую запись к #rrggbb
function rgb(color: string): [number, number, number] {
    const hit = rgbCache.get(color);
    if (hit) return hit;
    probe.fillStyle = '#000000';
    probe.fillStyle = color;
    const hex = String(probe.fillStyle);
    const out: [number, number, number] = hex.startsWith('#')
        ? [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
        : [0.4, 0.55, 1];
    rgbCache.set(color, out);
    return out;
}

const radiusOf = (count: number) => (count < 5 ? 21 : count < 10 ? 24 : 28);

export class MapScene {
    private index = new Supercluster<MapPoint, ClusterProps>({
        radius: CLUSTER_RADIUS,
        maxZoom: CLUSTER_MAX_ZOOM,
        map: p => ({ shares: { [p.color]: 1 } }),
        reduce: (acc, p) => {
            for (const k in p.shares) acc.shares[k] = (acc.shares[k] ?? 0) + p.shares[k];
        },
    });

    private scales = new Map<string, Tween>();
    private rings = new Map<number, Tween>();
    private level = -1;
    private current: LevelItem[] = [];
    private spread: { t0: number; zoomIn: boolean; ghosts: LevelItem[]; home: Map<string, LevelItem> } | null = null;

    points = new Map<number, MapPoint>();
    selected: number | null = null;
    hover: string | null = null;
    // Мини-карта: без анимаций и без разлёта
    instant = false;
    // Множитель размера точек и скоплений
    size = 1;
    items: DrawItem[] = [];

    private readonly map: maplibregl.Map;

    constructor(map: maplibregl.Map) {
        this.map = map;
    }

    setData(points: MapPoint[]) {
        this.points = new Map(points.map(p => [p.id, p]));
        this.index.load(points.map(p => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
            properties: p,
        })));
        this.level = -1;
        this.spread = null;
    }

    // Состав скопления, новые сверху
    leavesOf(clusterId: number): number[] {
        return this.index.getLeaves(clusterId, Infinity)
            .map(f => f.properties as MapPoint)
            .sort((a, b) => b.ts - a.ts)
            .map(p => p.id);
    }

    // Элементы видимой области на целом уровне зума
    private collect(level: number): LevelItem[] {
        const b = this.map.getBounds();
        const padX = (b.getEast() - b.getWest()) * 0.15;
        const padY = (b.getNorth() - b.getSouth()) * 0.15;
        const bbox: [number, number, number, number] = [
            Math.max(-180, b.getWest() - padX), Math.max(-85, b.getSouth() - padY),
            Math.min(180, b.getEast() + padX), Math.min(85, b.getNorth() + padY),
        ];
        return this.index.getClusters(bbox, level).map(f => {
            const [lng, lat] = f.geometry.coordinates;
            const props = f.properties as MapPoint & Partial<Supercluster.ClusterProperties> & Partial<ClusterProps>;
            if (props.cluster) {
                const id = props.cluster_id!;
                const count = props.point_count!;
                const shares = Object.entries(props.shares ?? {}).sort((a, b) => b[1] - a[1]);
                return { key: `c:${id}:${level}`, lng, lat, cluster: { id, count, r0: radiusOf(count), shares }, leaves: [] };
            }
            const point = this.points.get(props.id)!;
            return { key: `p:${point.id}`, lng, lat, point, leaves: [point.id] };
        });
    }

    // Все точки элемента — нужны, чтобы найти родителя при разлёте
    private fill(items: LevelItem[]) {
        for (const it of items) {
            if (it.cluster && !it.leaves.length) it.leaves = this.index.getLeaves(it.cluster.id, Infinity).map(f => (f.properties as MapPoint).id);
        }
    }

    private startSpread(now: number, next: LevelItem[], zoomIn: boolean) {
        const ghosts = this.current;
        const coarse = zoomIn ? ghosts : next;
        const fine = zoomIn ? next : ghosts;
        this.fill(coarse);
        const owner = new Map<number, LevelItem>();
        for (const it of coarse) for (const id of it.leaves) owner.set(id, it);
        const home = new Map<string, LevelItem>();
        for (const it of fine) {
            const first = it.point ? it.point.id : this.index.getLeaves(it.cluster!.id, 1)[0]?.properties.id;
            const parent = first !== undefined ? owner.get(first) : undefined;
            if (parent && parent.key !== it.key) home.set(it.key, parent);
        }
        this.spread = { t0: now, zoomIn, ghosts, home };
    }

    // Кадр: состав, положения и анимации; true — нужен ещё кадр
    frame(now: number): boolean {
        const level = Math.min(Math.floor(this.map.getZoom()), CLUSTER_MAX_ZOOM + 1);
        const next = this.collect(level);
        if (this.level >= 0 && level !== this.level && !this.instant) this.startSpread(now, next, level > this.level);
        this.level = level;
        this.current = next;

        let busy = false;
        const out: DrawItem[] = [];
        const at = (lng: number, lat: number) => this.map.project([lng, lat]);
        const sp = this.spread && now - this.spread.t0 < SPREAD_MS ? this.spread : null;
        if (!sp) this.spread = null;
        else busy = true;

        const e = sp ? inOutCubic(sp.zoomIn ? clamp((now - sp.t0) / SPREAD_MS) : 1 - clamp((now - sp.t0) / SPREAD_MS)) : 1;
        const coarseAlpha = clamp(1 - e / 0.35);
        const fineAlpha = clamp((e - 0.15) / 0.3);
        const fly = clamp((e - 0.08) / 0.62);

        const push = (it: LevelItem, alpha: number, homeOf?: LevelItem) => {
            let p = at(it.lng, it.lat);
            if (homeOf) {
                const h = at(homeOf.lng, homeOf.lat);
                p = { x: h.x + (p.x - h.x) * fly, y: h.y + (p.y - h.y) * fly } as typeof p;
            }
            const s = this.scaleOf(it, now);
            if (s.busy) busy = true;
            out.push({ key: it.key, x: p.x, y: p.y, scale: s.value * this.size, alpha, point: it.point, cluster: it.cluster });
        };

        if (sp) {
            const coarse = sp.zoomIn ? sp.ghosts : next;
            const fine = sp.zoomIn ? next : sp.ghosts;
            for (const it of coarse) push(it, coarseAlpha);
            for (const it of fine) push(it, sp.zoomIn && !sp.home.has(it.key) ? 1 : fineAlpha, sp.home.get(it.key));
        } else {
            for (const it of next) push(it, 1);
        }

        if (this.selected !== null) this.ringOf(this.selected, now);
        for (const [id, ring] of this.rings) {
            ring.set(id === this.selected ? 1 : 0, now);
            if (ring.busy(now)) busy = true;
        }

        // Наведённый и выбранный — поверх остальных
        const rank = (d: DrawItem) => (d.point?.id === this.selected ? 2 : d.key === this.hover ? 1 : 0);
        this.items = out.sort((a, b) => rank(a) - rank(b));
        return busy;
    }

    private scaleOf(it: LevelItem, now: number) {
        let tw = this.scales.get(it.key);
        if (!tw) {
            tw = new Tween(1, this.instant ? 0 : SCALE_MS, BOUNCE);
            this.scales.set(it.key, tw);
        }
        const target = it.point
            ? (it.point.id === this.selected ? SELECT : it.key === this.hover ? HOVER_POINT : 1)
            : (it.key === this.hover ? HOVER_CLUSTER : 1);
        tw.set(target, now);
        return { value: tw.value(now), busy: tw.busy(now) };
    }

    ringOf(id: number, now: number): number {
        let tw = this.rings.get(id);
        if (!tw) {
            tw = new Tween(this.instant && id === this.selected ? 1 : 0, this.instant ? 0 : RING_MS, EASE_OUT);
            this.rings.set(id, tw);
        }
        tw.set(id === this.selected ? 1 : 0, now);
        return tw.value(now);
    }

    // Верхний элемент под указателем
    hit(x: number, y: number): DrawItem | null {
        for (let i = this.items.length - 1; i >= 0; i--) {
            const it = this.items[i];
            if (it.alpha < 0.5) continue;
            const r = it.point ? (R + 1) * it.scale : it.cluster!.r0 * it.scale;
            if ((it.x - x) ** 2 + (it.y - y) ** 2 <= r * r) return it;
        }
        return null;
    }
}

const VERT = `
attribute vec2 a_center;
attribute vec2 a_corner;
attribute vec2 a_half;
attribute float a_kind;
attribute vec4 a_color;
attribute vec4 a_p;
uniform vec2 u_view;
varying vec2 v_local;
varying float v_kind;
varying vec4 v_color;
varying vec4 v_p;
varying vec2 v_uv;
void main() {
    vec2 px = a_center + a_corner * a_half;
    v_local = a_corner * a_half;
    v_kind = a_kind;
    v_color = a_color;
    v_p = a_p;
    v_uv = mix(a_p.xy, a_p.zw, a_corner * 0.5 + 0.5);
    gl_Position = vec4(px.x / u_view.x * 2.0 - 1.0, 1.0 - px.y / u_view.y * 2.0, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec2 v_local;
varying float v_kind;
varying vec4 v_color;
varying vec4 v_p;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_aa;
uniform vec3 u_dark;
uniform vec3 u_ring;
float band(float d, float r0, float r1) {
    return clamp((d - r0) / u_aa + 0.5, 0.0, 1.0) * clamp((r1 - d) / u_aa + 0.5, 0.0, 1.0);
}
float angle() {
    float a = atan(v_local.x, -v_local.y);
    return a < 0.0 ? a + 6.2831853 : a;
}
void main() {
    float d = length(v_local);
    vec4 c = vec4(0.0);
    if (v_kind < 0.5) {
        float s = v_p.x;
        float r = v_p.z * s;
        c = vec4(v_color.rgb, 1.0) * band(d, -1.0, r - s) + vec4(u_dark, 1.0) * band(d, r - s, r + s);
        float prog = v_p.y;
        if (prog > 0.001) {
            float rr = v_p.w * s;
            float on = clamp((prog * 6.2831853 - angle()) * rr / u_aa + 0.5, 0.0, 1.0);
            c += vec4(u_ring, 1.0) * band(d, rr - 0.9 * s, rr + 0.9 * s) * on;
        }
    } else if (v_kind < 1.5) {
        c = vec4(u_dark, 1.0) * band(d, -1.0, v_p.z * v_p.x);
    } else if (v_kind < 2.5) {
        float s = v_p.x;
        float rr = v_p.w * s;
        float a = angle();
        float cov = clamp((a - v_p.y) * rr / u_aa + 0.5, 0.0, 1.0) * clamp((v_p.z - a) * rr / u_aa + 0.5, 0.0, 1.0);
        c = vec4(v_color.rgb, 1.0) * band(d, rr - 3.0 * s, rr + 3.0 * s) * cov;
    } else {
        c = vec4(1.0) * texture2D(u_tex, v_uv).a;
    }
    gl_FragColor = c * v_color.a;
}`;

// Поля вершины: центр, угол квада, полуразмер, вид, цвет с прозрачностью, параметры вида
const STRIDE = 15;
const CORNERS = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1];

interface Glyphs {
    tex: WebGLTexture;
    // Для каждой цифры: левый и правый край в долях атласа и ширина в CSS-пикселях
    box: Array<[number, number, number]>;
    height: number;
    // Поле вокруг цифры в атласе, CSS-пиксели
    pad: number;
}

// Слой точек журнала поверх подложки: всё рисует один шейдер
export class PointsLayer implements maplibregl.CustomLayerInterface {
    readonly id = 'journal-points';
    readonly type = 'custom' as const;
    readonly renderingMode = '2d' as const;

    private map!: maplibregl.Map;
    private gl!: WebGLRenderingContext | WebGL2RenderingContext;
    private program!: WebGLProgram;
    private buffer!: WebGLBuffer;
    private vao: { bind: (on: boolean) => void } | null = null;
    private glyphs: Glyphs | null = null;
    private data = new Float32Array(STRIDE * 6 * 256);
    private loc: Record<string, number> = {};
    private uni: Record<string, WebGLUniformLocation | null> = {};

    private readonly scene: MapScene;
    private readonly onFrame: () => void;

    constructor(scene: MapScene, onFrame: () => void) {
        this.scene = scene;
        this.onFrame = onFrame;
    }

    onAdd(map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext) {
        this.map = map;
        this.gl = gl;
        const shader = (type: number, src: string) => {
            const s = gl.createShader(type)!;
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('[JournalMap] shader:', gl.getShaderInfoLog(s));
            return s;
        };
        const program = gl.createProgram()!;
        gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT));
        gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(program);
        this.program = program;
        for (const a of ['a_center', 'a_corner', 'a_half', 'a_kind', 'a_color', 'a_p']) this.loc[a] = gl.getAttribLocation(program, a);
        for (const u of ['u_view', 'u_aa', 'u_tex', 'u_dark', 'u_ring']) this.uni[u] = gl.getUniformLocation(program, u);
        this.buffer = gl.createBuffer()!;
        this.vao = this.makeVao(gl);
        this.buildGlyphs();
        document.fonts?.load('700 15px Inter').then(() => {
            this.buildGlyphs();
            map.triggerRepaint();
        }).catch(() => {});
    }

    onRemove(_map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext) {
        gl.deleteBuffer(this.buffer);
        gl.deleteProgram(this.program);
        if (this.glyphs) gl.deleteTexture(this.glyphs.tex);
    }

    // Свой массив вершин: чужой VAO карты трогать нельзя
    private makeVao(gl: WebGLRenderingContext | WebGL2RenderingContext) {
        if ('createVertexArray' in gl) {
            const vao = gl.createVertexArray();
            return { bind: (on: boolean) => gl.bindVertexArray(on ? vao : null) };
        }
        const ext = gl.getExtension('OES_vertex_array_object');
        if (!ext) return null;
        const vao = ext.createVertexArrayOES();
        return { bind: (on: boolean) => ext.bindVertexArrayOES(on ? vao : null) };
    }

    // Атлас цифр счёта скоплений: Inter 700 15px белым
    private buildGlyphs() {
        const gl = this.gl;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const font = `700 ${15 * dpr}px Inter, system-ui, sans-serif`;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        ctx.font = font;
        const widths = [...'0123456789'].map(ch => Math.ceil(ctx.measureText(ch).width) + 2);
        const height = Math.ceil(20 * dpr);
        canvas.width = widths.reduce((a, b) => a + b, 0);
        canvas.height = height;
        ctx.font = font;
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        const box: Glyphs['box'] = [];
        let x = 0;
        [...'0123456789'].forEach((ch, i) => {
            ctx.fillText(ch, x + 1, height / 2);
            box.push([x / canvas.width, (x + widths[i]) / canvas.width, widths[i] / dpr]);
            x += widths[i];
        });
        const tex = this.glyphs?.tex ?? gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.glyphs = { tex, box, height: height / dpr, pad: 1 / dpr };
    }

    private n = 0;

    private quad(cx: number, cy: number, hx: number, hy: number, kind: number, color: [number, number, number], alpha: number, p: [number, number, number, number]) {
        const need = (this.n + 6) * STRIDE;
        if (need > this.data.length) {
            const grown = new Float32Array(this.data.length * 2);
            grown.set(this.data);
            this.data = grown;
        }
        for (let i = 0; i < 6; i++) {
            const o = (this.n + i) * STRIDE;
            this.data.set([cx, cy, CORNERS[i * 2], CORNERS[i * 2 + 1], hx, hy, kind, color[0], color[1], color[2], alpha, p[0], p[1], p[2], p[3]], o);
        }
        this.n += 6;
    }

    private build(now: number) {
        this.n = 0;
        const white: [number, number, number] = [1, 1, 1];
        for (const it of this.scene.items) {
            if (it.alpha <= 0.01) continue;
            const s = it.scale;
            if (it.point) {
                const ring = this.scene.ringOf(it.point.id, now);
                const half = (RING + RING_W) * s + 2;
                this.quad(it.x, it.y, half, half, 0, rgb(it.point.color), it.alpha, [s, ring, R, RING]);
                continue;
            }
            const cl = it.cluster!;
            const half = (cl.r0 + 1) * s + 2;
            this.quad(it.x, it.y, half, half, 1, white, it.alpha, [s, 0, cl.r0 - 1, 0]);
            const rr = cl.r0 - 4;
            const circ = TAU * rr;
            const gap = cl.shares.length > 1 ? 1.8 : 0;
            let off = 0;
            for (const [color, n] of cl.shares) {
                const len = (circ * n) / cl.count;
                const a0 = (off / circ) * TAU;
                const a1 = a0 + (Math.max(len - gap, 0.8) / circ) * TAU;
                this.quad(it.x, it.y, half, half, 2, rgb(color), it.alpha, [s, a0, a1, rr]);
                off += len;
            }
            this.text(String(cl.count), it.x, it.y, s, it.alpha);
        }
    }

    private text(str: string, x: number, y: number, s: number, alpha: number) {
        const g = this.glyphs;
        if (!g) return;
        const digits = [...str].map(ch => g.box[ch.charCodeAt(0) - 48]).filter(Boolean);
        const advance = (w: number) => (w - 2 * g.pad) * s;
        let left = x - digits.reduce((a, d) => a + advance(d[2]), 0) / 2;
        const hy = (g.height / 2) * s;
        for (const [u0, u1, w] of digits) {
            this.quad(left + advance(w) / 2, y, (w / 2) * s, hy, 3, [1, 1, 1], alpha, [u0, 0, u1, 1]);
            left += advance(w);
        }
    }

    render(gl: WebGLRenderingContext | WebGL2RenderingContext) {
        const now = performance.now();
        const busy = this.scene.frame(now);
        this.build(now);
        this.onFrame();
        if (this.n) {
            const canvas = this.map.getCanvas();
            const dpr = canvas.width / Math.max(1, canvas.clientWidth);
            gl.useProgram(this.program);
            this.vao?.bind(true);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
            gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.n * STRIDE), gl.DYNAMIC_DRAW);
            const F = 4;
            const attr = (name: string, size: number, offset: number) => {
                const l = this.loc[name];
                if (l < 0) return;
                gl.enableVertexAttribArray(l);
                gl.vertexAttribPointer(l, size, gl.FLOAT, false, STRIDE * F, offset * F);
            };
            attr('a_center', 2, 0);
            attr('a_corner', 2, 2);
            attr('a_half', 2, 4);
            attr('a_kind', 1, 6);
            attr('a_color', 4, 7);
            attr('a_p', 4, 11);
            gl.uniform2f(this.uni.u_view, canvas.clientWidth, canvas.clientHeight);
            gl.uniform1f(this.uni.u_aa, 1 / dpr);
            gl.uniform3fv(this.uni.u_dark, rgb(DARK));
            gl.uniform3fv(this.uni.u_ring, rgb(RING_COLOR));
            gl.activeTexture(gl.TEXTURE0);
            if (this.glyphs) gl.bindTexture(gl.TEXTURE_2D, this.glyphs.tex);
            gl.uniform1i(this.uni.u_tex, 0);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.STENCIL_TEST);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.drawArrays(gl.TRIANGLES, 0, this.n);
            if (this.vao) this.vao.bind(false);
            else for (const l of Object.values(this.loc)) if (l >= 0) gl.disableVertexAttribArray(l);
        }
        if (busy) this.map.triggerRepaint();
    }
}
