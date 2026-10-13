// Подразделы «Конфигураций»; id — сегмент маршрута /configurations/<id>
export const CONFIG_SECTIONS = [
    { id: 'link', label: 'Связь и правила' },
    { id: 'table', label: 'Таблица соответствий' },
    { id: 'dict', label: 'Словари' },
] as const;

export type ConfigSectionId = (typeof CONFIG_SECTIONS)[number]['id'];

export const isConfigSection = (id: string): id is ConfigSectionId => CONFIG_SECTIONS.some(s => s.id === id);

export const configSectionLabel = (id: string): string =>
    CONFIG_SECTIONS.find(s => s.id === id)?.label ?? id;
