import type { ModelDesc, ZoneDef } from '../../features/neural/api/types';

// Подписи описания модели и каталога зон для экранов техзрения

export const plural = (n: number, one: string, few: string, many: string) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
};

export const modelSize = (m: ModelDesc) => `${m.input_width}×${m.input_height}`;
export const modelQuant = (m: ModelDesc) => (m.quantized ? 'int8' : 'fp16');
export const modelTask = (m: ModelDesc) => (m.layout.endsWith('_SEG') ? 'сегментация' : 'детекция');
export const modelStem = (m: ModelDesc) => m.file.replace(/\.rknn$/i, '');
export const modelClasses = (n: number) => `${n} ${plural(n, 'класс', 'класса', 'классов')}`;
export const modelMb = (m: ModelDesc) => `${(m.weight_bytes / (1 << 20)).toFixed(1).replace('.', ',')} МБ`;

/** Описание относится к выбранному файлу модели */
export const modelOf = (m: ModelDesc | null | undefined, modelPath: string): ModelDesc | null =>
    m && m.file === (modelPath.split('/').pop() ?? '') ? m : null;

export const zoneCount = (n: number) => (n ? `${n} ${plural(n, 'зона', 'зоны', 'зон')}` : 'зон нет');

/** Место зоны в каталоге с 1; 0 — зоны нет в каталоге */
export const zoneRank = (zones: ZoneDef[], id: number) => zones.findIndex(z => z.id === id) + 1;
