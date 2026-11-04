import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../app/Icons';
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
import {
    PROFILE_SECTIONS,
    passportWas,
    printable,
    targetId,
    type BrokenItem,
    type SectionId,
} from './profile-model';
import { scrollInside } from './scroll';

const num = (value: unknown) => String(value).replace('.', ',');
const errorWord = (count: number) =>
    count % 10 === 1 && count % 100 !== 11 ? 'ошибка' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20) ? 'ошибки' : 'ошибок';
const dimensions = (width?: number, height?: number) => (width && height ? `${width} × ${height}` : 'Не задан');
const placeName = (definition: Definition, id: string) => entity<Place>(definition, 'place', id)?.name || id || '—';
const cameraName = (definition: Definition, id: string) =>
    entity<CameraSource>(definition, 'camera', id)?.camera.display_name || id;

interface Shared {
    workspace: Workspace;
    definition: Definition;
    errors: BrokenItem[];
    // Открыть шторку ошибок на выбранной записи
    onError: (index: number) => void;
}

// Индекс записи об ошибке для сущности (и ссылки на неё, если указана)
function errorIndex(errors: BrokenItem[], kind: string, key: string, ref?: string): number {
    return errors.findIndex((item) => item.target === targetId(kind, key) && (!ref || item.miss === ref));
}

function ErrorChip({ shared, kind, id, refTo, children }: { shared: Shared; kind: string; id: string; refTo?: string; children: ReactNode }) {
    const index = errorIndex(shared.errors, kind, id, refTo);
    if (index < 0) return null;
    return (
        <button className="lb-errchip" onClick={() => shared.onError(index)}>
            <Icon name="warn" size={13} />
            <span>{children}</span>
        </button>
    );
}

// Значение, изменённое паспортом: оранжевое, с точкой и подсказкой «В профиле»
function Val({ shared, kind, id, path, mono, children }: { shared: Shared; kind: string; id: string; path: string; mono?: boolean; children: ReactNode }) {
    const diff = passportWas(shared.workspace, kind, id, path);
    const cls = `lb-val${mono ? ' num' : ''}`;
    return diff ? (
        <span className={`${cls} lb-pass`} data-tip={`Изменено паспортом. В профиле: ${printable(diff.was, path)}`}>
            {children}
            <i className="lb-pdot" />
        </span>
    ) : (
        <span className={cls}>{children}</span>
    );
}

function Newer({ shared, kind, id }: { shared: Shared; kind: string; id: string }) {
    return shared.workspace.entities[kind]?.[id]?.profile_newer ? (
        <span className="tag is-warn" data-tip="Профиль обновлён после правки паспорта. Решение — на вкладке «Паспорт машины»">
            Профиль обновлён
        </span>
    ) : null;
}

function Section({
    id,
    shared,
    count,
    hint,
    children,
}: {
    id: SectionId;
    shared: Shared;
    count: number;
    hint: string;
    children: ReactNode;
}) {
    const meta = PROFILE_SECTIONS.find((section) => section.id === id)!;
    const own = shared.errors.map((item, index) => ({ item, index })).filter(({ item }) => item.section === id);
    return (
        <section id={`lb-${id}`} className="card lb-card">
            <div className="card-h">
                <Icon name={meta.icon} size={18} />
                <h3>{meta.name}</h3>
                <span className="lb-n">{count}</span>
                <span className="lb-hint-r">
                    {!!own.length && (
                        <button className="lb-errchip" onClick={() => shared.onError(own[0].index)}>
                            <Icon name="warn" size={13} />
                            <span>
                                {own.length} {errorWord(own.length)} ссылок
                            </span>
                        </button>
                    )}
                    {hint}
                </span>
            </div>
            {children}
        </section>
    );
}

function Sub({ title, hint }: { title: string; hint?: string }) {
    return (
        <div className="lb-sub">
            {title}
            {hint && <span className="lb-hint-r">{hint}</span>}
        </div>
    );
}

function Values({ values }: { values: [string, ReactNode][] }) {
    return (
        <dl className="lb-kvs">
            {values.map(([label, value]) => (
                <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value === undefined || value === null || value === '' ? '—' : value}</dd>
                </div>
            ))}
        </dl>
    );
}

