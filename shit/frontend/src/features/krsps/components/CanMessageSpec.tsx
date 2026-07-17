import React from 'react';

// Описание кадра: поля протокола, нарисованные во всю длину. Раскладка задана
// стороной заказчика и не редактируется, поэтому живёт в коде рядом со схемой,
// а не в настройках — на странице её можно только читать.
//
// span — сколько байт занимает поле. Многобайтовые поля рисуются одним блоком:
// таблицей «байты 3–4» это только описывалось словами, а здесь видно.
// parts — деление байта на битовые поля: минуты и знак лежат в одном байте, и
// знак должен быть отдельным блоком с указанием бита.

export interface FieldPart {
  name: string;
  bits: string;   // «биты 1–6» / «бит 7»
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
  // Байты последнего кадра как «02 01 04 01 FF FF FF FF». Нет — рисуем только
  // раскладку, без значений.
  data?: string;
}

const CanMessageSpec: React.FC<Props> = ({ spec, data }) => {
  const bytes = data ? data.split(' ').filter(Boolean) : [];

  let byteAt = 0;
  return (
    <div className="krsps-wire">
      <div className="krsps-wire__ruler">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="krsps-wire__rn">
            {i + 1}
          </div>
        ))}
      </div>
      <div className="krsps-wire__grid">
        {spec.fields.map((f, i) => {
          const first = byteAt;
          byteAt += f.span;
          const value = bytes.slice(first, first + f.span).join(' ');

          return (
            <div
              key={i}
              className={`krsps-span krsps-span--${f.tone}`}
              style={{ gridColumn: `span ${f.span}` }}
            >
              <div className="krsps-span__n">{f.name}</div>
              {f.parts ? (
                // Байт делится на битовые поля: знак — отдельным блоком с
                // указанием бита, иначе непонятно, где он лежит.
                <div className="krsps-span__parts">
                  {f.parts.map((p) => (
                    <div key={p.bits} className={`krsps-part krsps-part--${p.tone}`}>
                      <span className="krsps-part__n">{p.name}</span>
                      <span className="krsps-part__b">{p.bits}</span>
                    </div>
                  ))}
                </div>
              ) : (
                f.fmt && <div className="krsps-span__t">{f.fmt}</div>
              )}
              {value && <div className="krsps-span__v">{value}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default CanMessageSpec;
