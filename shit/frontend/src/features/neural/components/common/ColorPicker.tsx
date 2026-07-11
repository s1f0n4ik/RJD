import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface ColorPickerProps {
  value: string;
  onChange: (hex: string) => void;
  /** Класс триггера-свотча (row-swatch / swatch-color), чтобы вписаться в разметку. */
  swatchClass?: string;
  title?: string;
}

// Палитра-подсказка: набор различимых оттенков под классы детекции.
const PRESETS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#4d8bff', '#6366f1', '#8b5cf6',
  '#d946ef', '#ec4899', '#f43f5e', '#e5e7eb', '#9ca3af', '#4b5563',
];

const POP_W = 232;
const POP_H = 268;

/** Кастомный color-picker в стиле страницы: SV-поле, ползунок тона, hex и пресеты.
 *  Поповер рендерится в портал с fixed-позицией, чтобы не обрезался скроллом списка. */
export function ColorPicker({ value, onChange, swatchClass = 'row-swatch', title }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [hsv, setHsv] = useState(() => rgbToHsv(hexToRgb(value)));
  const [svDown, setSvDown] = useState(false);
  const [hueDown, setHueDown] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;
  const dragging = svDown || hueDown;

  // синхронизация из внешнего значения, когда не тащим ползунок
  useEffect(() => {
    if (!dragging) setHsv(rgbToHsv(hexToRgb(value)));
  }, [value, dragging]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onScroll = () => setOpen(false);
    const onResize = () => setOpen(false);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function place() {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    let left = r.left;
    let top = r.bottom + 6;
    if (left + POP_W > window.innerWidth - 8) left = window.innerWidth - POP_W - 8;
    if (left < 8) left = 8;
    if (top + POP_H > window.innerHeight - 8) top = r.top - POP_H - 6;
    setPos({ left, top });
  }

  function emit(next: { h: number; s: number; v: number }) {
    setHsv(next);
    onChange(rgbToHex(hsvToRgb(next)));
  }

  function updateSV(e: React.PointerEvent) {
    const r = e.currentTarget.getBoundingClientRect();
    const s = clamp01((e.clientX - r.left) / r.width);
    const v = 1 - clamp01((e.clientY - r.top) / r.height);
    emit({ h: hsvRef.current.h, s, v });
  }

  function updateHue(e: React.PointerEvent) {
    const r = e.currentTarget.getBoundingClientRect();
    const h = clamp01((e.clientX - r.left) / r.width) * 360;
    emit({ h, s: hsvRef.current.s, v: hsvRef.current.v });
  }

  const hex = rgbToHex(hsvToRgb(hsv));

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`${swatchClass} cp-trigger`}
        style={{ background: value }}
        title={title}
        onClick={() => setOpen((o) => !o)}
      />
      {open && pos && createPortal(
        <div className="cp-pop" ref={popRef} style={{ left: pos.left, top: pos.top, width: POP_W }}>
          <div
            className="cp-sv"
            style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${hsv.h}, 100%, 50%)` }}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setSvDown(true); updateSV(e); }}
            onPointerMove={(e) => svDown && updateSV(e)}
            onPointerUp={() => setSvDown(false)}
          >
            <span className="cp-sv-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
          </div>

          <div
            className="cp-hue"
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setHueDown(true); updateHue(e); }}
            onPointerMove={(e) => hueDown && updateHue(e)}
            onPointerUp={() => setHueDown(false)}
          >
            <span className="cp-hue-thumb" style={{ left: `${(hsv.h / 360) * 100}%` }} />
          </div>

          <div className="cp-row">
            <span className="cp-preview" style={{ background: hex }} />
            <input
              className="cp-hex"
              value={hex}
              spellCheck={false}
              onChange={(e) => {
                const next = e.target.value.trim();
                onChange(next);
                if (/^#[0-9a-fA-F]{6}$/.test(next)) setHsv(rgbToHsv(hexToRgb(next)));
              }}
            />
          </div>

          <div className="cp-presets">
            {PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                className={`cp-preset${eqHex(c, hex) ? ' active' : ''}`}
                style={{ background: c }}
                title={c}
                onClick={() => { onChange(c); setHsv(rgbToHsv(hexToRgb(c))); }}
              />
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ── цветовые преобразования ────────────────────────────────
function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function eqHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function hexToRgb(c: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(c) || /^#?([0-9a-fA-F]{3})$/.exec(c);
  if (!m) return { r: 136, g: 136, b: 136 };
  let h = m[1];
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const hex = (v: number) => Math.round(clamp01(v / 255) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function rgbToHsv({ r, g, b }: { r: number; g: number; b: number }): { h: number; s: number; v: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToRgb({ h, s, v }: { h: number; s: number; v: number }): { r: number; g: number; b: number } {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rp = 0, gp = 0, bp = 0;
  if (h < 60) [rp, gp, bp] = [c, x, 0];
  else if (h < 120) [rp, gp, bp] = [x, c, 0];
  else if (h < 180) [rp, gp, bp] = [0, c, x];
  else if (h < 240) [rp, gp, bp] = [0, x, c];
  else if (h < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return { r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255 };
}
