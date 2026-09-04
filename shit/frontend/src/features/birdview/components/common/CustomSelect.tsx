import { Select } from '../../../../app/Select';

/** Выпадающий список раздела 360: тонкая обёртка над общим Select оболочки */

export interface SelectOption {
    value: string;
    label: string;
    /** Вариант выбирается, но помечен как неподходящий — приглушённый */
    muted?: boolean;
    /** Правая подпись в строке: разрешение, признак и подобное */
    note?: string;
}

interface CustomSelectProps {
    options: SelectOption[];
    value: string | null;
    placeholder?: string;
    emptyText?: string;
    /** Вызывается при раскрытии списка — например, чтобы подгрузить варианты */
    onOpen?: () => void;
    disabled?: boolean;
    onChange: (value: string) => void;
}

export function CustomSelect({
    options,
    value,
    placeholder = '—',
    emptyText = 'Нет вариантов',
    onOpen,
    disabled,
    onChange,
}: CustomSelectProps) {
    return (
        <Select
            value={value ?? ''}
            options={options.map(o => ({ value: o.value, label: o.label, hint: o.note, muted: o.muted }))}
            onChange={onChange}
            placeholder={placeholder}
            emptyText={emptyText}
            onOpen={onOpen}
            disabled={disabled}
        />
    );
}
