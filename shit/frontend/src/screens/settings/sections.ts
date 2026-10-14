// Подразделы «Настроек системы»; id — сегмент маршрута /settings/<id>
export const SETTINGS_SECTIONS = [
    { id: 'storage', label: 'Хранилище' },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

export const isSettingsSection = (id: string): id is SettingsSectionId => SETTINGS_SECTIONS.some(s => s.id === id);

export const settingsSectionLabel = (id: string): string =>
    SETTINGS_SECTIONS.find(s => s.id === id)?.label ?? id;
