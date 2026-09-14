// Подразделы «Технического зрения» в порядке настройки; id — сегмент маршрута /neural/<id>
export const NEURAL_SECTIONS = [
    { id: 'configs', label: 'Конфигурации' },
    { id: 'streams', label: 'Потоки' },
    { id: 'journal', label: 'Журнал обнаружений' },
] as const;

export type NeuralSectionId = (typeof NEURAL_SECTIONS)[number]['id'];

export const isNeuralSection = (id: string): id is NeuralSectionId => NEURAL_SECTIONS.some(s => s.id === id);

export const neuralSectionLabel = (id: string): string =>
    NEURAL_SECTIONS.find(s => s.id === id)?.label ?? id;
