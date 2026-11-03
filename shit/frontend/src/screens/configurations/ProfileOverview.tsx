import { Fragment, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../../app/Icons';
import { buildGeometry, type Rect } from '../../features/birdview/components/linker/plan-geometry';
import type { LinkerExportDetail } from '../../features/birdview/api/linker';
import { layoutFromSaved, presetOf } from '../live/model';
import { PURPOSE_NAMES, PURPOSE_ORDER } from '../cameras/model';
import {
    entries,
    entity,
    profileRules,
    timezoneLabel,
    type CameraSource,
    type Definition,
    type NeuralSource,
    type OutputSource,
    type Place,
    type ProfileLayout,
    type ProjectionSource,
    type SlotSource,
    type StreamSource,
    type Workspace,
} from './library-api';

export function ProfileCard({
    id,
    title,
    icon,
    hint,
    children,
}: {
    id?: string;
    title: string;
    icon: IconName;
    hint?: string;
    children: ReactNode;
}) {
    return (
        <section id={id} className="card lb-card">
            <div className="card-h">
                <Icon name={icon} size={16} />
                <h3>{title}</h3>
                {hint && <span className="eyebrow">{hint}</span>}
            </div>
            <div className="card-b">{children}</div>
        </section>
    );
}

export function ProfileTable({
    headings,
    children,
    className = '',
}: {
    headings: (string | [IconName, string])[];
    children: ReactNode;
    className?: string;
}) {
    return (
        <div className="lb-table-wrap">
            <table className={`spec lb-spec ${className}`}>
                <thead>
                    <tr>
                        {headings.map((heading, index) => (
                            <th key={index}>
                                {Array.isArray(heading) ? (
                                    <span className="lb-th">
                                        <Icon name={heading[0]} size={12} />
                                        {heading[1]}
                                    </span>
                                ) : (
                                    heading
                                )}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    );
}

const nameOf = (definition: Definition, id: string) =>
    entity<CameraSource>(definition, 'camera', id)?.camera.display_name || id;
const placeName = (definition: Definition, id: string) => entity<Place>(definition, 'place', id)?.name || id || '—';
const dimensions = (width?: number, height?: number) => (width && height ? `${width} × ${height}` : 'Не задан');
const valueOf = (value: unknown): string =>
    value === undefined || value === null || value === ''
        ? '—'
        : typeof value === 'boolean'
          ? value
              ? 'Вкл.'
              : 'Выкл.'
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);

function Values({ values }: { values: [string, unknown][] }) {
    return (
        <dl className="lb-kvs">
            {values.map(([label, value]) => (
                <div className="kv" key={label}>
                    <dt className="k">{label}</dt>
                    <dd className="v">{valueOf(value)}</dd>
                </div>
            ))}
        </dl>
    );
}

function Cameras({ definition }: { definition: Definition }) {
    const [open, setOpen] = useState<Set<string>>(new Set());
    const toggle = (id: string) =>
        setOpen((previous) => {
            const next = new Set(previous);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    const cameras = entries<CameraSource>(definition, 'camera');
    return (
        <ProfileCard id="lb-cameras" title="Камеры" icon="cam" hint="Настройки профиля">
            <ProfileTable
                className="lb-camera-table"
                headings={[['cam', 'Камера'], 'IP-адрес', 'Место', 'Подключённые модули', '']}
            >
                {cameras.map(([id, source]) => (
                    <Fragment key={id}>
                        <tr className="lb-camera-row" onClick={() => toggle(id)}>
                            <td>
                                <b>{source.camera.display_name || id}</b>
                                <small>{id}</small>
                            </td>
                            <td className="m">
                                {source.camera.ip_adress}
                                <small>RTSP :{source.camera.port}</small>
                            </td>
                            <td>{placeName(definition, source.place)}</td>
                            <td>
                                <div className="lb-purposes">
                                    {PURPOSE_ORDER.filter((purpose) =>
                                        Object.values(source.streams ?? {}).some((stream) =>
                                            stream.purposes?.includes(purpose),
                                        ),
                                    ).map((purpose) => (
                                        <span key={purpose} className={`purp purp--${purpose}`}>
                                            {PURPOSE_NAMES[purpose]}
                                        </span>
                                    ))}
                                </div>
                            </td>
                            <td>
                                <button
                                    className="lb-icon-btn"
                                    aria-label={`Параметры камеры ${source.camera.display_name || id}`}
                                    aria-expanded={open.has(id)}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        toggle(id);
                                    }}
                                >
                                    <Icon name="chev" size={12} />
                                </button>
                            </td>
                        </tr>
                        {open.has(id) && (
                            <tr className="lb-camera-detail">
                                <td colSpan={5}>
                                    <Values
                                        values={[
                                            ['Описание', source.camera.description],
                                            ['Пользователь', source.camera.user],
                                            ['Логическое место', source.place],
                                        ]}
                                    />
                                    <ProfileTable
                                        headings={[
                                            'Поток',
                                            'Вход / качество',
                                            'Транспорт',
                                            'Задержка',
                                            'Переподключение',
                                            'Запись',
                                        ]}
                                    >
                                        {Object.entries(source.streams ?? {}).map(([key, stream]) => (
                                            <tr key={key}>
                                                <td>{key}</td>
                                                <td>
                                                    {stream.channel} / {stream.substream}
                                                </td>
                                                <td>{stream.use_udp ? 'UDP' : 'TCP'}</td>
                                                <td>{stream.latency ?? 0} мс</td>
                                                <td>{stream.reconnect ?? '—'} с</td>
                                                <td>
                                                    {stream.purposes?.includes('record')
                                                        ? `${stream.record_path} / ${stream.segment} с`
                                                        : 'Выкл.'}
                                                </td>
                                            </tr>
                                        ))}
                                    </ProfileTable>
                                </td>
                            </tr>
                        )}
                    </Fragment>
                ))}
                {!cameras.length && (
                    <tr>
                        <td colSpan={5}>Камеры не включены в профиль</td>
                    </tr>
                )}
            </ProfileTable>
        </ProfileCard>
    );
}

function Neural({ definition, workspace }: { definition: Definition; workspace: Workspace }) {
    const configs = entries<NeuralSource>(definition, 'neural_config');
    const slots = entries<SlotSource>(definition, 'neural_slot');
    return (
        <ProfileCard id="lb-neural" title="Техническое зрение" icon="eye" hint="Конфигурации, видеопотоки, зоны">
            <h4 className="lb-block-title">Конфигурации нейросетей</h4>
            {configs.map(([id, config]) => {
                const info = workspace.assets[config._assets?.[config.model_file] ?? '']?.info;
                return (
                    <section className="lb-neural-config" key={id}>
                        <div className="lb-block-title">
                            <b>{config.name || id}</b>
                            <code>{id}</code>
                        </div>
                        <Values
                            values={[
                                ['Модель', config.model_file],
                                ['Вход модели', dimensions(info?.input_width, info?.input_height)],
                                ['Порог уверенности', config.thresholds?.confidence ?? 'По умолчанию'],
                                ['NMS', config.thresholds?.nms ?? 'По умолчанию'],
                                ['Трекер', config.tracker?.type || 'Выключен'],
                                [
                                    'Параметры трекера',
                                    config.tracker
                                        ? Object.entries(config.tracker)
                                              .filter(([key]) => key !== 'type')
                                              .map(([key, value]) => `${key}: ${value}`)
                                              .join(', ')
                                        : '—',
                                ],
                            ]}
                        />
                        <div className="lb-zone-list">
                            {(config.zones ?? []).map((zone) => (
                                <span className="tag" key={zone.id}>
                                    <Icon name="zone" size={12} />
                                    {zone.id}: {zone.name}
                                    <small>порог {zone.threshold}</small>
                                </span>
                            ))}
                            {!config.zones?.length && <span className="lb-muted">Зоны не заданы</span>}
                        </div>
                    </section>
                );
            })}
            {!configs.length && <div className="lb-empty">Конфигураций нейросетей нет</div>}
            <h4 className="lb-block-title">Видеопотоки и слоты</h4>
            <ProfileTable
                headings={[
                    ['grid', 'Видеопоток'],
                    ['box', 'Вход / FPS'],
                    'Конфигурация / слот',
                    ['cam', 'Камеры и зоны'],
                ]}
            >
                {entries<StreamSource>(definition, 'video_stream').map(([id, stream]) => {
                    const own = slots.filter(([, slot]) => slot.stream_id === id);
                    return (
                        <tr key={id}>
                            <td>
                                <b>{stream.name || id}</b>
                                <small>
                                    {id} / {placeName(definition, stream.place)}
                                </small>
                            </td>
                            <td className="m">
                                {dimensions(stream.width, stream.height)}
                                <small>{own.map(([, slot]) => `${slot.fps} кадр/с`).join(' / ') || 'Нет слотов'}</small>
                            </td>
                            <td>
                                {own.map(([key, slot]) => (
                                    <div className="lb-slot-line" key={key}>
                                        <span>
                                            {entity<NeuralSource>(definition, 'neural_config', slot.config_id)?.name ||
                                                slot.config_id}
                                        </span>
                                        <span className="lb-slot-badge">слот {key}</span>
                                        <small>
                                            Глубина {slot.depth}
                                            {slot.streaming?.enabled ? ` / Вывод ${slot.streaming.name}` : ''}
                                        </small>
                                    </div>
                                ))}
                            </td>
                            <td>
                                {(stream.tiles ?? []).map((tile, index) => (
                                    <div key={index}>
                                        <b>{nameOf(definition, tile.camera)}</b>
                                        <small>
                                            {Object.entries(stream.zones ?? {})
                                                .flatMap(([config, cameras]) =>
                                                    (cameras[tile.camera] ?? []).map((polygon) => {
                                                        const zone = entity<NeuralSource>(
                                                            definition,
                                                            'neural_config',
                                                            config,
                                                        )?.zones?.find((item) => item.id === polygon.zone);
                                                        return `◇ ${zone?.name || polygon.zone}`;
                                                    }),
                                                )
                                                .join(', ') || 'Без зон'}
                                        </small>
                                    </div>
                                ))}
                            </td>
                        </tr>
                    );
                })}
            </ProfileTable>
        </ProfileCard>
    );
}

function rect(value?: number[]): Rect | null {
    return value?.length === 4 && value.every(Number.isFinite) && value[2] > 0 && value[3] > 0
        ? { x: value[0], y: value[1], w: value[2], h: value[3] }
        : null;
}

function Projection({ id, source, definition }: { id: string; source: ProjectionSource; definition: Definition }) {
    const [selected, setSelected] = useState('');
    const output = entity<OutputSource>(definition, 'surround_output', source.place);
    const config = output?.configs?.[id];
    const detail: LinkerExportDetail = {
        id,
        name: source.name || id,
        canvas: { width: source.width, height: source.height },
        rotation: source.rotation === 90 || source.rotation === 180 || source.rotation === 270 ? source.rotation : 0,
        places: Object.entries(source.cameras ?? {}).map(([key, camera]) => ({
            key,
            name: camera.name || key,
            rect: rect(camera.region),
            cameraId: config?.cameras?.[key] || camera.camera_id || null,
        })),
        images: (source.images ?? []).flatMap((image) => {
            const box = rect(image.rect);
            return box ? [{ name: image.name, rect: box }] : [];
        }),
        machineRect: rect(source.machine?.rect),
    };
    const geometry = buildGeometry(detail);
    const fontSize = geometry ? Math.max(geometry.view.width, geometry.view.height) * 0.025 : 12;
    return (
        <section className="lb-projection">
            <div className="lb-block-title">
                <b>{source.name || id}</b>
                <code>{id}</code>
                <span>{output?.active === id ? 'Выбран для вывода' : 'Сохранённая схема'}</span>
            </div>
            <div className="lb-surround-grid">
                <div className="lb-plan-wrap">
                    {geometry?.tiles.length ? (
                        <svg
                            className="lb-plan"
                            viewBox={`0 0 ${geometry.view.width} ${geometry.view.height}`}
                            role="group"
                            aria-label={`Схема камер ${source.name || id}`}
                        >
                            {geometry.tiles.map((tile, index) => (
                                <g
                                    key={tile.key}
                                    className={`lb-plan-area${selected === tile.key ? ' is-selected' : ''}`}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`Позиция ${index + 1}: ${tile.name}`}
                                    aria-pressed={selected === tile.key}
                                    onClick={() => setSelected(tile.key)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault();
                                            setSelected(tile.key);
                                        }
                                    }}
                                >
                                    <polygon points={tile.poly.map((point) => `${point.x},${point.y}`).join(' ')} />
                                    <text x={tile.center.x} y={tile.center.y} textAnchor="middle" fontSize={fontSize}>
                                        {index + 1}
                                    </text>
                                </g>
                            ))}
                            {geometry.machine && (
                                <rect
                                    className="lb-plan-machine"
                                    x={geometry.machine.x}
                                    y={geometry.machine.y}
                                    width={geometry.machine.w}
                                    height={geometry.machine.h}
                                    rx={fontSize * 0.25}
                                />
                            )}
                            {geometry.overlays.map((overlay, index) => (
                                <rect
                                    className="lb-plan-overlay"
                                    key={index}
                                    x={overlay.rect.x}
                                    y={overlay.rect.y}
                                    width={overlay.rect.w}
                                    height={overlay.rect.h}
                                >
                                    <title>{overlay.name}</title>
                                </rect>
                            ))}
                            {geometry.icons.map((icon) => (
                                <g
                                    key={icon.key}
                                    transform={`translate(${icon.x} ${icon.y}) rotate(${icon.angleDeg}) scale(${fontSize / 18})`}
                                    className="lb-plan-camera"
                                >
                                    <path d="M-8-6H5V6H-8ZM5-3 12-7V7L5 3Z" />
                                </g>
                            ))}
                        </svg>
                    ) : (
                        <div className="lb-empty">Геометрия схемы не сохранена</div>
                    )}
                    {!!geometry?.missing.length && (
                        <span className="lb-muted">Без области: {geometry.missing.join(', ')}</span>
                    )}
                </div>
                <ProfileTable headings={['Позиция / камера', 'Калибровка']}>
                    {detail.places.map((place, index) => {
                        const link = place.cameraId ? definition.correction_link?.[place.cameraId] : undefined;
                        return (
                            <tr key={place.key} className={selected === place.key ? 'is-selected' : ''}>
                                <td>
                                    <button
                                        className="lb-plan-row"
                                        onClick={() => setSelected(place.key)}
                                        aria-pressed={selected === place.key}
                                    >
                                        <span className="lb-position">{index + 1}</span>
                                        <span>
                                            <b>{place.name}</b>
                                            <small>
                                                {place.cameraId ? nameOf(definition, place.cameraId) : 'Не назначена'}
                                            </small>
                                        </span>
                                    </button>
                                </td>
                                <td>
                                    {valueOf(link?.config)}
                                    <small>{place.cameraId || '—'}</small>
                                </td>
                            </tr>
                        );
                    })}
                </ProfileTable>
            </div>
            <div className="lb-render-list">
                {(['top', 'surround'] as const)
                    .filter((mode) => mode === 'top' || config?.dual_output || source.surround)
                    .map((mode) => (
                        <div key={mode}>
                            <Icon name={mode === 'top' ? 'grid' : '360'} size={20} />
                            <span>
                                <b>{mode === 'top' ? 'Вид сверху' : 'Объёмный вид'}</b>
                                <small>
                                    {dimensions(
                                        source[mode]?.resolution?.width || config?.width,
                                        source[mode]?.resolution?.height || config?.height,
                                    )}{' '}
                                    / {config?.fps ?? '—'} кадр/с
                                </small>
                                <small>{config?.stream_name || config?.stream_id || 'Вывод не настроен'}</small>
                            </span>
                        </div>
                    ))}
            </div>
            <Values
                values={[
                    ['Исходный пресет', source.preset],
                    ['Место', placeName(definition, source.place)],
                    ['Модель 360', source.surround?.model?.source],
                    ['Поворот', config?.rotation ?? source.rotation ?? 0],
                ]}
            />
        </section>
    );
}

