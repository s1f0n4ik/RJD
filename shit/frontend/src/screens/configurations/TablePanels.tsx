import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../../app/Icons';
import { Select, type SelectOption } from '../../app/Select';
import type { IskraTable, IskraZone, RsmClassRule, RsmTable } from './api';
import { ISKRA_CODES, ROLES, missing, type CameraRef, type ClassCatalog } from './RulesPanels';

// Словари протокола CAN: тип 1–8, класс опасности 1–4
const TYPES = [
    '', 'Человек', 'Инструмент', 'Металлический предмет', 'Каменные и бетонные материалы', 'Древесные материалы',
    'Полимерные и текстильные материалы', 'Сезонные и погодные объекты', 'Специфические предметы, связанные с работами РСМ',
];
const DANGERS = ['', 'Информация (нет опасности)', 'Средняя опасность', 'Высокая опасность', 'Критическая опасность'];
const NEUTRAL = '#94a1ab';
const PALETTE = ['#ff6b80', '#ff9461', '#f0bd57', '#57d69a', '#4fd1d9', '#6aa8ff', '#b48cff', '#94a1ab'];
const CAMERA_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8];

const typeLabel = (n: number) => `${n} · ${TYPES[n]}`;
const dangerLabel = (n: number) => `${n} · ${DANGERS[n]}`;

function rgba(hex: string, a: number): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    const n = m ? parseInt(m[1], 16) : 0x94a1ab;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function Card({ title, meta, className, children }: { title: string; meta?: string; className?: string; children: ReactNode }) {
    return (
        <section className={`card tb-card${className ? ` ${className}` : ''}`}>
            <div className="card-h"><h3>{title}</h3>{meta && <span className="eyebrow">{meta}</span>}</div>
            <div className="card-b">{children}</div>
        </section>
    );
}

// Число из словаря: 0 — «не задано», показывается подсказкой
function DictSelect({ value, max, label, placeholder, onChange }: {
    value: number;
    max: number;
    label: (n: number) => string;
    placeholder: string;
    onChange: (v: number) => void;
}) {
    const options: SelectOption[] = [
        { value: '0', label: placeholder, muted: true },
        ...Array.from({ length: max }, (_, i) => ({ value: String(i + 1), label: label(i + 1) })),
    ];
    return <Select value={value ? String(value) : ''} placeholder={placeholder} options={options} onChange={v => onChange(Number(v))} />;
}

const GoneTag = () => <span className="tag is-warn">нет в нейросетях</span>;

// ── РСМ-2000: тип и опасность CAN, номера камер ──

