// Словари протоколов мастера: число → название; смысл чисел знает только мастер

export interface DictEntry {
    number: number;
    name: string;
}

// Ключ словаря → строки; у Искры ещё cameras — бит маски → название камеры
export type Dictionaries = Record<string, DictEntry[]>;

export function dictName(dicts: Dictionaries, key: string, n: number): string | undefined {
    return dicts[key]?.find(e => e.number === n)?.name;
}

// Расшифровка значения поля записи по ключу словаря; маска камер приходит списком битов «1, 3»
export function fieldText(dicts: Dictionaries, key: string, value: string): string {
    const numbers = value.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
    return numbers.map(n => dictName(dicts, key, n) ?? '').filter(Boolean).join(', ');
}
