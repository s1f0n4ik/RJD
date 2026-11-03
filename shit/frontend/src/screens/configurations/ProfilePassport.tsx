import { useState } from 'react';
import { Modal } from '../../app/Modal';
import { Select } from '../../app/Select';
import type { Device } from '../../services/devices';
import { ProfileCard, ProfileTable } from './ProfileOverview';
import {
    effectiveDefinition,
    entries,
    entity,
    timezoneLabel,
    sameSource,
    type CameraSource,
    type Definition,
    type NeuralSource,
    type Place,
    type Source,
    type Workspace,
} from './library-api';

interface Field {
    path: string;
    label: string;
    type?: 'number' | 'port' | 'ip' | 'tracker';
    min?: number;
    max?: number;
    step?: number;
}
const FIELD_LABELS: Record<string, string> = {
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
const KIND_LABELS: Record<string, string> = {
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

const readPath = (source: unknown, path: string): unknown =>
    path
        .split('.')
        .reduce<unknown>(
            (value, key) => (value && typeof value === 'object' ? (value as Source)[key] : undefined),
            source,
        );
const printable = (value: unknown, path = ''): string =>
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

function leaves(value: unknown, prefix = ''): [string, unknown][] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [[prefix, value]];
    return Object.entries(value).flatMap(([key, child]) =>
        key === '_assets' ? [] : leaves(child, prefix ? `${prefix}.${key}` : key),
    );
}

function fieldsFor(kind: string, source: Source): Field[] {
    if (kind === 'camera')
        return [
            { path: 'camera.ip_adress', label: 'IP-адрес', type: 'ip' },
            { path: 'camera.port', label: 'Порт RTSP', type: 'port', min: 1, max: 65535 },
        ];
    if (kind === 'video_stream')
        return ['width', 'height'].map((path) => ({
            path,
            label: FIELD_LABELS[path],
            type: 'number',
            min: 1,
            max: 16384,
            step: 1,
        }));
    if (kind === 'neural_slot') return [{ path: 'fps', label: FIELD_LABELS.fps, type: 'number', min: 1, max: 240 }];
    if (kind === 'neural_config')
        return [
            { path: 'thresholds.confidence', label: 'Порог уверенности', type: 'number', min: 0, max: 1, step: 0.01 },
            { path: 'thresholds.nms', label: 'Порог NMS', type: 'number', min: 0, max: 1, step: 0.01 },
            { path: 'tracker.type', label: 'Трекер', type: 'tracker' },
        ];
    if (kind === 'surround_output')
        return Object.entries((source.configs as Record<string, Source>) ?? {}).flatMap(([key, config]) =>
            ['fps', 'width', 'height']
                .filter((field) => field in config)
                .map((field) => ({
                    path: `configs.${key}.${field}`,
                    label: `${key} / ${FIELD_LABELS[field]}`,
                    type: 'number',
                    min: 1,
                    max: field === 'fps' ? 240 : 16384,
                    step: 1,
                })),
        );
    if (kind === 'projection')
        return ['top', 'surround'].flatMap((mode) =>
            ['width', 'height']
                .filter((field) => readPath(source, `${mode}.resolution.${field}`) !== undefined)
                .map((field) => ({
                    path: `${mode}.resolution.${field}`,
                    label: `${mode === 'top' ? 'Вид сверху' : 'Объёмный вид'} / ${FIELD_LABELS[field]}`,
                    type: 'number',
                    min: 1,
                    max: 16384,
                    step: 1,
                })),
        );
    return [];
}

function EntityEditor({
    kind,
    entityKey,
    source,
    base,
    onClose,
    onSave,
}: {
    kind: string;
    entityKey: string;
    source: Source;
    base: Source;
    onClose: () => void;
    onSave: (body: Source) => void;
}) {
    const fields = fieldsFor(kind, source);
    const [values, setValues] = useState<Record<string, string>>(() =>
        Object.fromEntries(fields.map((field) => [field.path, String(readPath(source, field.path) ?? '')])),
    );
    const save = () => {
        const result = structuredClone(source);
        for (const field of fields) {
            if (values[field.path] === String(readPath(source, field.path) ?? '')) continue;
            const parts = field.path.split('.');
            let target = result;
            for (const part of parts.slice(0, -1)) {
                if (!target[part] || typeof target[part] !== 'object') target[part] = {};
                target = target[part] as Source;
            }
            if (field.type === 'tracker' && !values[field.path]) result.tracker = null;
            else
                target[parts[parts.length - 1]] =
                    field.type === 'number' ? Number(values[field.path]) : values[field.path].trim();
        }
        onSave(result);
        onClose();
    };
    return (
        <Modal
            title={`${KIND_LABELS[kind] || kind}: ${entityKey}`}
            onClose={onClose}
            footer={
                <>
                    <button className="btn" onClick={onClose}>
                        Отмена
                    </button>
                    <button className="btn btn--acc" type="submit" form="lb-entity-form">
                        Изменить паспорт
                    </button>
                </>
            }
        >
            <form
                id="lb-entity-form"
                className="modal-b lb-entity-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    save();
                }}
            >
                {fields.map((field) => (
                    <label className="lb-entity-field" key={field.path}>
                        <span>{field.label}</span>
                        <small>В профиле: {printable(readPath(base, field.path))}</small>
                        {field.type === 'tracker' ? (
                            <Select
                                value={values[field.path]}
                                options={[
                                    { value: '', label: 'Выключен' },
                                    { value: 'iou', label: 'IoU' },
                                    { value: 'kalman_iou', label: 'Kalman IoU' },
                                ]}
                                onChange={(value) => setValues((previous) => ({ ...previous, [field.path]: value }))}
                            />
                        ) : (
                            <input
                                className="inp inp--text inp--wide"
                                aria-label={field.label}
                                required
                                type={field.type === 'number' || field.type === 'port' ? 'number' : 'text'}
                                min={field.min}
                                max={field.max}
                                step={field.step ?? (field.type === 'number' ? 'any' : 1)}
                                pattern={
                                    field.type === 'ip'
                                        ? '(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)'
                                        : undefined
                                }
                                value={values[field.path]}
                                onChange={(event) =>
                                    setValues((previous) => ({ ...previous, [field.path]: event.target.value }))
                                }
                            />
                        )}
                    </label>
                ))}
            </form>
        </Modal>
    );
}

