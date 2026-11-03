// Подразделы «Конфигураций»; id — сегмент маршрута /configurations/<id>
export const CONFIG_SECTIONS = [
    { id: 'overview', label: 'Обзор' },
    { id: 'passport', label: 'Паспорт машины' },
    { id: 'mapping', label: 'Словари и соответствия' },
] as const;

export type ConfigSectionId = (typeof CONFIG_SECTIONS)[number]['id'];

export const isConfigSection = (id: string): id is ConfigSectionId => CONFIG_SECTIONS.some(s => s.id === id);

export const configSectionLabel = (id: string): string =>
    CONFIG_SECTIONS.find(s => s.id === id)?.label ?? id;