const flag = (value: unknown) => (value === true ? 'Вкл.' : value === false ? 'Выкл.' : value);

function Purposes({ purposes }: { purposes: string[] }) {
    return (
        <span className="lb-purps">
            {PURPOSE_ORDER.filter((purpose) => purposes.includes(purpose)).map((purpose) => (
                <span key={purpose} className={`purp purp--${purpose}`}>
                    {PURPOSE_NAMES[purpose]}
                </span>
            ))}
        </span>
    );
}

function Cameras(shared: Shared) {
    const { definition } = shared;
    const [open, setOpen] = useState<Set<string>>(new Set());
    const toggle = (id: string) =>
        setOpen((previous) => {
            const next = new Set(previous);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    const cameras = entries<CameraSource>(definition, 'camera');
    return (
        <Section id="cameras" shared={shared} count={cameras.length} hint="Нажмите на строку, чтобы увидеть потоки · оранжевым выделено изменённое паспортом">
            <div className="lb-row lb-cam is-head">
                <span>Камера</span>
                <span>Адрес</span>
                <span>Место</span>
                <span>Назначение</span>
                <span />
            </div>
            {cameras.map(([id, source]) => {
                const streams = Object.entries(source.streams ?? {}).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
                const isOpen = open.has(id);
                return (
                    <div key={id} id={targetId('camera', id)}>
                        <div
                            className={`lb-row lb-cam is-click${isOpen ? ' is-open' : ''}`}
                            role="button"
                            tabIndex={0}
                            aria-expanded={isOpen}
                            onClick={() => toggle(id)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    toggle(id);
                                }
                            }}
                        >
                            <span className="lb-name">
                                <b>{source.camera.display_name || id}</b>
                                <span>{id}</span>
                                <Newer shared={shared} kind="camera" id={id} />
                            </span>
                            <Val shared={shared} kind="camera" id={id} path="camera.ip_adress" mono>
                                {source.camera.ip_adress}
                            </Val>
                            <span className="lb-val">{placeName(definition, source.place)}</span>
                            <Purposes purposes={streams.flatMap(([, stream]) => stream.purposes ?? [])} />
                            <span className="lb-chev">
                                <Icon name="chev" size={14} />
                            </span>
                        </div>
                        {isOpen && (
                            <div className="lb-detail">
                                <div className="lb-sl is-head">
                                    <span>Поток</span>
                                    <span>Разрешение</span>
                                    <span>Назначение</span>
                                </div>
                                {streams.map(([key, stream], index) => (
                                    <div className="lb-sl" key={key}>
                                        <span className="n">{index === 0 ? 'Основной' : index === 1 ? 'Дополнительный' : `Поток ${index + 1}`}</span>
                                        <span className="r">{dimensions(stream.width, stream.height)}</span>
                                        <Purposes purposes={stream.purposes ?? []} />
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
            {!cameras.length && <div className="lb-empty">Камеры не включены в профиль</div>}
        </Section>
    );
}

function Neural(shared: Shared) {
    const { definition, workspace } = shared;
    const configs = entries<NeuralSource>(definition, 'neural_config');
    const slots = entries<SlotSource>(definition, 'neural_slot');
    const streams = entries<StreamSource>(definition, 'video_stream');
    return (
        <Section id="neural" shared={shared} count={configs.length} hint="Нейросети, видеопотоки и слоты">
            <Sub title="Конфигурации нейросетей" hint={String(configs.length)} />
            <div className="lb-grid2">
                {configs.map(([id, config]) => {
                    const info = workspace.assets[config._assets?.[config.model_file] ?? '']?.info;
                    return (
                        <div className="lb-mini" key={id} id={targetId('neural_config', id)}>
                            <div className="t">
                                <b>{config.name || id}</b>
                                <span className="lb-id">{id}</span>
                                <Newer shared={shared} kind="neural_config" id={id} />
                            </div>
                            <Values
                                values={[
                                    ['Модель', config.model_file],
                                    ['Вход модели', dimensions(info?.input_width, info?.input_height)],
                                    [
                                        'Порог / NMS',
                                        <>
                                            <Val shared={shared} kind="neural_config" id={id} path="thresholds.confidence" mono>
                                                {config.thresholds?.confidence !== undefined ? num(config.thresholds.confidence) : 'По умолчанию'}
                                            </Val>
                                            {' / '}
                                            <Val shared={shared} kind="neural_config" id={id} path="thresholds.nms" mono>
                                                {config.thresholds?.nms !== undefined ? num(config.thresholds.nms) : 'По умолчанию'}
                                            </Val>
                                        </>,
                                    ],
                                    [
                                        'Трекер',
                                        <Val shared={shared} kind="neural_config" id={id} path="tracker.type">
                                            {config.tracker?.type || 'Выключен'}
                                        </Val>,
                                    ],
                                ]}
                            />
                            <div className="lb-zones">
                                {(config.zones ?? []).map((zone) => (
                                    <span className="zone-tag" key={zone.id} style={{ '--z': zone.color } as never}>
                                        <i className="zone-g" />
                                        {zone.name}
                                        <span className="num lb-zone-th">{num(zone.threshold)}</span>
                                    </span>
                                ))}
                                {!config.zones?.length && <span className="muted">Зоны не заданы</span>}
                            </div>
                        </div>
                    );
                })}
            </div>
            {!configs.length && <div className="lb-empty">Конфигураций нейросетей нет</div>}
            <Sub title="Видеопотоки и слоты" hint={`${streams.length} · слотов ${slots.length}`} />
            <div className="lb-row lb-stream is-head">
                <span>Видеопоток</span>
                <span>Камеры в плитках</span>
                <span>Слоты</span>
            </div>
            {streams.map(([id, stream]) => {
                const own = slots.filter(([, slot]) => slot.stream_id === id);
                const bad = errorIndex(shared.errors, 'video_stream', id) >= 0 || own.some(([key]) => errorIndex(shared.errors, 'neural_slot', key) >= 0);
                return (
                    <div className={`lb-row lb-stream${bad ? ' is-bad' : ''}`} key={id} id={targetId('video_stream', id)}>
                        <span className="lb-name">
                            <b>{stream.name || id}</b>
                            <span>
                                {id} · {placeName(definition, stream.place)}
                            </span>
                            <Val shared={shared} kind="video_stream" id={id} path="width" mono>
                                {dimensions(stream.width, stream.height)}
                            </Val>
                        </span>
                        <span className="lb-chips">
                            {(stream.tiles ?? []).map((tile, index) =>
                                entity(definition, 'camera', tile.camera) ? (
                                    <span className="lb-tile" key={index}>
                                        <Icon name="cam" size={13} />
                                        {cameraName(definition, tile.camera)}
                                    </span>
                                ) : (
                                    <ErrorChip key={index} shared={shared} kind="video_stream" id={id} refTo={`camera/${tile.camera}`}>
                                        {tile.camera} · камеры нет
                                    </ErrorChip>
                                ),
                            )}
                        </span>
                        <span className="lb-slots">
                            {own.map(([key, slot]) => {
                                const config = entity<NeuralSource>(definition, 'neural_config', slot.config_id);
                                return (
                                    <span className="lb-slotline" key={key} id={targetId('neural_slot', key)}>
                                        <code>{key}</code>
                                        {config ? (
                                            config.name || slot.config_id
                                        ) : (
                                            <ErrorChip shared={shared} kind="neural_slot" id={key} refTo={`neural_config/${slot.config_id}`}>
                                                {slot.config_id} · нейросети нет
                                            </ErrorChip>
                                        )}
                                        <span className="sm">
                                            <Val shared={shared} kind="neural_slot" id={key} path="fps" mono>
                                                {slot.fps} кадр/с
                                            </Val>
                                            {' · глубина '}
                                            {slot.depth}
                                        </span>
                                    </span>
                                );
                            })}
                            {!own.length && <span className="muted">Нет слотов</span>}
                        </span>
                    </div>
                );
            })}
            {!streams.length && <div className="lb-empty">Видеопотоки не заданы</div>}
        </Section>
    );
}

function rect(value?: number[]): Rect | null {
    return value?.length === 4 && value.every(Number.isFinite) && value[2] > 0 && value[3] > 0
        ? { x: value[0], y: value[1], w: value[2], h: value[3] }
        : null;
}

function Projection({ id, source, shared }: { id: string; source: ProjectionSource; shared: Shared }) {
    const { definition } = shared;
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
        <div id={targetId('projection', id)}>
            <Sub title={`Схема «${source.name || id}»`} hint={`${id} · ${output?.active === id ? 'выбрана для вывода' : 'сохранённая схема'}`} />
            <div className="lb-s360">
                <div className="lb-plan-wrap">
                    {geometry?.tiles.length ? (
                        <svg className="lb-plan" viewBox={`0 0 ${geometry.view.width} ${geometry.view.height}`} role="group" aria-label={`Схема камер ${source.name || id}`}>
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
                                <rect className="lb-plan-machine" x={geometry.machine.x} y={geometry.machine.y} width={geometry.machine.w} height={geometry.machine.h} rx={fontSize * 0.25} />
                            )}
                            {geometry.overlays.map((overlay, index) => (
                                <rect className="lb-plan-overlay" key={index} x={overlay.rect.x} y={overlay.rect.y} width={overlay.rect.w} height={overlay.rect.h}>
                                    <title>{overlay.name}</title>
                                </rect>
                            ))}
                            {geometry.icons.map((icon) => (
                                <g key={icon.key} transform={`translate(${icon.x} ${icon.y}) rotate(${icon.angleDeg}) scale(${fontSize / 18})`} className="lb-plan-camera">
                                    <path d="M-8-6H5V6H-8ZM5-3 12-7V7L5 3Z" />
                                </g>
                            ))}
                        </svg>
                    ) : (
                        <div className="lb-empty">Геометрия схемы не сохранена</div>
                    )}
                    {!!geometry?.missing.length && <span className="muted">Без области: {geometry.missing.join(', ')}</span>}
                </div>
                <div>
                    {detail.places.map((place, index) => {
                        const link = place.cameraId ? definition.correction_link?.[place.cameraId] : undefined;
                        const lost = !!link?.config && !definition.calibration?.[String(link.config)];
                        return (
                            <div
                                key={place.key}
                                className={`lb-pos${selected === place.key ? ' is-selected' : ''}${lost ? ' is-bad' : ''}`}
                                id={place.cameraId ? targetId('correction_link', place.cameraId) : undefined}
                            >
                                <button className="p" onClick={() => setSelected(place.key)} aria-pressed={selected === place.key} aria-label={`Позиция ${index + 1}`}>
                                    {index + 1}
                                </button>
                                <span className="lb-name">
                                    <b>{place.name}</b>
                                    <span>{place.cameraId ? cameraName(definition, place.cameraId) : 'Камера не назначена'}</span>
                                </span>
                                {lost && place.cameraId ? (
                                    <ErrorChip shared={shared} kind="correction_link" id={place.cameraId}>
                                        {String(link!.config)} · калибровки нет
                                    </ErrorChip>
                                ) : (
                                    <span className="lb-val num">{link?.config ? String(link.config) : '—'}</span>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
            <div className="lb-outs">
                {(['top', 'surround'] as const)
                    .filter((mode) => mode === 'top' || config?.dual_output || source.surround)
                    .map((mode) => (
                        <div className="lb-out" key={mode}>
                            <Icon name={mode === 'top' ? 'grid' : '360'} size={20} />
                            <span>
                                <b>{mode === 'top' ? 'Вид сверху' : 'Объёмный вид'}</b>
                                <span>
                                    {dimensions(source[mode]?.resolution?.width || config?.width, source[mode]?.resolution?.height || config?.height)} · {config?.fps ?? '—'} кадр/с
                                </span>
                            </span>
                        </div>
                    ))}
            </div>
        </div>
    );
}

function Surround(shared: Shared) {
    const { definition } = shared;
    const projections = entries<ProjectionSource>(definition, 'projection');
    if (!projections.length && !Object.keys(definition.calibration ?? {}).length && !Object.keys(definition.preset ?? {}).length)
        return null;
    return (
        <Section id="surround" shared={shared} count={projections.length} hint="Схемы, калибровки и выходы">
            {projections.map(([id, source]) => (
                <Projection key={id} id={id} source={source} shared={shared} />
            ))}
            {!projections.length && <div className="lb-empty">Схемы вывода не сохранены</div>}
            <Sub title="Калибровки" hint={String(Object.keys(definition.calibration ?? {}).length)} />
            {entries<{ place: string; width?: number; height?: number }>(definition, 'calibration').map(([id, source]) => (
                <div className="lb-row lb-calib" key={id} id={targetId('calibration', id)}>
                    <span className="lb-name">
                        <b>{id}</b>
                        <span>{placeName(definition, source.place)}</span>
                    </span>
                    <span className="lb-val num">{dimensions(source.width, source.height)}</span>
                    <span className="lb-val">
                        {entries<{ config: string }>(definition, 'correction_link')
                            .filter(([, link]) => link.config === id)
                            .map(([camera]) => cameraName(definition, camera))
                            .join(', ') || 'Не назначена'}
                    </span>
                </div>
            ))}
            {!!Object.keys(definition.preset ?? {}).length && (
                <Values values={[['Пресеты', Object.keys(definition.preset).join(', ')]]} />
            )}
        </Section>
    );
}

function Master(shared: Shared) {
    const { definition, workspace } = shared;
    const { id: integration, settings: rules } = profileRules(workspace, definition);
    const values: [string, ReactNode][] = [];
    if (rules?.stitch)
        values.push(['Пауза объединения', `${num(rules.stitch.gap_s)} с`], ['Смещение трека', `${num(rules.stitch.distance)} px`]);
    for (const channel of ['websocket', 'can'] as const) {
        const filter = rules?.[channel];
        if (!filter) continue;
        const name = channel === 'can' ? 'CAN' : 'WebSocket';
        values.push([
            `${name}: передача`,
            `${flag(filter.enabled)}, ${filter.classes_all ? 'все классы' : `классов: ${filter.classes.length}`}`,
        ]);
    }
    if (rules?.websocket) values.push(['WebSocket: срок', `${num(rules.websocket.late_s)} с`]);
    if (rules?.modbus) values.push(['Modbus: запись', `${flag(rules.modbus.enabled)}, срок ${num(rules.modbus.ceiling_s)} с`]);
    const table = rules?.table?.cameras;
    const rows = Array.isArray(table) ? table.length : Object.keys(table ?? {}).length;
    return (
        <Section id="master" shared={shared} count={rows} hint={integration ? `Интеграция ${integration}` : 'Интеграция не задана'}>
            <div className="lb-pad">
                <Values values={values} />
                {rules && (
                    <div className="lb-kvs-row" id={targetId('rules', integration)}>
                        <dt>Таблица камер</dt>
                        <dd>
                            {rows} {rows === 1 ? 'строка' : 'строк'}
                            <ErrorChip shared={shared} kind="rules" id={integration}>
                                Ссылка на несуществующую камеру
                            </ErrorChip>
                        </dd>
                    </div>
                )}
                {!rules && <span className="muted">Настройки правил не сохранены, мастер обнаружений недоступен</span>}
            </div>
        </Section>
    );
}

const MODULE_NAMES: Record<string, string> = { websocket: 'WebSocket', can: 'CAN', modbus: 'Modbus RTU' };
const MODULE_FIELDS: Record<string, string> = {
    host: 'Адрес',
    port: 'Порт',
    target: 'Путь',
    iface: 'Интерфейс',
    device: 'Устройство',
    bitrate: 'Скорость CAN',
    baud: 'Скорость RS-485',
    parity: 'Чётность',
    slave: 'Адрес ведомого',
};

function Gateway(shared: Shared) {
    const integration = String(shared.definition.machine?.settings?.active_integration ?? '');
    const modules = entity<{ modules: Record<string, Record<string, unknown>> }>(shared.definition, 'integration', integration)?.modules;
    if (!modules) return null;
    return (
        <Section id="gateway" shared={shared} count={Object.keys(modules).length} hint="Каналы связи шлюза">
            <div className="lb-mods">
                {Object.entries(modules).map(([id, source]) => (
                    <div className="lb-mini" key={id}>
                        <div className="t">
                            <Icon name={id === 'websocket' ? 'link' : 'bus'} size={16} />
                            <b>{MODULE_NAMES[id] || id}</b>
                            <span className={`tag ${source.enabled === false ? '' : 'is-ok'}`}>{source.enabled === false ? 'Выключен' : 'Включён'}</span>
                        </div>
                        <Values
                            values={Object.entries(source)
                                .filter(([key]) => key !== 'enabled' && !/password|token|secret/i.test(key))
                                .map(([key, value]): [string, ReactNode] => [MODULE_FIELDS[key] || key, <span className="num" key={key}>{printable(value)}</span>])}
                        />
                    </div>
                ))}
            </div>
        </Section>
    );
}

function Display({ shared, timeSource }: { shared: Shared; timeSource?: string }) {
    const { definition } = shared;
    const surroundSources = new Set<string>();
    const names = Object.fromEntries(
        entries<CameraSource>(definition, 'camera').map(([id, source]) => [id, source.camera.display_name || id]),
    );
    for (const [, output] of entries<OutputSource>(definition, 'surround_output'))
        for (const [id, config] of Object.entries(output.configs ?? {}))
            if (config.stream_id) {
                names[config.stream_id] = config.stream_name || id;
                surroundSources.add(config.stream_id);
            }
    const layouts = entries<ProfileLayout>(definition, 'layout');
    return (
        <Section id="display" shared={shared} count={layouts.length} hint="Раскладки рабочего места">
            <div className="lb-layouts">
                {layouts.map(([id, saved]) => {
                    const layout = layoutFromSaved(saved);
                    return (
                        <div className="lb-layout-item" key={id} id={targetId('layout', id)}>
                            <div className="lb-layout-heading">
                                <b>{saved.name || id}</b>
                                <span className="tag">{presetOf(layout.grid) || `${layout.grid.cols} × ${layout.grid.rows}`}</span>
                            </div>
                            <div
                                className="lb-layout-preview"
                                role="img"
                                aria-label={`Раскладка ${saved.name || id}`}
                                style={{ gridTemplateColumns: `repeat(${layout.grid.cols}, 1fr)`, gridTemplateRows: `repeat(${layout.grid.rows}, 1fr)` }}
                            >
                                {layout.grid.cells.map((cell, index) => {
                                    const source = layout.cells[cell.id];
                                    const lost = !!source && errorIndex(shared.errors, 'layout', id, `camera/${source}`) >= 0;
                                    return (
                                        <div
                                            key={cell.id}
                                            className={lost ? 'is-bad' : surroundSources.has(source) ? 'is-surround' : ''}
                                            style={{ gridArea: `${cell.row + 1} / ${cell.col + 1} / span ${cell.rowSpan} / span ${cell.colSpan}` }}
                                        >
                                            {index + 1}
                                        </div>
                                    );
                                })}
                            </div>
                            <ul className="lb-layout-sources">
                                {layout.grid.cells.map((cell, index) => {
                                    const source = layout.cells[cell.id];
                                    const lost = !!source && errorIndex(shared.errors, 'layout', id, `camera/${source}`) >= 0;
                                    return (
                                        <li key={cell.id} className={lost ? 'is-bad' : ''}>
                                            <span>{index + 1}</span>
                                            {lost ? (
                                                <ErrorChip shared={shared} kind="layout" id={id} refTo={`camera/${source}`}>
                                                    {source} · камеры нет
                                                </ErrorChip>
                                            ) : (
                                                names[source] || source || 'Не назначено'
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    );
                })}
                {!layouts.length && <div className="lb-empty">Раскладки не сохранены</div>}
            </div>
            <div className="lb-time">
                <div>
                    <span>Часовой пояс профиля</span>
                    <b className="num">{timezoneLabel(Number(definition.machine?.settings?.tz_offset_min ?? 180))}</b>
                </div>
                <div>
                    <span>Источник времени</span>
                    <b>{timeSource || 'Определяется при запуске'}</b>
                </div>
            </div>
        </Section>
    );
}

// Оглавление слева: пункт отмечается по прокрутке области экрана и сам не перерисовывает ленту
function SectionIndex({ counts, errors, hidden }: { counts: Record<SectionId, number>; errors: BrokenItem[]; hidden: SectionId[] }) {
    const [spy, setSpy] = useState<SectionId>(PROFILE_SECTIONS[0].id);
    const root = useRef<HTMLElement>(null);
    useEffect(() => {
        const scroller = root.current?.closest<HTMLElement>('.lb-view');
        if (!scroller) return;
        const update = () => {
            const line = scroller.getBoundingClientRect().top + 90;
            let current = PROFILE_SECTIONS[0].id;
            for (const section of PROFILE_SECTIONS) {
                const element = document.getElementById(`lb-${section.id}`);
                if (element && element.getBoundingClientRect().top <= line) current = section.id;
            }
            setSpy(current);
        };
        update();
        scroller.addEventListener('scroll', update, { passive: true });
        return () => scroller.removeEventListener('scroll', update);
    }, []);
    return (
        <nav ref={root} className="lb-index" aria-label="Состав профиля">
            <h4>Состав профиля</h4>
            {PROFILE_SECTIONS.filter((section) => !hidden.includes(section.id)).map((section) => {
                const bad = errors.filter((item) => item.section === section.id).length;
                return (
                    <button
                        key={section.id}
                        className={`mod-item${spy === section.id ? ' is-on' : ''}`}
                        onClick={() => {
                            setSpy(section.id);
                            const element = document.getElementById(`lb-${section.id}`);
                            if (element) scrollInside(element, 'start');
                        }}
                    >
                        <Icon name={section.icon} />
                        <span className="nm">{section.name}</span>
                        {bad ? <span className="lb-bad">{bad}</span> : <span className="sub">{counts[section.id]}</span>}
                    </button>
                );
            })}
        </nav>
    );
}

export interface Vital {
    key: string;
    label: string;
    value: ReactNode;
    sub: string;
    tone: '' | 'ok' | 'warn' | 'err';
    text?: boolean;
    onClick?: () => void;
}

export function Vitals({ items }: { items: Vital[] }) {
    return (
        <div className="lb-vitals">
            {items.map((item) => {
                const body = (
                    <>
                        <span className="k">{item.label}</span>
                        <span className={`v${item.text ? ' is-text' : ''}`}>{item.value}</span>
                        <span className="s">{item.sub}</span>
                    </>
                );
                return item.onClick ? (
                    <button key={item.key} className={`lb-vital is-click${item.tone ? ` is-${item.tone}` : ''}`} onClick={item.onClick}>
                        {body}
                    </button>
                ) : (
                    <div key={item.key} className={`lb-vital${item.tone ? ` is-${item.tone}` : ''}`}>
                        {body}
                    </div>
                );
            })}
        </div>
    );
}

export function ProfileOverview({
    workspace,
    definition,
    timeSource,
    errors,
    vitals,
    notices,
    onError,
}: {
    workspace: Workspace;
    definition: Definition;
    timeSource?: string;
    errors: BrokenItem[];
    vitals: Vital[];
    notices: ReactNode;
    onError: (index: number) => void;
}) {
    const shared: Shared = { workspace, definition, errors, onError };
    const counts: Record<SectionId, number> = {
        cameras: Object.keys(definition.camera ?? {}).length,
        neural: Object.keys(definition.neural_config ?? {}).length,
        surround: Object.keys(definition.projection ?? {}).length,
        master: 0,
        gateway: 0,
        display: Object.keys(definition.layout ?? {}).length,
    };
    const integration = String(definition.machine?.settings?.active_integration ?? '');
    counts.gateway = Object.keys(entity<{ modules: object }>(definition, 'integration', integration)?.modules ?? {}).length;
    const table = profileRules(workspace, definition).settings?.table?.cameras;
    counts.master = Array.isArray(table) ? table.length : Object.keys(table ?? {}).length;
    const hasSurround = !!Object.keys(definition.projection ?? {}).length || !!Object.keys(definition.calibration ?? {}).length || !!Object.keys(definition.preset ?? {}).length;
    const hidden: SectionId[] = [...(hasSurround ? [] : ['surround' as const]), ...(integration && entity(definition, 'integration', integration) ? [] : ['gateway' as const])];
    return (
        <div className="lb-split">
            <SectionIndex counts={counts} errors={errors} hidden={hidden} />
            <div className="lb-col">
                {notices}
                <Vitals items={vitals} />
                <Cameras {...shared} />
                <Neural {...shared} />
                {hasSurround && <Surround {...shared} />}
                <Master {...shared} />
                <Gateway {...shared} />
                <Display shared={shared} timeSource={timeSource} />
            </div>
        </div>
    );
}