function Surround({ definition }: { definition: Definition }) {
    const projections = entries<ProjectionSource>(definition, 'projection');
    if (
        !projections.length &&
        !Object.keys(definition.calibration ?? {}).length &&
        !Object.keys(definition.preset ?? {}).length
    )
        return null;
    return (
        <ProfileCard id="lb-surround" title="Система 360" icon="360" hint="Схемы, калибровки, выводы">
            {projections.map(([id, source]) => (
                <Projection key={id} id={id} source={source} definition={definition} />
            ))}
            {!projections.length && <div className="lb-empty">Схемы вывода не сохранены</div>}
            <ProfileTable headings={[['cal', 'Калибровка'], 'Размер', 'Камеры']}>
                {entries<SourceCalibration>(definition, 'calibration').map(([id, source]) => (
                    <tr key={id}>
                        <td>
                            <b>{id}</b>
                            <small>{placeName(definition, source.place)}</small>
                        </td>
                        <td>{dimensions(source.width, source.height)}</td>
                        <td>
                            {entries<{ config: string }>(definition, 'correction_link')
                                .filter(([, link]) => link.config === id)
                                .map(([camera]) => nameOf(definition, camera))
                                .join(', ') || 'Не назначена'}
                        </td>
                    </tr>
                ))}
            </ProfileTable>
            {!!Object.keys(definition.preset ?? {}).length && (
                <Values values={[['Пресеты', Object.keys(definition.preset).join(', ')]]} />
            )}
        </ProfileCard>
    );
}
interface SourceCalibration {
    place: string;
    width?: number;
    height?: number;
}

