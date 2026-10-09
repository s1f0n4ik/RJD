import io
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import NamedTuple, Optional, Union

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = Path(__file__).resolve().parents[1] / "fonts"
INTER_SB = FONTS / "Inter-SemiBold.otf"
MONO_MD = FONTS / "JetBrainsMono-Medium.ttf"
MONO_SB = FONTS / "JetBrainsMono-SemiBold.ttf"

# Токены приложения: tokens.css
ACC = "#5b9dff"
BG = (18, 20, 26)
LINE_HI = (69, 79, 102)
FG = (241, 243, 249)
FG2 = (176, 185, 203)
FG3 = (123, 134, 152)
OK = (87, 214, 154)
LABEL_TEXT = (10, 12, 17)
JPEG_QUALITY = 90


class Box(NamedTuple):
    x: int
    y: int
    w: int
    h: int
    label: str
    color: str = ACC


@lru_cache(maxsize=16)
def _font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), max(8, size))


# Время шлюза уже настенное: форматируется как UTC
def wall(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, timezone.utc).strftime("%d.%m.%Y %H:%M:%S")


def _rgb(color: str) -> tuple[int, int, int]:
    c = color.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def _boxes(img: Image.Image, boxes: list[Box], s: float) -> None:
    d = ImageDraw.Draw(img)
    stroke = max(2, round(2 * s))
    font = _font(MONO_SB, round(13 * s))
    pad_x, pad_y = round(6 * s), round(3 * s)
    radius = round(4 * s)
    for b in boxes:
        color = _rgb(b.color or ACC)
        d.rounded_rectangle([b.x, b.y, b.x + b.w, b.y + b.h], radius=max(2, round(2 * s)), outline=color, width=stroke)
        tw = d.textlength(b.label, font=font)
        th = font.size + pad_y * 2
        above = b.y - th >= 0
        ty = b.y - th if above else b.y + b.h
        x0 = b.x - stroke // 2
        d.rounded_rectangle([x0, ty, x0 + tw + pad_x * 2, ty + th], radius=radius, fill=color,
                            corners=(True, True, False, False) if above else (False, False, True, True))
        d.text((x0 + pad_x, ty + pad_y - round(s)), b.label, font=font, fill=LABEL_TEXT)


def _spaced(d: ImageDraw.ImageDraw, x: float, y: float, text: str, font, fill, spacing: float) -> None:
    for ch in text:
        d.text((x, y), ch, font=font, fill=fill)
        x += d.textlength(ch, font=font) + spacing


def _glow_dot(img: Image.Image, cx: float, cy: float, r: int, color: tuple) -> None:
    halo = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(halo).ellipse([cx - r * 2.2, cy - r * 2.2, cx + r * 2.2, cy + r * 2.2], fill=color + (150,))
    img.alpha_composite(halo.filter(ImageFilter.GaussianBlur(r * 1.3)))
    ImageDraw.Draw(img).ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (255,))


# Плашка «ВРЕМЯ / GPS» в нижнем левом углу: OSD камер обычно сверху слева
def _plate(img: Image.Image, ts: int, gps: Optional[tuple[float, float]], s: float) -> None:
    d = ImageDraw.Draw(img)
    fk = _font(INTER_SB, round(11 * s))
    fv = _font(MONO_MD, round(16 * s))
    m, px, py, gap = round(12 * s), round(12 * s), round(9 * s), round(5 * s)
    ls = 0.08 * fk.size
    dot = round(3.2 * s)
    rows = [("ВРЕМЯ", wall(ts), None), ("GPS", f"{gps[0]:.5f}, {gps[1]:.5f}" if gps else "нет данных", OK if gps else FG3)]
    key_w = max(sum(d.textlength(ch, font=fk) for ch in k) + ls * (len(k) - 1) for k, _, _ in rows)
    col = key_w + round(14 * s)
    val_w = max(d.textlength(v, font=fv) for _, v, _ in rows) + dot * 2 + round(8 * s)
    row_h = fv.size + gap
    w = px * 2 + col + val_w
    h = py * 2 + row_h * len(rows) - gap
    top = img.height - m - h

    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle([m, top, m + w, top + h], radius=round(8 * s), fill=BG + (245,),
                                            outline=LINE_HI, width=max(1, round(s)))
    img.alpha_composite(layer)

    for i, (key, value, dot_color) in enumerate(rows):
        y = top + py + i * row_h
        d = ImageDraw.Draw(img)
        _spaced(d, m + px, y + (fv.size - fk.size) * 0.55, key, fk, FG3, ls)
        x = m + px + col
        if dot_color:
            _glow_dot(img, x + dot, y + fv.size * 0.62, dot, dot_color)
            d = ImageDraw.Draw(img)
            x += dot * 2 + round(8 * s)
        d.text((x, y), value, font=fv, fill=FG2 if dot_color == FG3 else FG)


# Кадр с рамками и плашкой; ts=None — без плашки
def render(src: Union[bytes, Path], boxes: list[Box], ts: Optional[int], gps: Optional[tuple[float, float]]) -> bytes:
    with Image.open(io.BytesIO(src) if isinstance(src, bytes) else src) as im:
        img = im.convert("RGBA")
    s = max(img.height, 480) / 720
    if boxes:
        _boxes(img, boxes, s)
    if ts is not None:
        _plate(img, ts, gps, s)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()
