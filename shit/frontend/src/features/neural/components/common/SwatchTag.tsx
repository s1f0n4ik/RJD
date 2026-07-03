interface SwatchTagProps {
  id?: string;
  name: string;
  color: string;
  onNameChange?: (name: string) => void;
  onColorChange: (color: string) => void;
}

/**
 * Тег класса/суперкласса с быстрым редактируемым цветом.
 * Нативный <input type="color"> лежит поверх квадратика — мгновенно и без либ.
 */
export function SwatchTag({ id, name, color, onNameChange, onColorChange }: SwatchTagProps) {
  return (
    <div className="swatch-tag" title={id ? `id: ${id}` : undefined}>
      <label className="swatch-color" style={{ background: color }}>
        <input
          type="color"
          value={normalizeHex(color)}
          onChange={(e) => onColorChange(e.target.value)}
        />
      </label>
      {onNameChange ? (
        <input
          className="swatch-name"
          value={name}
          size={Math.max(name.length, 4)}
          onChange={(e) => onNameChange(e.target.value)}
        />
      ) : (
        <span className="swatch-name">{name}</span>
      )}
      {id && <span className="swatch-id">{id}</span>}
    </div>
  );
}

/** input[type=color] требует строгий #rrggbb. */
function normalizeHex(c: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    return '#' + c.slice(1).split('').map((ch) => ch + ch).join('');
  }
  return '#888888';
}
