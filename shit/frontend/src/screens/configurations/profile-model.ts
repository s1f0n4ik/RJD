import type { IconName } from '../../app/Icons';
import { sameJson } from '../../utils/same-json';
import { effectiveDefinition, type CameraSource, type Definition, type NeuralSource, type Source, type Workspace } from './library-api';

export type SectionId = 'cameras' | 'neural' | 'surround' | 'master' | 'gateway' | 'display';

export const PROFILE_SECTIONS: { id: SectionId; name: string; icon: IconName }[] = [
    { id: 'cameras', name: 'Камеры', icon: 'cam' },
    { id: 'neural', name: 'Техническое зрение', icon: 'eye' },
    { id: 'surround', name: 'Система 360', icon: '360' },
    { id: 'master', name: 'Мастер обнаружений', icon: 'layers' },
    { id: 'gateway', name: 'АС КРСПС', icon: 'gate' },
    { id: 'display', name: 'Отображение и время', icon: 'grid' },
];

export const sectionName = (id: SectionId) => PROFILE_SECTIONS.find((section) => section.id === id)?.name ?? id;

export const readPath = (source: unknown, path: string): unknown =>
    path
        .split('.')
        .reduce<unknown>(
            (value, key) => (value && typeof value === 'object' ? (value as Source)[key] : undefined),
            source,
        );

// Значение, которое паспорт изменил относительно профиля; null — совпадает с профилем
export function passportWas(workspace: Workspace, kind: string, key: string, path: string): { was: unknown } | null {
    const entry = workspace.entities[kind]?.[key];
    const base = workspace.base[kind]?.[key];
    if (!entry || entry.state === 'profile' || !base) return null;
    const was = readPath(base, path);
    return sameJson(was, readPath(entry.body, path)) ? null : { was };
}

export const FIELD_LABELS: Record<string, string> = {
    ip_adress: 'IP-адрес',
    port: 'Порт RTSP',
    width: 'Ширина',
    height: 'Высота',
    fps: 'Частота, кадр/с',
    confidence: 'Порог уверенности',
    nms: 'Порог NMS',
    type: 'Тип трекера',
    tz_offset_min: 'Часовой пояс, мин',
    name: 'Название',
    series: 'Серия / модель',
    serial: 'Заводской номер',
    inventory: 'Инвентарный номер',
    location: 'Место эксплуатации',
    device_id: 'Устройство',
    depth: 'Глубина слота',
};

export const paramLabel = (path: string) => FIELD_LABELS[path.split('.').pop() ?? ''] || path;

export const printable = (value: unknown, path = ''): string =>
    /password|secret|token/i.test(path)
        ? '••••••'
        : value === undefined
          ? '—'
          : value === null
            ? 'Выключено'
            : typeof value === 'boolean'
              ? value
                  ? 'Вкл.'
                  : 'Выкл.'
              : typeof value === 'object'
                ? JSON.stringify(value)
                : String(value);

export interface PassportDifference {
    kind: string;
    key: string;
    name: string;
    conflict: boolean;
}

export const KIND_LABELS: Record<string, string> = {
    camera: 'Камера',
    video_stream: 'Видеопоток',
    neural_config: 'Нейроконфигурация',
    neural_slot: 'Слот',
    surround_output: 'Вывод 360',
    projection: 'Рендер 360',
    rules: 'Словари и соответствия мастера',
    integration: 'АС КРСПС',
    layout: 'Раскладка',
    machine: 'Машина',
    binding: 'Привязка устройства',
    calibration: 'Калибровка',
    correction_link: 'Связь калибровки',
    preset: 'Пресет 360',
    place: 'Место',
};

export function entityName(definition: Definition, kind: string, key: string): string {
    const body = definition[kind]?.[key];
    if (!body) return key;
    if (kind === 'camera') return (body as unknown as CameraSource).camera?.display_name || key;
    if (kind === 'neural_config') return (body as unknown as NeuralSource).name || key;
    return String(body.name || key);
}

