import React from 'react';

// Описание кадра: поля протокола, нарисованные во всю длину. Раскладка задана
// стороной заказчика и не редактируется, поэтому живёт в коде рядом со схемой.
//
// span — сколько байт занимает поле, многобайтовые поля рисуются одним блоком.
// parts — деление байта на битовые поля: минуты и знак лежат в одном байте.
export interface FieldPart {
  name: string;
  bits: string;
  tone: Tone;
}
export type Tone = 'f1' | 'f2' | 'f3' | 'f4' | 'off';
export interface Field {
  name: string;
  fmt?: string;
  span: number;
  tone: Tone;
  parts?: FieldPart[];
}
export interface MessageSpec {
  fields: Field[];
}

export const SPECS: Record<string, MessageSpec> = {
  rx_gps: {
    fields: [
      { name: 'Широта, градусы', fmt: 'Uint8 · 0–90', span: 1, tone: 'f1' },
      {
        name: 'Широта',
        span: 1,
        tone: 'f2',
        parts: [
          { name: 'Минуты', bits: 'биты 1–6', tone: 'f2' },
          { name: 'Знак N', bits: 'бит 7', tone: 'f3' },
          { name: 'Знак S', bits: 'бит 8', tone: 'f4' },
        ],
      },
      { name: 'Широта, секунды ×1000', fmt: 'Uint16 LE · 0–60000', span: 2, tone: 'f1' },
      { name: 'Долгота, градусы', fmt: 'Uint8 · 0–180', span: 1, tone: 'f1' },
      {
        name: 'Долгота',
        span: 1,
        tone: 'f2',
        parts: [
          { name: 'Минуты', bits: 'биты 1–6', tone: 'f2' },
          { name: 'Знак E', bits: 'бит 7', tone: 'f3' },
          { name: 'Знак W', bits: 'бит 8', tone: 'f4' },
        ],
      },
      { name: 'Долгота, секунды ×1000', fmt: 'Uint16 LE · 0–60000', span: 2, tone: 'f1' },
    ],
  },
  rx_time: {
    fields: [
      { name: 'Год', fmt: '25 = 2025', span: 1, tone: 'f1' },
      { name: 'Месяц', fmt: 'Uint8', span: 1, tone: 'f1' },
      { name: 'День', fmt: 'Uint8', span: 1, tone: 'f1' },
      { name: 'Час', fmt: 'UTC', span: 1, tone: 'f2' },
      { name: 'Минута', fmt: 'UTC', span: 1, tone: 'f2' },
      { name: 'Секунда', fmt: 'UTC', span: 1, tone: 'f2' },
      { name: 'Путевая скорость', fmt: 'Uint16 LE · 0,01 м/с', span: 2, tone: 'f4' },
    ],
  },
  tx_detections: {
    fields: [
      { name: 'Количество обнаружений', fmt: 'Uint8 · по всем камерам', span: 1, tone: 'f1' },
      { name: 'Тип обнаружения', fmt: 'Uint8 · 1–8', span: 1, tone: 'f2' },
      { name: 'Класс опасности', fmt: 'Uint8 · 1–4', span: 1, tone: 'f4' },
      { name: 'Камеры', fmt: 'бит на камеру', span: 1, tone: 'f3' },
      { name: 'Не используются', fmt: '0xFF', span: 4, tone: 'off' },
    ],
  },
};

interface Props {
  spec: MessageSpec;
  // Байты последнего кадра как «02 01 04 01 FF FF FF FF»; нет — только раскладка
  data?: string;
}

const CanMessageSpec: React.FC<Props> = ({ spec, data }) => {
  const bytes = data ? data.split(' ').filter(Boolean) : [];
  let byteAt = 0;
  return (
    <div className="wire">
      <div className="wire-r">
        {Array.from({ length: 8 }, (_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <div className="wire-g">
        {spec.fields.map((f, i) => {
          const first = byteAt;
          byteAt += f.span;
          const value = bytes.slice(first, first + f.span).join(' ');
          return (
            <div key={i} className={`wspan ${f.tone}`} style={{ gridColumn: `span ${f.span}` }}>
              <b>{f.name}</b>
              {f.parts ? (
                <div className="wparts">
                  {f.parts.map((p) => (
                    <div key={p.bits} className={`wpart ${p.tone}`}>
                      <b>{p.name}</b>
                      <span>{p.bits}</span>
                    </div>
                  ))}
                </div>
              ) : (
                f.fmt && <span className="t">{f.fmt}</span>
              )}
              {value && <span className="v">{value}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default CanMessageSpec;
