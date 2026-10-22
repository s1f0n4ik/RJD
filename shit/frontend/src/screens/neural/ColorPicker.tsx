import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { elementAnchor, usePopover } from '../../app/popover';

const HEX = /^#[0-9a-f]{6}$/i;
const FALLBACK = '#68a5ff';

interface Hsv { h: number; s: number; v: number }

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// #rrggbb → тон 0…360, насыщенность и яркость 0…1
export function hexToHsv(hex: string): Hsv {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    let h = 0;
    if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: h * 60, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
    const f = (n: number) => {
        const k = (n + h / 60) % 6;
        return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
    };
    return `#${[f(5), f(3), f(1)].map(x => x.toString(16).padStart(2, '0')).join('')}`;
}

// Ввод HEX без решётки тоже принимается
const parseHex = (raw: string) => {
    const t = raw.trim();
    return (t.startsWith('#') ? t : `#${t}`).toLowerCase();
};

interface ColorPickerProps {
    // Кнопка, под которой открыто окно; нажатие по ней окно не закрывает — она переключает сама
    anchor: HTMLElement;
    color: string;
    onChange: (hex: string) => void;
    onClose: () => void;
}

// Свой цвет: поле насыщенности и яркости, ползунок тона, поле HEX
export function ColorPicker({ anchor, color, onChange, onClose }: ColorPickerProps) {
    const safe = HEX.test(color) ? color.toLowerCase() : FALLBACK;
    // Тон и насыщенность держатся отдельно: у серого и чёрного из цвета их не восстановить
    const [hsv, setHsv] = useState(() => hexToHsv(safe));
    const hsvRef = useRef(hsv);
    const [text, setText] = useState(safe.toUpperCase());
    const inputRef = useRef<HTMLInputElement>(null);
    const ref = usePopover<HTMLDivElement>(elementAnchor(anchor), { side: 'bottom', align: 'end', gap: 6 });

    // Цвет сменили снаружи — ручки и поле следуют за ним
    useEffect(() => {
        if (hsvToHex(hsvRef.current) !== safe) {
            hsvRef.current = hexToHsv(safe);
            setHsv(hsvRef.current);
        }
        if (document.activeElement !== inputRef.current) setText(safe.toUpperCase());
    }, [safe]);

    // Нажатие мимо, Esc, прокрутка и ресайз закрывают: fixed-позиция устаревает
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (!ref.current?.contains(target) && !anchor.contains(target)) onClose();
        };
        // Esc в фазе захвата: модалка под окном его не получает
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            onClose();
        };
        const onScroll = (e: Event) => {
            if (!ref.current?.contains(e.target as Node)) onClose();
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onClose);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onClose);
        };
    }, [anchor, onClose, ref]);

    const set = (next: Hsv) => {
        hsvRef.current = next;
        setHsv(next);
        onChange(hsvToHex(next));
    };

    const atSv = (e: React.PointerEvent<HTMLDivElement>) => {
        const r = e.currentTarget.getBoundingClientRect();
        set({ ...hsvRef.current, s: clamp01((e.clientX - r.left) / r.width), v: 1 - clamp01((e.clientY - r.top) / r.height) });
    };
    const atHue = (e: React.PointerEvent<HTMLDivElement>) => {
        const r = e.currentTarget.getBoundingClientRect();
        set({ ...hsvRef.current, h: clamp01((e.clientX - r.left) / r.width) * 359.9 });
    };
    // Захват указателя: ручка едет, даже когда указатель ушёл за край
    const drag = (at: (e: React.PointerEvent<HTMLDivElement>) => void) => ({
        onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => { e.currentTarget.setPointerCapture(e.pointerId); at(e); },
        onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) at(e); },
    });

    const typeHex = (raw: string) => {
        setText(raw);
        const hex = parseHex(raw);
        if (!HEX.test(hex)) return;
        hsvRef.current = hexToHsv(hex);
        setHsv(hsvRef.current);
        onChange(hex);
    };

    return createPortal(
        <div ref={ref} className="cpk" style={{ '--c': safe, '--h': `hsl(${hsv.h} 100% 50%)` } as React.CSSProperties}>
            <div className="cpk-sv" {...drag(atSv)}>
                <b style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
            </div>
            <div className="cpk-hue" {...drag(atHue)}>
                <b style={{ left: `${hsv.h / 3.6}%` }} />
            </div>
            <div className="cpk-row">
                <span className="cpk-sw" />
                <div className="tf">
                    <span className="tf-cap">HEX</span>
                    <input
                        ref={inputRef}
                        className={`tf-in${HEX.test(parseHex(text)) ? '' : ' is-err'}`}
                        value={text}
                        maxLength={7}
                        spellCheck={false}
                        onChange={e => typeHex(e.target.value)}
                        onBlur={() => setText(safe.toUpperCase())}
                        onKeyDown={e => {
                            if (e.key !== 'Enter') return;
                            e.preventDefault();
                            e.stopPropagation();
                            onClose();
                        }}
                    />
                </div>
            </div>
        </div>,
        document.body,
    );
}

// Образец цвета: нажатие открывает окно своего цвета
export function ColorSwatch({ color, onChange }: { color: string; onChange: (c: string) => void }) {
    const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
    return (
        <>
            <button
                type="button"
                className={`swatch${anchor ? ' is-open' : ''}`}
                style={{ background: color }}
                data-tip="Цвет"
                aria-label="Цвет"
                onClick={e => setAnchor(anchor ? null : e.currentTarget)}
            />
            {anchor && <ColorPicker anchor={anchor} color={color} onChange={onChange} onClose={() => setAnchor(null)} />}
        </>
    );
}