export function ProfilePassport({
    workspace,
    draft,
    devices,
    update,
    reset,
}: {
    workspace: Workspace;
    draft: Definition;
    devices: Device[];
    update: (kind: string, key: string, body: Source) => void;
    reset: (kind: string, key: string) => void;
}) {
    const [editing, setEditing] = useState<{ kind: string; key: string } | null>(null);
    const saved = effectiveDefinition(workspace);
    const identity = draft.machine?.identity ?? {};
    const settings = draft.machine?.settings ?? {};
    const offset = Number(settings.tz_offset_min ?? 180);
    const timezoneOptions = [...new Set([offset, ...Array.from({ length: 105 }, (_, index) => index * 15 - 720)])]
        .sort((a, b) => a - b)
        .map((value) => ({ value: String(value), label: timezoneLabel(value) }));
    const refs = new Set<string>();
    for (const [kind, items] of Object.entries(workspace.entities))
        for (const [key, entry] of Object.entries(items))
            if (entry.state !== 'profile' && kind !== 'binding') refs.add(`${kind}/${key}`);
    for (const removed of workspace.removed) refs.add(`${removed.kind}/${removed.key}`);
    for (const [kind, items] of Object.entries(draft))
        for (const [key, body] of Object.entries(items))
            if (kind !== 'binding' && !sameSource(body, saved[kind]?.[key])) refs.add(`${kind}/${key}`);
    const titleFor = (kind: string, key: string, body?: Source) =>
        kind === 'camera'
            ? (body as unknown as CameraSource)?.camera?.display_name || key
            : kind === 'neural_config'
              ? (body as unknown as NeuralSource)?.name || key
              : String(body?.name || key);
    const differenceGroups = [...refs].flatMap((ref) => {
        const [kind, ...parts] = ref.split('/'),
            key = parts.join('/');
        const base = workspace.base[kind]?.[key],
            body = draft[kind]?.[key];
        if (sameSource(base, body)) return [];
        const paths = new Set([...leaves(base).map(([path]) => path), ...leaves(body).map(([path]) => path)]);
        const changed = [...paths].filter((path) => !sameSource(readPath(base, path), readPath(body, path)));
        const entry = workspace.entities[kind]?.[key];
        const resetChangesIntegration =
            kind === 'machine' && key === 'settings' && base?.active_integration !== body?.active_integration;
        return [
            <section className="lb-diff-group" key={ref}>
                <div className="lb-diff-heading">
                    <span>{KIND_LABELS[kind] || kind}</span>
                    <b>{titleFor(kind, key, body || base)}</b>
                    <code>{key}</code>
                    {entry?.profile_newer && <span className="tag is-warn">Профиль обновлён</span>}
                    {entry?.state === 'machine_only' && <span className="tag is-warn">Только на машине</span>}
                    {body && fieldsFor(kind, body).length > 0 && (
                        <button className="btn btn--sm btn--ghost" onClick={() => setEditing({ kind, key })}>
                            Изменить
                        </button>
                    )}
                    <button
                        className="btn btn--sm"
                        disabled={resetChangesIntegration}
                        data-tip={resetChangesIntegration ? 'Интеграция меняется через загрузку профиля' : undefined}
                        onClick={() => reset(kind, key)}
                    >
                        Как в профиле
                    </button>
                </div>
                <ProfileTable className="lb-diff-table" headings={['Параметр', 'В профиле', 'На машине']}>
                    {changed.map((path) => (
                        <tr key={path}>
                            <td>{FIELD_LABELS[path.split('.').pop() ?? ''] || path}</td>
                            <td className="m lb-base-value">{printable(readPath(base, path), path)}</td>
                            <td className="m lb-machine-value">{printable(readPath(body, path), path)}</td>
                        </tr>
                    ))}
                </ProfileTable>
            </section>,
        ];
    });
    return (
        <>
            <div className="lb-passport-grid">
                <ProfileCard
                    title="Карточка машины"
                    icon="kit"
                    hint={`${workspace.profile.name} / v${workspace.version.number}`}
                >
                    <div className="lb-machine-fields">
                        {['name', 'series', 'serial', 'inventory', 'location'].map((key) => (
                            <label className="lb-passport-field" key={key}>
                                <span>{FIELD_LABELS[key]}</span>
                                <input
                                    className="inp inp--text inp--wide"
                                    maxLength={256}
                                    value={String(identity[key] ?? (key === 'name' ? workspace.profile.name : ''))}
                                    onChange={(event) =>
                                        update('machine', 'identity', { ...identity, [key]: event.target.value })
                                    }
                                />
                            </label>
                        ))}
                        <label className="lb-passport-field">
                            <span>Часовой пояс</span>
                            <Select
                                value={String(offset)}
                                options={timezoneOptions}
                                onChange={(value) =>
                                    update('machine', 'settings', { ...settings, tz_offset_min: Number(value) })
                                }
                            />
                        </label>
                    </div>
                </ProfileCard>
                <ProfileCard title="Привязки устройств" icon="dev" hint="Место → физическое устройство">
                    {entries<Place>(draft, 'place').map(([key, place]) => {
                        const binding = entity<{ device_id: string }>(draft, 'binding', key)?.device_id || '';
                        const device = devices.find((item) => item.id === binding);
                        return (
                            <div className="lb-binding" key={key}>
                                <span className="mt-name">
                                    <b>{place.name || key}</b>
                                    <small>{place.modules?.join(', ') || 'Модули не заданы'}</small>
                                </span>
                                <Select
                                    value={binding}
                                    placeholder="Не назначено"
                                    options={[
                                        { value: '', label: 'Не назначено' },
                                        ...devices.map((item) => ({
                                            value: item.id,
                                            label: item.name || item.id,
                                            hint: `${item.ip} / ${item.modules.join(', ')}`,
                                            dot: item.status === 'online' ? ('ok' as const) : undefined,
                                        })),
                                        ...(binding && !device
                                            ? [{ value: binding, label: binding, hint: 'Устройства нет в реестре' }]
                                            : []),
                                    ]}
                                    onChange={(value) =>
                                        update('binding', key, { ...(draft.binding?.[key] ?? {}), device_id: value })
                                    }
                                />
                                <span className="lb-device-ip">
                                    {device?.ip || (binding ? 'Нет в реестре' : 'Не назначено')}
                                </span>
                            </div>
                        );
                    })}
                    {!Object.keys(draft.place ?? {}).length && (
                        <div className="lb-empty">Логические места не заданы</div>
                    )}
                </ProfileCard>
            </div>
            <ProfileCard
                title="Отличия от профиля"
                icon="swap"
                hint={`Профиль v${workspace.version.number} → эта машина`}
            >
                {differenceGroups.length ? (
                    differenceGroups
                ) : (
                    <div className="lb-empty">Настройки совпадают с профилем</div>
                )}
            </ProfileCard>
            {editing && (
                <EntityEditor
                    key={`${editing.kind}/${editing.key}`}
                    kind={editing.kind}
                    entityKey={editing.key}
                    source={draft[editing.kind][editing.key]}
                    base={workspace.base[editing.kind]?.[editing.key] ?? {}}
                    onClose={() => setEditing(null)}
                    onSave={(body) => update(editing.kind, editing.key, body)}
                />
            )}
        </>
    );
}