function Master({ definition, workspace }: { definition: Definition; workspace: Workspace }) {
    const { id: integration, settings: rules } = profileRules(workspace, definition);
    const values: [string, unknown][] = [];
    if (rules?.stitch)
        values.push(['Пауза объединения, с', rules.stitch.gap_s], ['Смещение трека', rules.stitch.distance]);
    for (const id of ['websocket', 'can'] as const) {
        const filter = rules?.[id];
        if (!filter) continue;
        const name = id === 'can' ? 'CAN' : 'WebSocket';
        values.push(
            [`${name}: передача`, filter.enabled],
            [`${name}: классы`, filter.classes_all ? 'Все классы' : filter.classes.join(', ') || 'Не выбраны'],
        );
    }
    if (rules?.websocket) values.push(['WebSocket: срок передачи, с', rules.websocket.late_s]);
    if (rules?.modbus)
        values.push(['Modbus: запись', rules.modbus.enabled], ['Modbus: срок записи, с', rules.modbus.ceiling_s]);
    return (
        <ProfileCard id="lb-master" title="Мастер обнаружений" icon="eye" hint={integration || 'Интеграция не задана'}>
            <Values values={values} />
            {!rules && <span className="lb-muted">Настройки правил не сохранены, мастер обнаружений недоступен</span>}
        </ProfileCard>
    );
}