// Отличия машины от профиля; привязки и карточка машины живут в паспорте отдельно
export function passportDifferences(workspace: Workspace): PassportDifference[] {
    const result: PassportDifference[] = [];
    const definition = effectiveDefinition(workspace);
    for (const [kind, items] of Object.entries(workspace.entities))
        for (const [key, entry] of Object.entries(items)) {
            if (entry.state === 'profile' || kind === 'binding' || (kind === 'machine' && key === 'identity')) continue;
            result.push({ kind, key, name: entityName(definition, kind, key), conflict: !!entry.profile_newer });
        }
    for (const removed of workspace.removed)
        result.push({
            kind: removed.kind,
            key: removed.key,
            name: entityName(workspace.base, removed.kind, removed.key),
            conflict: !!removed.profile_newer,
        });
    return result;
}

export interface BrokenItem {
    section: SectionId;
    target: string;
    title: string;
    id: string;
    field: string;
    miss: string;
    module?: { label: string; to: string };
}

const SECTION_OF: Record<string, SectionId> = {
    camera: 'cameras',
    video_stream: 'neural',
    neural_slot: 'neural',
    neural_config: 'neural',
    calibration: 'surround',
    correction_link: 'surround',
    preset: 'surround',
    projection: 'surround',
    surround_output: 'surround',
    rules: 'master',
    integration: 'gateway',
    machine: 'gateway',
    layout: 'display',
};

const MODULE_OF: Record<string, { label: string; to: string }> = {
    camera: { label: 'Камеры', to: '/cameras' },
    video_stream: { label: 'Техническое зрение', to: '/neural' },
    neural_slot: { label: 'Техническое зрение', to: '/neural' },
    neural_config: { label: 'Техническое зрение', to: '/neural' },
    calibration: { label: 'Система 360', to: '/surround' },
    correction_link: { label: 'Система 360', to: '/surround' },
    preset: { label: 'Система 360', to: '/surround' },
    projection: { label: 'Система 360', to: '/surround' },
    surround_output: { label: 'Система 360', to: '/surround' },
    layout: { label: 'Отображение', to: '/live' },
    integration: { label: 'АС КРСПС', to: '/krsps' },
    binding: { label: 'Паспорт машины', to: '/configurations/passport' },
};

function fieldLabel(field: string): string {
    if (field === 'tiles.camera') return 'Камера в плитке видеопотока';
    if (field === 'stream_id') return 'Видеопоток слота';
    if (field === 'config_id') return 'Нейроконфигурация слота';
    if (field === 'preset') return 'Пресет проекции';
    if (field === 'place' || field === 'key') return 'Место';
    if (field === 'table.cameras') return 'Камера в таблице соответствий';
    if (field.startsWith('table.')) return 'Нейроконфигурация в таблице соответствий';
    if (field.startsWith('activeCells')) return `Ячейка ${field.split('.')[1] ?? ''} раскладки`.trim();
    if (field.startsWith('zones')) return 'Зона видеопотока';
    if (field.includes('calibration')) return 'Калибровка камеры';
    if (field.includes('camera')) return 'Камера схемы';
    if (field === 'config') return 'Калибровка связи';
    if (field === 'active_integration') return 'Активная интеграция';
    return field;
}

export function describeBroken(broken: Workspace['broken'], definition: Definition): BrokenItem[] {
    return broken.map((item) => ({
        section: SECTION_OF[item.kind] ?? 'cameras',
        target: `tgt-${item.kind}-${item.key}`,
        title: `${KIND_LABELS[item.kind] ?? item.kind} «${entityName(definition, item.kind, item.key)}»`,
        id: item.key,
        field: fieldLabel(item.field),
        miss: item.ref,
        module: MODULE_OF[item.kind],
    }));
}

// Ссылки сущности на несуществующие данные: id для подсветки строки
export const targetId = (kind: string, key: string) => `tgt-${kind}-${key}`;
