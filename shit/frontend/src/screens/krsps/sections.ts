// Разделы модуля АС КРСПС: подписи модулей шлюза и служебных страниц
export const MODULE_LABEL: Record<string, string> = {
    websocket: 'Шлюз ЦПУ',
    can: 'Шина CAN',
};

export const SERVICE_SECTIONS = [
    { id: 'taxonomy', label: 'Таблица соответствий', icon: 'tune' },
    { id: 'time', label: 'Время и GPS', icon: 'clock' },
] as const;

export const isServiceSection = (id: string) => SERVICE_SECTIONS.some(s => s.id === id);

export function sectionLabel(id: string, fallback = ''): string {
    return MODULE_LABEL[id] ?? SERVICE_SECTIONS.find(s => s.id === id)?.label ?? fallback ?? id;
}