function Gateway({ definition }: { definition: Definition }) {
    const integration = String(definition.machine?.settings?.active_integration ?? '');
    const modules = entity<{ modules: Record<string, Record<string, unknown>> }>(
        definition,
        'integration',
        integration,
    )?.modules;
    if (!modules) return null;
    return (
        <ProfileCard id="lb-gateway" title="АС КРСПС" icon="gate" hint={integration}>
            {Object.entries(modules).map(([id, source]) => (
                <section key={id}>
                    <h4 className="lb-block-title">
                        <Icon name={id === 'websocket' ? 'link' : 'bus'} size={15} />
                        {id === 'websocket' ? 'WebSocket' : id === 'can' ? 'CAN' : id === 'modbus' ? 'Modbus' : id}
                    </h4>
                    <Values
                        values={Object.entries(source)
                            .filter(([key]) => !/password|token|secret/i.test(key))
                            .map(([key, value]) => [
                                (
                                    {
                                        enabled: 'Включён',
                                        host: 'Адрес',
                                        port: 'Порт',
                                        target: 'Путь',
                                        iface: 'Интерфейс',
                                        device: 'Устройство',
                                        bitrate: 'Скорость CAN',
                                        baud: 'Скорость RS-485',
                                        parity: 'Чётность',
                                        slave: 'Адрес ведомого',
                                    } as Record<string, string>
                                )[key] || key,
                                value,
                            ])}
                    />
                </section>
            ))}
        </ProfileCard>
    );
}

