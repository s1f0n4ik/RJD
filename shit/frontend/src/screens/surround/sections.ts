import type { ScreenId } from '../../features/birdview/types';

// Подразделы «Системы 360» в порядке настройки; id — сегмент маршрута /surround/<id>
export const SURROUND_SECTIONS: ReadonlyArray<{ id: ScreenId; label: string }> = [
    { id: 'calibration', label: 'Калибровка' },
    { id: 'projection', label: 'Сборка' },
    { id: 'linker', label: 'Отображение' },
    { id: 'configurator', label: 'Конфигуратор' },
    { id: 'mapping', label: 'Сопоставление' },
];

export const isSurroundSection = (id: string): id is ScreenId => SURROUND_SECTIONS.some(s => s.id === id);

export const surroundSectionLabel = (id: string): string =>
    SURROUND_SECTIONS.find(s => s.id === id)?.label ?? id;
