// Разделы модуля АС КРСПС: подписи модулей шлюза и служебных страниц
export const MODULE_LABEL: Record<string, string> = {
    websocket: 'Шлюз ЦПУ',
    can: 'Шина CAN',
    modbus: 'Modbus RTU',
};

export const SERVICE_SECTIONS = [
    { id: 'time', label: 'Время и GPS', icon: 'clock' },
] as const;

export function sectionLabel(id: string, fallback = ''): string {
    return MODULE_LABEL[id] ?? SERVICE_SECTIONS.find(s => s.id === id)?.label ?? fallback ?? id;
}