function Display({ definition, timeSource }: { definition: Definition; timeSource?: string }) {
    const surroundSources = new Set<string>();
    const cameras = Object.fromEntries(
        entries<CameraSource>(definition, 'camera').map(([id, source]) => [id, source.camera.display_name || id]),
    );
    for (const [, output] of entries<OutputSource>(definition, 'surround_output'))
        for (const [id, config] of Object.entries(output.configs ?? {}))
            if (config.stream_id) {
                cameras[config.stream_id] = config.stream_name || id;
                surroundSources.add(config.stream_id);
            }
    return (
        <ProfileCard id="lb-display" title="Отображение и время" icon="grid" hint="Раскладки рабочего места">
            <div className="lb-layouts">
                {entries<ProfileLayout>(definition, 'layout').map(([id, saved]) => {
                    const layout = layoutFromSaved(saved);
                    return (
                        <section className="lb-layout-item" key={id}>
                            <div className="lb-layout-heading">
                                <h4>{saved.name || id}</h4>
                                <span className="tag">
                                    {presetOf(layout.grid) || `${layout.grid.cols} × ${layout.grid.rows}`}
                                </span>
                            </div>
                            <div
                                className="lb-layout-preview"
                                role="img"
                                aria-label={`Раскладка ${saved.name || id}`}
                                style={{
                                    gridTemplateColumns: `repeat(${layout.grid.cols}, 1fr)`,
                                    gridTemplateRows: `repeat(${layout.grid.rows}, 1fr)`,
                                }}
                            >
                                {layout.grid.cells.map((cell, index) => (
                                    <div
                                        key={cell.id}
                                        className={surroundSources.has(layout.cells[cell.id]) ? 'is-surround' : ''}
                                        style={{
                                            gridArea: `${cell.row + 1} / ${cell.col + 1} / span ${cell.rowSpan} / span ${cell.colSpan}`,
                                        }}
                                    >
                                        <span>{index + 1}</span>
                                        <Icon
                                            name={surroundSources.has(layout.cells[cell.id]) ? '360' : 'cam'}
                                            size={18}
                                        />
                                    </div>
                                ))}
                            </div>
                            <ol className="lb-layout-sources">
                                {layout.grid.cells.map((cell, index) => (
                                    <li
                                        key={cell.id}
                                        className={surroundSources.has(layout.cells[cell.id]) ? 'is-surround' : ''}
                                    >
                                        <span>{index + 1}</span>
                                        <b>
                                            {cameras[layout.cells[cell.id]] || layout.cells[cell.id] || 'Не назначено'}
                                        </b>
                                    </li>
                                ))}
                            </ol>
                        </section>
                    );
                })}
                {!Object.keys(definition.layout ?? {}).length && <div className="lb-empty">Раскладки не сохранены</div>}
            </div>
            <div className="lb-time-summary">
                <section>
                    <Icon name="clock" size={20} />
                    <div>
                        <span>Часовой пояс профиля</span>
                        <b>{timezoneLabel(Number(definition.machine?.settings?.tz_offset_min ?? 180))}</b>
                    </div>
                </section>
                <section>
                    <Icon name="dev" size={20} />
                    <div>
                        <span>Источник времени</span>
                        <b>{timeSource || 'Определяется при запуске'}</b>
                    </div>
                </section>
            </div>
        </ProfileCard>
    );
}

export function ProfileOverview({
    workspace,
    definition,
    timeSource,
}: {
    workspace: Workspace;
    definition: Definition;
    timeSource?: string;
}) {
    return (
        <>
            <Cameras definition={definition} />
            <Neural definition={definition} workspace={workspace} />
            <Surround definition={definition} />
            <Master definition={definition} workspace={workspace} />
            <Gateway definition={definition} />
            <Display definition={definition} timeSource={timeSource} />
        </>
    );
}
