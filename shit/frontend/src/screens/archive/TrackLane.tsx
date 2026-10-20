import { memo, useLayoutEffect, useRef, useState } from 'react';

import type { Stripes } from './model';
import { isAvailable } from './model';

// Полосы дорожки таймлайна на холсте: куски, разрывы и плотные блоки

interface Props {
    stripes: Stripes;
    from: number;
    to: number;
    selected: boolean;
    trusted: boolean;
    title?: string;
    inset?: number;
}

// Отступ полосы от краёв дорожки и скругление куска
const INSET = 7;
const RADIUS = 3;

type Rgb = [number, number, number];

// Штриховка «\»: полоса a шириной band, остальное b; period — шаг поперёк полос
interface Hatch {
    a: Rgb;
    aAlpha: number;
    b: Rgb;
    bAlpha: number;
    period: number;
    band: number;
}

const tiles = new Map<string, HTMLCanvasElement>();

// Плитка в пикселях экрана с жёсткими краями, как у repeating-linear-gradient
function hatchTile(hatch: Hatch, dpr: number): HTMLCanvasElement {
    const key = JSON.stringify([hatch, dpr]);
    const cached = tiles.get(key);
    if (cached) return cached;

    const size = Math.max(2, Math.round(hatch.period * Math.SQRT2 * dpr));
    const edge = (hatch.band / hatch.period) * size;
    const tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;

    const ctx = tile.getContext('2d');
    if (ctx) {
        const image = ctx.createImageData(size, size);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const inBand = (x - y + size) % size < edge;
                const rgb = inBand ? hatch.a : hatch.b;
                const alpha = inBand ? hatch.aAlpha : hatch.bAlpha;
                image.data.set([rgb[0], rgb[1], rgb[2], Math.round(alpha * 255)], (y * size + x) * 4);
            }
        }
        ctx.putImageData(image, 0, 0);
    }

    tiles.set(key, tile);
    return tile;
}

function hatchFill(ctx: CanvasRenderingContext2D, hatch: Hatch, dpr: number): CanvasPattern | string {
    const pattern = ctx.createPattern(hatchTile(hatch, dpr), 'repeat');
    if (!pattern) return 'transparent';
    // Контекст масштабирован на dpr, плитка уже в пикселях экрана
    pattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
    return pattern;
}

// Холст сам приводит цвет к #rrggbb
function rgbOf(ctx: CanvasRenderingContext2D, css: string): Rgb {
    ctx.fillStyle = css;
    const hex = String(ctx.fillStyle);
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

const rgba = ([r, g, b]: Rgb, alpha: number) => `rgba(${r},${g},${b},${alpha})`;

function drawLane(
    ctx: CanvasRenderingContext2D,
    { runs, gaps, dense }: Stripes,
    from: number,
    to: number,
    width: number,
    height: number,
    selected: boolean,
    trusted: boolean,
    dpr: number,
    inset: number,
) {
    const css = getComputedStyle(ctx.canvas);
    const acc = rgbOf(ctx, `rgb(${css.getPropertyValue('--acc-rgb')})`);
    const err = rgbOf(ctx, css.getPropertyValue('--err'));
    const fg = rgbOf(ctx, css.getPropertyValue('--fg-2'));
    const none: Rgb = [0, 0, 0];

    const doubtFill = hatchFill(ctx, { a: acc, aAlpha: 0.4, b: acc, bAlpha: 0.14, period: 10, band: 5 }, dpr);
    const goneFill = hatchFill(ctx, {
        a: fg, aAlpha: selected ? 0.42 : 0.3, b: fg, bAlpha: selected ? 0.12 : 0.08, period: 10, band: 5,
    }, dpr);
    const gapFill = hatchFill(ctx, { a: err, aAlpha: 0.26, b: none, bAlpha: 0, period: 10, band: 5 }, dpr);
    const denseFill = hatchFill(ctx, { a: err, aAlpha: selected ? 0.6 : 0.55, b: none, bAlpha: 0, period: 7, band: 3 }, dpr);

    const top = inset;
    const h = height - inset * 2;
    const x = (ms: number) => ((ms - from) / (to - from)) * width;

    // Контур полосы; за краем окна обрезается с запасом, чтобы скругление туда не попадало
    const outline = (start: number, end: number, margin: number, radius: number): [number, number] => {
        const x0 = Math.max(x(start), -margin);
        const x1 = Math.min(x(end), width + margin);
        ctx.beginPath();
        ctx.roundRect(x0, top, x1 - x0, h, radius);
        return [x0, x1];
    };

    for (const run of runs) {
        outline(run.start_ms, run.end_ms, RADIUS + 1, RADIUS);
        if (!isAvailable(run)) {
            ctx.fillStyle = goneFill;
            ctx.fill();
            // Рамка внутрь: половина обводки срезается контуром
            ctx.save();
            ctx.clip();
            ctx.strokeStyle = rgba(fg, 0.24);
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.restore();
        } else {
            // На выбранной дорожке недостоверный кусок сплошной
            ctx.fillStyle = selected ? rgba(acc, 0.62) : trusted ? rgba(acc, 0.45) : doubtFill;
            ctx.fill();
        }
    }

    for (const gap of gaps) {
        const [x0, x1] = outline(gap.start_ms, gap.end_ms, 0, 0);
        ctx.fillStyle = gapFill;
        ctx.fill();
        ctx.fillStyle = rgba(err, 0.45);
        ctx.fillRect(x0, top, 1, h);
        ctx.fillRect(x1 - 1, top, 1, h);
    }

    for (const block of dense) {
        outline(block.start_ms, block.end_ms, RADIUS + 1, RADIUS);
        ctx.fillStyle = rgba(acc, selected ? 0.45 : 0.3);
        ctx.fill();
        ctx.fillStyle = denseFill;
        ctx.fill();
    }
}

export const TrackLane = memo(function TrackLane({ stripes, from, to, selected, trusted, title, inset = INSET }: Props) {
    const canvas = useRef<HTMLCanvasElement | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });

    useLayoutEffect(() => {
        const element = canvas.current;
        if (!element) return;

        const observer = new ResizeObserver(() => {
            setSize({ width: element.clientWidth, height: element.clientHeight });
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useLayoutEffect(() => {
        const element = canvas.current;
        const ctx = element?.getContext('2d');
        if (!element || !ctx || !size.width) return;

        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(size.width * dpr);
        const h = Math.round(size.height * dpr);
        if (element.width !== w || element.height !== h) {
            element.width = w;
            element.height = h;
        }

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size.width, size.height);
        drawLane(ctx, stripes, from, to, size.width, size.height, selected, trusted, dpr, inset);
    }, [stripes, from, to, size, selected, trusted, inset]);

    return <canvas ref={canvas} className="tl-lane" title={title} />;
});