export function RsmTablePanel({ value, onChange, catalog, cameras }: {
    value: RsmTable;
    onChange: (v: RsmTable) => void;
    catalog: ClassCatalog;
    cameras: CameraRef[];
}) {
    const def = value.defaults;

    const supers = useMemo(() => [
        ...catalog.superclasses.map(s => ({ key: s.key, name: s.name || s.key, color: s.color || NEUTRAL, gone: false })),
        ...Object.keys(value.superclasses)
            .filter(k => !catalog.superclasses.some(s => s.key === k))
            .map(k => ({ key: k, name: k, color: NEUTRAL, gone: missing(k, catalog) })),
    ], [catalog, value.superclasses]);

    // Классы группами суперклассов, затем без группы, затем сохранённые, которых нет в нейросетях
    const classes = useMemo(() => {
        const grouped = [
            ...catalog.superclasses.flatMap(s => catalog.classes.filter(c => c.superclass === s.key)),
            ...catalog.classes.filter(c => !catalog.superclasses.some(s => s.key === c.superclass)),
        ];
        return [
            ...grouped.map(c => ({ name: c.name, superclass: c.superclass, gone: false })),
            ...Object.keys(value.classes)
                .filter(n => !catalog.classes.some(c => c.name === n))
                .map(n => ({ name: n, superclass: '', gone: missing(n, catalog) })),
        ];
    }, [catalog, value.classes]);

    const superOf = (key: string) => supers.find(s => s.key === key);

    const setSuper = (key: string, danger: number) => {
        const next = { ...value.superclasses };
        if (danger) next[key] = danger; else delete next[key];
        onChange({ ...value, superclasses: next });
    };
    const setClass = (name: string, patch: Partial<RsmClassRule>) => {
        const rule = { ...(value.classes[name] ?? { type: 0, danger: 0 }), ...patch };
        const next = { ...value.classes };
        if (rule.type || rule.danger) next[name] = rule; else delete next[name];
        onChange({ ...value, classes: next });
    };

    const used = new Set(Object.values(value.cameras));
    const assigned = Object.entries(value.cameras).sort((a, b) => a[1] - b[1]);
    const free = cameras.filter(c => !(c.id in value.cameras));
    const camera = (id: string) => cameras.find(c => c.id === id);
    const setCameras = (next: Record<string, number>) => onChange({ ...value, cameras: next });
    const addCamera = (id: string) => {
        const n = CAMERA_NUMBERS.find(b => !used.has(b));
        if (n) setCameras({ ...value.cameras, [id]: n });
    };
    const removeCamera = (id: string) => {
        const next = { ...value.cameras };
        delete next[id];
        setCameras(next);
    };

    return (
        <>
            <Card title="По умолчанию" meta="класс без строки">
                <div className="tb-defs">
                    <div className="cr-row">
                        <label>Тип</label>
                        <Select
                            value={String(def.type)}
                            options={TYPES.slice(1).map((_, i) => ({ value: String(i + 1), label: typeLabel(i + 1) }))}
                            onChange={v => onChange({ ...value, defaults: { ...def, type: Number(v) } })}
                        />
                    </div>
                    <div className="cr-row">
                        <label>Опасность</label>
                        <Select
                            value={String(def.danger)}
                            options={DANGERS.slice(1).map((_, i) => ({ value: String(i + 1), label: dangerLabel(i + 1) }))}
                            onChange={v => onChange({ ...value, defaults: { ...def, danger: Number(v) } })}
                        />
                    </div>
                </div>
            </Card>

            <Card title="Суперклассы" meta="опасность на группу">
                <div className="gt">
                    <table className="spec">
                        <thead><tr><th style={{ width: '50%' }}>Суперкласс</th><th style={{ width: '50%' }}>Опасность</th></tr></thead>
                        <tbody>
                            {supers.map(s => (
                                <tr key={s.key}>
                                    <td className="name big">
                                        <span className="swk"><i style={{ background: s.color }} /><b>{s.name}</b></span>
                                        <span>{s.key}</span>
                                        {s.gone && <GoneTag />}
                                    </td>
                                    <td>
                                        <DictSelect
                                            value={value.superclasses[s.key] ?? 0}
                                            max={4}
                                            label={dangerLabel}
                                            placeholder={`по умолчанию · ${DANGERS[def.danger]}`}
                                            onChange={v => setSuper(s.key, v)}
                                        />
                                    </td>
                                </tr>
                            ))}
                            {supers.length === 0 && <tr><td colSpan={2} className="dim">Суперклассов в нейросетях нет</td></tr>}
                        </tbody>
                    </table>
                </div>
            </Card>

            <Card title="Классы" meta={`${classes.filter(c => value.classes[c.name]?.type).length} из ${classes.length} с типом`}>
                <div className="gt">
                    <table className="spec">
                        <thead>
                            <tr>
                                <th style={{ width: '24%' }}>Класс</th>
                                <th style={{ width: '16%' }}>Суперкласс</th>
                                <th style={{ width: '30%' }}>Тип</th>
                                <th style={{ width: '30%' }}>Опасность</th>
                            </tr>
                        </thead>
                        <tbody>
                            {classes.map(c => {
                                const sc = superOf(c.superclass);
                                const color = sc?.color ?? NEUTRAL;
                                const rule = value.classes[c.name];
                                const groupDanger = (sc && value.superclasses[sc.key]) || def.danger;
                                return (
                                    <tr
                                        key={c.name}
                                        style={{
                                            boxShadow: `inset 3px 0 0 ${color}`,
                                            background: `linear-gradient(90deg, ${rgba(color, 0.12)}, ${rgba(color, 0.02)} 60%, transparent)`,
                                        }}
                                    >
                                        <td className="nm"><b>{c.name}</b>{c.gone && <GoneTag />}</td>
                                        <td>{sc ? <span className="swk"><i style={{ background: sc.color }} />{sc.name}</span> : <span className="muted">без группы</span>}</td>
                                        <td>
                                            <DictSelect
                                                value={rule?.type ?? 0}
                                                max={8}
                                                label={typeLabel}
                                                placeholder={`по умолчанию · ${typeLabel(def.type)}`}
                                                onChange={type => setClass(c.name, { type })}
                                            />
                                        </td>
                                        <td>
                                            <DictSelect
                                                value={rule?.danger ?? 0}
                                                max={4}
                                                label={dangerLabel}
                                                placeholder={sc ? `↳ от группы · ${DANGERS[groupDanger]}` : `по умолчанию · ${DANGERS[def.danger]}`}
                                                onChange={danger => setClass(c.name, { danger })}
                                            />
                                        </td>
                                    </tr>
                                );
                            })}
                            {classes.length === 0 && <tr><td colSpan={4} className="dim">Классов в нейросетях нет</td></tr>}
                        </tbody>
                    </table>
                </div>
            </Card>

            <Card title="Номера камер" meta={`${assigned.length} из 8`}>
                <div className="bitcards">
                    {[...CAMERA_NUMBERS].reverse().map(n => {
                        const id = assigned.find(([, no]) => no === n)?.[0];
                        return (
                            <div key={n} className={`bitcard${id ? ' is-set' : ''}`}>
                                <div className="n">{n}</div>
                                <div className="l">номер</div>
                                <div className="c">{id ? camera(id)?.name ?? id : 'свободен'}</div>
                            </div>
                        );
                    })}
                </div>
                <div className="gt">
                    <table className="spec">
                        <thead><tr><th>Камера</th><th style={{ width: 220 }}>Номер</th><th style={{ width: 44 }} /></tr></thead>
                        <tbody>
                            {assigned.map(([id, no]) => {
                                const cam = camera(id);
                                return (
                                    <tr key={id}>
                                        <td className="cam"><b>{cam?.name ?? id}</b><small>{cam?.device ? `${id} · ${cam.device}` : id}</small></td>
                                        <td>
                                            <Select
                                                value={String(no)}
                                                options={CAMERA_NUMBERS.filter(n => n === no || !used.has(n)).map(n => ({ value: String(n), label: `номер ${n}` }))}
                                                onChange={v => setCameras({ ...value.cameras, [id]: Number(v) })}
                                            />
                                        </td>
                                        <td>
                                            <button type="button" className="x" aria-label="Убрать камеру" onClick={() => removeCamera(id)}>
                                                <Icon name="x" size={13} />
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                            {assigned.length === 0 && <tr><td colSpan={3} className="dim">Камер пока нет</td></tr>}
                        </tbody>
                    </table>
                </div>
                <div className="addline">
                    <Icon name="plus" size={16} />
                    Новая камера
                    {assigned.length < 8 && free.length > 0 ? (
                        <Select
                            value=""
                            placeholder="— выберите камеру технического зрения —"
                            options={free.map(c => ({ value: c.id, label: c.name, hint: c.device ? `${c.id} · ${c.device}` : c.id }))}
                            onChange={addCamera}
                        />
                    ) : (
                        <span className="note">
                            {assigned.length >= 8 ? 'все восемь номеров заняты' : cameras.length === 0 ? 'камер технического зрения нет' : 'все камеры технического зрения добавлены'}
                        </span>
                    )}
                </div>
            </Card>
        </>
    );
}

// ── Искра: коды 28163, роли камер, зоны ──

const CODE_OPTIONS: SelectOption[] = [
    { value: '', label: '— только журнал', muted: true },
    ...ISKRA_CODES.map((label, code) => ({ value: String(code), label: `${code} · ${label}` })),
];

function CodesCard({ codes, catalog, onChange }: { codes: Record<string, number>; catalog: ClassCatalog; onChange: (v: Record<string, number>) => void }) {
    const rows = useMemo(() => {
        const known = new Set(catalog.classes.map(c => c.name));
        return [
            ...catalog.classes.map(c => ({ ...c, gone: false })),
            ...Object.keys(codes).filter(n => !known.has(n)).map(name => ({ name, superclass: '', gone: missing(name, catalog) })),
        ];
    }, [catalog, codes]);
    const scName = (key: string) => catalog.superclasses.find(s => s.key === key)?.name ?? key;
    const set = (name: string, v: string) => {
        const next = { ...codes };
        if (v === '') delete next[name]; else next[name] = Number(v);
        onChange(next);
    };
    return (
        <Card title="Класс → код 28163" meta={`${rows.filter(r => r.name in codes).length} из ${rows.length}`} className="tb-codes">
            {rows.length === 0 ? <div className="cr-none">Классов нет</div> : (
                <div className="cr-map">
                    <div className="cr-map-r is-head"><span>Класс</span><span>Код</span></div>
                    {rows.map(r => (
                        <div key={r.name} className="cr-map-r">
                            <span className="nm">
                                <span>{r.name}</span>
                                {r.superclass && <span className="tag">{scName(r.superclass)}</span>}
                                {r.gone && <GoneTag />}
                            </span>
                            <Select value={r.name in codes ? String(codes[r.name]) : ''} placeholder="— только журнал" options={CODE_OPTIONS} onChange={v => set(r.name, v)} />
                        </div>
                    ))}
                </div>
            )}
        </Card>
    );
}

function RolesCard({ roles, cameras, onChange }: { roles: Record<string, number>; cameras: CameraRef[]; onChange: (v: Record<string, number>) => void }) {
    const rows = useMemo(() => {
        const known = new Set(cameras.map(c => c.id));
        return [...cameras, ...Object.keys(roles).filter(id => !known.has(id)).map(id => ({ id, name: id, device: '' }))];
    }, [cameras, roles]);
    const set = (id: string, role: number) => {
        const next = { ...roles };
        if (role) next[id] = role; else delete next[id];
        onChange(next);
    };
    return (
        <Card title="Роли камер" meta={`${Object.values(roles).filter(Boolean).length} из ${rows.length}`}>
            {rows.length === 0 ? <div className="cr-none">Камер нет</div> : (
                <div className="cr-map cr-roles">
                    {rows.map(cam => (
                        <div key={cam.id} className="cr-map-r">
                            <span className="cam">{cam.name}<small>{cam.device ? `${cam.id} · ${cam.device}` : cam.id}</small></span>
                            <span className="seg">
                                {ROLES.map(r => (
                                    <button key={r.value} type="button" className={roles[cam.id] === r.value ? 'is-on' : ''} onClick={() => set(cam.id, r.value)}>
                                        <i>{r.value}</i>{r.label}
                                    </button>
                                ))}
                                <button type="button" className={roles[cam.id] ? '' : 'is-on'} onClick={() => set(cam.id, 0)}>—</button>
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </Card>
    );
}

const validNumber = (text: string) => /^\d{1,5}$/.test(text) && Number(text) <= 65535;

// Номер зоны: текст правится свободно, в настройки уходит только разобранное
function ZoneNumber({ value, error, onChange }: { value: number; error: boolean; onChange: (v: number) => void }) {
    const [text, setText] = useState(String(value));
    useEffect(() => {
        if (Number(text) !== value) setText(String(value));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);
    return (
        <input
            className={`inp tb-zn${error || !validNumber(text) ? ' is-err' : ''}`}
            inputMode="numeric"
            aria-label="Номер зоны"
            value={text}
            onChange={e => {
                setText(e.target.value);
                if (validNumber(e.target.value)) onChange(Number(e.target.value));
            }}
            onBlur={() => setText(String(value))}
        />
    );
}

// Повтор номера: зона, у которой этот номер раньше по списку
function duplicateOf(zones: IskraZone[], i: number): IskraZone | undefined {
    return zones.slice(0, i).find(z => z.number === zones[i].number);
}

// Ошибка, из-за которой таблицу нельзя сохранить; пусто — можно
export function zonesError(zones: IskraZone[]): string {
    return zones.some((_, i) => duplicateOf(zones, i)) ? 'номер зоны повторяется' : '';
}

export function defaultZoneLabel(table: IskraTable): string {
    const zone = table.zones.find(z => z.default);
    return zone ? `${zone.number} · ${zone.name || 'без названия'}` : '—';
}

function ZonesCard({ zones, onChange }: { zones: IskraZone[]; onChange: (v: IskraZone[]) => void }) {
    const [palette, setPalette] = useState<number | null>(null);

    useEffect(() => {
        if (palette === null) return;
        const close = (e: MouseEvent) => {
            if (!(e.target as Element).closest('.tb-pal, .tb-sw')) setPalette(null);
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [palette]);

    const set = (i: number, patch: Partial<IskraZone>) => onChange(zones.map((z, j) => (j === i ? { ...z, ...patch } : z)));
    const move = (i: number, d: number) => {
        const next = [...zones];
        [next[i], next[i + d]] = [next[i + d], next[i]];
        setPalette(null);
        onChange(next);
    };
    const add = () => {
        const number = Math.min(65535, Math.max(0, ...zones.map(z => z.number)) + 1);
        const color = PALETTE.find(c => !zones.some(z => z.color === c)) ?? NEUTRAL;
        onChange([...zones, { number, name: '', color, default: false }]);
    };

    return (
        <Card title="Зоны" meta={`${zones.length} · сверху опаснее`}>
            <div className="tb-zones">
                <div className="tb-zr is-head"><span /><span /><span>Номер</span><span>Название</span><span>По умолчанию</span><span /></div>
                {zones.map((z, i) => {
                    const dup = duplicateOf(zones, i);
                    return (
                        <div key={i} className="tb-zr">
                            <span className="tb-ord">
                                <button type="button" className="tb-arr up" disabled={i === 0} aria-label="Выше" onClick={() => move(i, -1)}>
                                    <Icon name="chev" size={10} />
                                </button>
                                <button type="button" className="tb-arr dn" disabled={i === zones.length - 1} aria-label="Ниже" onClick={() => move(i, 1)}>
                                    <Icon name="chev" size={10} />
                                </button>
                            </span>
                            <button
                                type="button"
                                className={`tb-sw${palette === i ? ' is-open' : ''}`}
                                style={{ '--c': z.color } as CSSProperties}
                                aria-label="Цвет зоны"
                                onClick={() => setPalette(palette === i ? null : i)}
                            >
                                <i />
                            </button>
                            <ZoneNumber value={z.number} error={!!dup} onChange={number => set(i, { number })} />
                            <input className="inp inp--text" aria-label="Название зоны" value={z.name} onChange={e => set(i, { name: e.target.value })} />
                            <button
                                type="button"
                                className={`tb-radio${z.default ? ' is-on' : ''}`}
                                aria-label="Зона по умолчанию"
                                aria-pressed={z.default}
                                onClick={() => onChange(zones.map((x, j) => ({ ...x, default: j === i })))}
                            >
                                <i />
                            </button>
                            <button
                                type="button"
                                className="tb-x"
                                disabled={z.default}
                                data-tip={z.default ? 'Зону по умолчанию не удалить' : undefined}
                                aria-label="Удалить зону"
                                onClick={() => onChange(zones.filter((_, j) => j !== i))}
                            >
                                <Icon name="x" size={13} />
                            </button>
                            {dup && <span className="tb-msg">Номер {z.number} уже у зоны «{dup.name || 'без названия'}»</span>}
                            {palette === i && (
                                <div className="tb-pal">
                                    {PALETTE.map(c => (
                                        <button
                                            key={c}
                                            type="button"
                                            className={c === z.color ? 'is-on' : ''}
                                            style={{ '--c': c } as CSSProperties}
                                            aria-label={c}
                                            onClick={() => {
                                                set(i, { color: c });
                                                setPalette(null);
                                            }}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="tb-foot">
                <button type="button" className="cr-add" onClick={add}><Icon name="plus" size={11} />Зона</button>
            </div>
        </Card>
    );
}

export function IskraTablePanel({ value, onChange, catalog, cameras }: {
    value: IskraTable;
    onChange: (v: IskraTable) => void;
    catalog: ClassCatalog;
    cameras: CameraRef[];
}) {
    return (
        <div className="tb-halves">
            <div className="tb-col">
                <CodesCard codes={value.codes} catalog={catalog} onChange={codes => onChange({ ...value, codes })} />
            </div>
            <div className="tb-col">
                <RolesCard roles={value.roles} cameras={cameras} onChange={roles => onChange({ ...value, roles })} />
                <ZonesCard zones={value.zones} onChange={zones => onChange({ ...value, zones })} />
            </div>
        </div>
    );
}
