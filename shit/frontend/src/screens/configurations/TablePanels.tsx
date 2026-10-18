import { useEffect, useState, type ReactNode } from 'react';
import { FitText } from '../../app/FitText';
import { Icon } from '../../app/Icons';
import { Select, type SelectOption } from '../../app/Select';
import { dictName, type DictEntry, type Dictionaries } from '../../features/krsps/utils/dictionaries';
import { isIskraTable, type IskraCamera, type IskraTable, type ModelTable, type RsmTable } from './api';
import type { CameraRef } from './RulesPanels';

// Конфигурация нейросети с плат: классы по id, суперклассы по месту в списке
export interface NeuralModel {
    id: string;
    name: string;
    classes: { id: number; name: string; superclass: string }[];
    superclasses: { key: string; name: string; color: string }[];
}

// Конфигурация нейросети → платы, где её слот запущен
export type RunningMap = Map<string, string[]>;

const NEUTRAL = '#878c97';
const NUMBERS_1_8 = [1, 2, 3, 4, 5, 6, 7, 8];

// Подписи словарей; число ограничено полем протокола
const DICT_META: Record<string, { title: string; proto: string; max: number }> = {
    type: { title: 'Тип обнаружения', proto: 'CAN', max: 255 },
    danger: { title: 'Класс опасности', proto: 'CAN', max: 255 },
    code: { title: 'Код', proto: 'запись 28163', max: 65535 },
    zone: { title: 'Зона', proto: 'запись 28163', max: 65535 },
};
const meta = (key: string) => DICT_META[key] ?? { title: key, proto: '', max: 65535 };

// Какие числа берут правила конфигурации шлюза
interface Kind {
    cls: string;
    // null — суперклассы правила не берут
    sup: string | null;
    of: string;
    empty: string;
    zones: boolean;
}
const RSM: Kind = { cls: 'type', sup: 'danger', of: 'РСМ-2000', empty: 'пусто · не отправлять', zones: false };
const ISKRA: Kind = { cls: 'code', sup: null, of: 'Искры', empty: 'пусто · только журнал', zones: true };

// Ключ записи: undefined — убрать
function put<T>(rec: Record<string, T>, key: string, v: T | undefined): Record<string, T> {
    const next = { ...rec };
    if (v === undefined) delete next[key];
    else next[key] = v;
    return next;
}

function Card({ title, meta: eyebrow, className, children }: { title: string; meta?: string; className?: string; children: ReactNode }) {
    return (
        <section className={`card tb-card${className ? ` ${className}` : ''}`}>
            <div className="card-h"><h3>{title}</h3>{eyebrow && <span className="eyebrow">{eyebrow}</span>}</div>
            <div className="card-b">{children}</div>
        </section>
    );
}

function Group({ name, n, children }: { name: string; n?: number; children: ReactNode }) {
    return (
        <div className="mt-group">
            <div className="mt-group-h"><h4>{name}</h4>{n !== undefined && <span className="n">{n}</span>}</div>
            {children}
        </div>
    );
}

// Число строки: без строки — по умолчанию, иначе из словаря или пусто (0)
function NumberSelect({ entries, value, auto, autoLabel, autoMark, autoEmpty, empty, onChange }: {
    entries: DictEntry[];
    value: number | undefined;
    auto: number;
    autoLabel: string;
    autoMark: ReactNode;
    autoEmpty?: string;
    empty: string;
    onChange: (v: number | undefined) => void;
}) {
    const name = (n: number) => entries.find(e => e.number === n)?.name;
    const hint = (n: number) => (n ? `${n} · ${name(n) ?? 'нет в протоколе'}` : 'пусто');
    const unique = entries.filter((e, i) => entries.findIndex(x => x.number === e.number) === i);
    const options: SelectOption[] = [
        { value: '', label: autoLabel, hint: hint(auto) },
        ...unique.map(e => ({ value: String(e.number), label: `${e.number} · ${e.name}` })),
        ...(value && !name(value) ? [{ value: String(value), label: `${value} · нет в протоколе`, muted: true }] : []),
        { value: '0', label: 'Пусто', hint: '0' },
    ];
    const isAuto = value === undefined;
    const n = isAuto ? auto : value;
    const display = (
        <span className={`mt-v${isAuto ? ' is-auto' : ''}`}>
            {isAuto && autoMark}
            {n === 0 ? (
                <span className="mt-empty">{isAuto && autoEmpty ? autoEmpty : empty}</span>
            ) : (
                <><span className="k">{n}</span>{name(n) ?? <span className="tag is-warn">нет в протоколе</span>}</>
            )}
        </span>
    );
    return <Select value={isAuto ? '' : String(value)} options={options} display={display} onChange={v => onChange(v === '' ? undefined : Number(v))} />;
}

function Running({ devices }: { devices?: string[] }) {
    return devices?.length
        ? <span className="mt-act is-on"><i className="dot ok" />активна · {devices.join(', ')}</span>
        : <span className="mt-act"><i className="dot" />не запущена</span>;
}

function BlockHead({ name, n, dict }: { name: string; n: number; dict: string }) {
    return <div className="mt-blk-h"><b>{name}</b><span className="n">{n}</span><span className="to">→ {meta(dict).title}</span></div>;
}

const autoNo = (rec: Record<string, number>, i: number) => rec[String(i)] ?? i + 1;

// Заданных строк и чисел вне словаря в секции
function sectionStats(kind: Kind, dicts: Dictionaries, model: NeuralModel | undefined, value: ModelTable, override?: Record<string, number>) {
    const set = Object.keys(value.classes).length + (kind.sup ? Object.keys(value.superclasses).length : 0) + Object.keys(override ?? {}).length;
    const outside = (key: string, n: number) => n !== 0 && !dictName(dicts, key, n);
    let off = model?.classes.filter(c => outside(kind.cls, autoNo(value.classes, c.id))).length ?? 0;
    if (kind.sup && model) off += model.superclasses.filter((_, i) => outside(kind.sup!, autoNo(value.superclasses, i))).length;
    return { set, off };
}

function ModelSection({ kind, id, model, value, override, dicts, running, open, onToggle, onRemove, onChange, onOverride }: {
    kind: Kind;
    id: string;
    model?: NeuralModel;
    value: ModelTable;
    // Правило РСМ: id класса → опасность; у Искры нет
    override?: Record<string, number>;
    dicts: Dictionaries;
    running?: string[];
    open: boolean;
    onToggle: () => void;
    onRemove: () => void;
    onChange: (v: ModelTable) => void;
    onOverride?: (v: Record<string, number>) => void;
}) {
    const clsDict = dicts[kind.cls] ?? [];
    const supDict = kind.sup ? dicts[kind.sup] ?? [] : [];
    const { set, off } = sectionStats(kind, dicts, model, value, override);

    let body: ReactNode = null;
    if (open && !model) {
        body = <div className="mt-line">Конфигурации нет на платах в сети — заданные строки сохранены</div>;
    } else if (open && model) {
        const places = (key: string) => (kind.sup ? model.superclasses.findIndex(s => s.key === key) : -1);
        body = (
            <>
                <div className="mt-blk">
                    <BlockHead name="Классы" n={model.classes.length} dict={kind.cls} />
                    <div className={`mt-tab${override ? ' has-over' : ''}`}>
                        <div className="mt-r is-head">
                            <span>id</span><span>Класс</span><span>{meta(kind.cls).title}</span>
                            {override && <span>Опасность класса<em>правило РСМ</em></span>}
                        </div>
                        {model.classes.map(c => {
                            const own = value.classes[String(c.id)];
                            const n = own ?? c.id + 1;
                            const place = places(c.superclass);
                            const sc = place >= 0 ? model.superclasses[place] : undefined;
                            return (
                                <div key={c.id} className={`mt-r${n && !dictName(dicts, kind.cls, n) ? ' is-off' : ''}`}>
                                    <span className="mt-id">{c.id}</span>
                                    <span className="mt-name">
                                        <b><FitText text={c.name} /></b>
                                        {sc && <span className="mt-sc"><i style={{ background: sc.color || NEUTRAL }} />{sc.name || sc.key}</span>}
                                    </span>
                                    <NumberSelect
                                        entries={clsDict}
                                        value={own}
                                        auto={c.id + 1}
                                        autoLabel="По умолчанию · id + 1"
                                        autoMark={<span className="mt-plus">+1</span>}
                                        empty={kind.empty}
                                        onChange={v => onChange({ ...value, classes: put(value.classes, String(c.id), v) })}
                                    />
                                    {override && onOverride && (
                                        <NumberSelect
                                            entries={supDict}
                                            value={override[String(c.id)]}
                                            auto={sc ? autoNo(value.superclasses, place) : 0}
                                            autoLabel="От суперкласса"
                                            autoMark={sc ? <span className="mt-from">↳</span> : null}
                                            autoEmpty="пусто · нет группы"
                                            empty="пусто"
                                            onChange={v => onOverride(put(override, String(c.id), v))}
                                        />
                                    )}
                                </div>
                            );
                        })}
                        {model.classes.length === 0 && <div className="mt-r"><span className="mt-wide">Классов нет</span></div>}
                    </div>
                </div>
                {model.superclasses.length === 0 ? (
                    <div className="mt-line"><b>Суперклассы</b><span className="n">0</span>в конфигурации нейросети нет</div>
                ) : !kind.sup ? (
                    <div className="mt-line"><b>Суперклассы</b><span className="n">{model.superclasses.length}</span>правилами {kind.of} не используются</div>
                ) : (
                    <div className="mt-blk">
                        <BlockHead name="Суперклассы" n={model.superclasses.length} dict={kind.sup} />
                        <div className="mt-tab">
                            <div className="mt-r is-head"><span>№</span><span>Суперкласс</span><span>{meta(kind.sup).title}</span></div>
                            {model.superclasses.map((s, i) => {
                                const own = value.superclasses[String(i)];
                                const n = own ?? i + 1;
                                return (
                                    <div key={s.key} className={`mt-r${n && !dictName(dicts, kind.sup!, n) ? ' is-off' : ''}`}>
                                        <span className="mt-id">{i}</span>
                                        <span className="mt-name">
                                            <span className="mt-sc is-main"><i style={{ background: s.color || NEUTRAL }} /><b>{s.name || s.key}</b></span>
                                            <small>{s.key}</small>
                                        </span>
                                        <NumberSelect
                                            entries={supDict}
                                            value={own}
                                            auto={i + 1}
                                            autoLabel="По умолчанию · № + 1"
                                            autoMark={<span className="mt-plus">+1</span>}
                                            empty={kind.empty}
                                            onChange={v => onChange({ ...value, superclasses: put(value.superclasses, String(i), v) })}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
                {kind.zones ? (
                    <div className="mt-line"><b>Зоны</b><span className="n">0</span>слот инференса пока не ставит зоны — зона в записи 28163 уходит пустой</div>
                ) : (
                    <div className="mt-line"><b>Зоны</b><span className="n">0</span>правилами {kind.of} не используются</div>
                )}
            </>
        );
    }

    return (
        <section className={`card mt-model${open ? '' : ' is-closed'}`}>
            <div
                className="mt-mh"
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={onToggle}
                onKeyDown={e => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        onToggle();
                    }
                }}
            >
                <Icon name="chev" size={12} className="car" />
                <span className="ttl">{model?.name ?? id}</span>
                <span className="id">{id}</span>
                <Running devices={running} />
                <span className="mt-sum">
                    {!model && <span className="tag is-warn">нет на платах в сети</span>}
                    {set ? <span className="tag is-acc">задано {set}</span> : <span className="tag">всё по +1</span>}
                    {off > 0 && <span className="tag is-warn">нет в протоколе {off}</span>}
                </span>
                <button
                    type="button"
                    className="mt-x"
                    aria-label="Убрать из таблицы"
                    data-tip="Убрать из таблицы — классы пойдут по +1"
                    onClick={e => {
                        e.stopPropagation();
                        onRemove();
                    }}
                >
                    <Icon name="x" size={13} />
                </button>
            </div>
            {open && <div className="mt-mb">{body}</div>}
        </section>
    );
}

// Конфигурации нейросети в таблице: добавляются из списка плат, не добавленная идёт по +1
function ModelsGroup({ kind, value, override, dicts, catalog, running, onChange }: {
    kind: Kind;
    value: Record<string, ModelTable>;
    override?: Record<string, Record<string, number>>;
    dicts: Dictionaries;
    catalog: NeuralModel[];
    running: RunningMap;
    onChange: (models: Record<string, ModelTable>, override?: Record<string, Record<string, number>>) => void;
}) {
    const ids = Object.keys(value);
    const [open, setOpen] = useState<Set<string>>(() => new Set(ids.slice(0, 1)));
    const toggle = (id: string) => setOpen(s => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });
    const add = (id: string) => {
        onChange({ ...value, [id]: { classes: {}, superclasses: {} } }, override);
        setOpen(s => new Set(s).add(id));
    };
    const remove = (id: string) => onChange(put(value, id, undefined), override && put(override, id, undefined));
    const free = catalog.filter(m => !(m.id in value));

    return (
        <Group name="Конфигурации нейросети" n={ids.length}>
            {ids.length === 0 && (
                <div className="mt-none">
                    <b>Конфигураций нейросети в таблице нет</b>
                    Все классы уходят по +1: класс — id + 1, суперкласс — № + 1.
                </div>
            )}
            {ids.map(id => {
                const o = override?.[id] ?? {};
                return (
                    <ModelSection
                        key={id}
                        kind={kind}
                        id={id}
                        model={catalog.find(m => m.id === id)}
                        value={value[id]}
                        override={override ? o : undefined}
                        dicts={dicts}
                        running={running.get(id)}
                        open={open.has(id)}
                        onToggle={() => toggle(id)}
                        onRemove={() => remove(id)}
                        onChange={v => onChange({ ...value, [id]: v }, override)}
                        onOverride={override ? v => onChange(value, put(override ?? {}, id, Object.keys(v).length ? v : undefined)) : undefined}
                    />
                );
            })}
            <div className="addline">
                <Icon name="plus" size={16} />
                Конфигурация нейросети
                {free.length > 0 ? (
                    <Select
                        value=""
                        placeholder="— выберите конфигурацию нейросети —"
                        options={free.map(m => {
                            const on = running.get(m.id);
                            return { value: m.id, label: m.name, hint: `${m.id} · ${on?.length ? `активна · ${on.join(', ')}` : 'не запущена'}`, dot: on?.length ? 'ok' : undefined };
                        })}
                        onChange={add}
                    />
                ) : (
                    <span className="note">{catalog.length ? 'все конфигурации плат уже в таблице' : 'конфигураций нейросети на платах в сети нет'}</span>
                )}
            </div>
        </Group>
    );
}

// ── Камеры ──

function RsmCamerasCard({ value, cameras, onChange }: { value: Record<string, number>; cameras: CameraRef[]; onChange: (v: Record<string, number>) => void }) {
    const used = new Set(Object.values(value));
    const assigned = Object.entries(value).sort((a, b) => a[1] - b[1]);
    const free = cameras.filter(c => !(c.id in value));
    const camera = (id: string) => cameras.find(c => c.id === id);
    const add = (id: string) => {
        const n = NUMBERS_1_8.find(b => !used.has(b));
        if (n) onChange({ ...value, [id]: n });
    };

    return (
        <Card title="Номера камер" meta={`${assigned.length} из 8`}>
            <div className="bitcards">
                {[...NUMBERS_1_8].reverse().map(n => {
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
                                            options={NUMBERS_1_8.filter(n => n === no || !used.has(n)).map(n => ({ value: String(n), label: `номер ${n}` }))}
                                            onChange={v => onChange({ ...value, [id]: Number(v) })}
                                        />
                                    </td>
                                    <td>
                                        <button type="button" className="x" aria-label="Убрать камеру" onClick={() => onChange(put(value, id, undefined))}>
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
                        onChange={add}
                    />
                ) : (
                    <span className="note">
                        {assigned.length >= 8 ? 'все восемь номеров заняты' : cameras.length === 0 ? 'камер технического зрения нет' : 'все камеры технического зрения добавлены'}
                    </span>
                )}
            </div>
        </Card>
    );
}

// Камеры Искры: бит маски записи 28163 → название и камера технического зрения
function IskraCamerasCard({ value, cameras, onChange }: { value: IskraCamera[]; cameras: CameraRef[]; onChange: (v: IskraCamera[]) => void }) {
    const set = (i: number, patch: Partial<IskraCamera>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    const freeBit = NUMBERS_1_8.find(b => !value.some(c => c.bit === b));
    const add = () => {
        if (freeBit) onChange([...value, { bit: freeBit, name: '', camera_id: '' }].sort((a, b) => a.bit - b.bit));
    };

    return (
        <Card title="Камеры Искры" meta={`${value.length} из 8`} className="mt-cams">
            <div className="mt-tab is-cams">
                <div className="mt-r is-head"><span>Бит</span><span>Название</span><span>Камера технического зрения</span><span /></div>
                {value.map((c, i) => {
                    const taken = new Set(value.filter((_, j) => j !== i).map(x => x.camera_id).filter(Boolean));
                    const cam = cameras.find(x => x.id === c.camera_id);
                    const options: SelectOption[] = [
                        { value: '', label: '— не назначена', muted: true },
                        ...cameras.filter(x => !taken.has(x.id)).map(x => ({ value: x.id, label: x.name, hint: x.device ? `${x.id} · ${x.device}` : x.id })),
                        ...(c.camera_id && !cam ? [{ value: c.camera_id, label: c.camera_id, hint: 'нет среди камер', muted: true }] : []),
                    ];
                    return (
                        <div key={c.bit} className="mt-r">
                            <span className="mt-bit">{c.bit}</span>
                            <input
                                className="inp inp--text"
                                aria-label="Название камеры Искры"
                                placeholder={`Камера ${c.bit}`}
                                value={c.name}
                                onChange={e => set(i, { name: e.target.value })}
                            />
                            <Select
                                value={c.camera_id}
                                options={options}
                                display={c.camera_id
                                    ? <>{cam?.name ?? c.camera_id}<small>{cam?.device ? `${c.camera_id} · ${cam.device}` : c.camera_id}</small></>
                                    : <span className="muted">— не назначена</span>}
                                onChange={camera_id => set(i, { camera_id })}
                            />
                            <button type="button" className="mt-x" aria-label="Убрать камеру" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                                <Icon name="x" size={13} />
                            </button>
                        </div>
                    );
                })}
                {value.length === 0 && <div className="mt-r"><span className="mt-wide">Камер нет — маска камер в записях пустая</span></div>}
            </div>
            <div className="tb-foot">
                <button type="button" className="cr-add" disabled={!freeBit} onClick={add}><Icon name="plus" size={11} />Камера</button>
                <span className="note">номер — бит маски камер в записи 28163</span>
            </div>
        </Card>
    );
}

// ── Таблицы ──

interface PanelProps<T> {
    value: T;
    onChange: (v: T) => void;
    dicts: Dictionaries;
    catalog: NeuralModel[];
    running: RunningMap;
    cameras: CameraRef[];
}

export function RsmTablePanel({ value, onChange, dicts, catalog, running, cameras }: PanelProps<RsmTable>) {
    return (
        <>
            <Group name="Камеры">
                <RsmCamerasCard value={value.cameras} cameras={cameras} onChange={v => onChange({ ...value, cameras: v })} />
            </Group>
            <ModelsGroup
                kind={RSM}
                value={value.models}
                override={value.danger_override}
                dicts={dicts}
                catalog={catalog}
                running={running}
                onChange={(models, override) => onChange({ ...value, models, danger_override: override ?? {} })}
            />
        </>
    );
}

export function IskraTablePanel({ value, onChange, dicts, catalog, running, cameras }: PanelProps<IskraTable>) {
    return (
        <>
            <Group name="Камеры">
                <IskraCamerasCard value={value.cameras} cameras={cameras} onChange={v => onChange({ ...value, cameras: v })} />
            </Group>
            <ModelsGroup kind={ISKRA} value={value.models} dicts={dicts} catalog={catalog} running={running} onChange={models => onChange({ ...value, models })} />
        </>
    );
}

// ── Словари ──

// Сколько строк таблицы берут число словаря: только добавленные конфигурации нейросети
export function tableUsage(table: RsmTable | IskraTable, catalog: NeuralModel[]): Record<string, Map<number, number>> {
    const kind = isIskraTable(table) ? ISKRA : RSM;
    const usage: Record<string, Map<number, number>> = {};
    const add = (key: string, n: number) => {
        if (!n) return;
        const m = (usage[key] ??= new Map());
        m.set(n, (m.get(n) ?? 0) + 1);
    };
    Object.entries(table.models).forEach(([id, t]) => {
        const model = catalog.find(m => m.id === id);
        model?.classes.forEach(c => add(kind.cls, autoNo(t.classes, c.id)));
        if (kind.sup) model?.superclasses.forEach((_, i) => add(kind.sup!, autoNo(t.superclasses, i)));
    });
    if (!isIskraTable(table)) Object.values(table.danger_override).forEach(o => Object.values(o).forEach(n => add('danger', n)));
    return usage;
}

// Ошибка, из-за которой настройки нельзя сохранить; пусто — можно
export function settingsError(dicts?: Dictionaries): string {
    const dup = Object.values(dicts ?? {}).some(rows => rows.some((r, i) => rows.slice(0, i).some(x => x.number === r.number)));
    return dup ? 'число в словаре повторяется' : '';
}

const validNumber = (text: string, max: number) => /^\d{1,5}$/.test(text) && Number(text) >= 1 && Number(text) <= max;

// Число словаря: текст правится свободно, в настройки уходит только разобранное
function DictNumber({ value, max, error, onChange }: { value: number; max: number; error: boolean; onChange: (v: number) => void }) {
    const [text, setText] = useState(String(value));
    useEffect(() => {
        if (Number(text) !== value) setText(String(value));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);
    const bad = !validNumber(text, max);
    return (
        <input
            className={`inp mt-dn${error || bad ? ' is-err' : ''}`}
            inputMode="numeric"
            aria-label="Число"
            data-tip={bad ? `Число от 1 до ${max}` : undefined}
            value={text}
            onChange={e => {
                setText(e.target.value);
                if (validNumber(e.target.value, max)) onChange(Number(e.target.value));
            }}
            onBlur={() => setText(String(value))}
        />
    );
}

function DictCard({ id, rows, changed, used, onChange }: {
    id: string;
    rows: DictEntry[];
    changed: boolean;
    used?: Map<number, number>;
    onChange: (v: DictEntry[]) => void;
}) {
    const m = meta(id);
    const set = (i: number, patch: Partial<DictEntry>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    const add = () => onChange([...rows, { number: Math.min(m.max, Math.max(0, ...rows.map(r => r.number)) + 1), name: '' }]);

    return (
        <section className="card tb-card mt-dict">
            <div className="card-h">
                <h3>{m.title}</h3>
                {m.proto && <span className="id">{m.proto}</span>}
                <span className={`tag${changed ? ' is-warn' : ''}`}>{changed ? 'изменён' : 'как в протоколе'}</span>
            </div>
            <div className="card-b">
                <div className="mt-d">
                    <div className="mt-dr is-head"><span>Число</span><span>Название</span><span>Строк</span><span /></div>
                    {rows.map((r, i) => {
                        const dup = rows.slice(0, i).find(x => x.number === r.number);
                        const n = used?.get(r.number) ?? 0;
                        return (
                            <div key={i} className="mt-dr">
                                <DictNumber value={r.number} max={m.max} error={!!dup} onChange={number => set(i, { number })} />
                                <input className="inp inp--text" aria-label="Название" value={r.name} onChange={e => set(i, { name: e.target.value })} />
                                <span className={`mt-use${n ? ' is-on' : ''}`}>{n || '—'}</span>
                                <button
                                    type="button"
                                    className="tb-x"
                                    aria-label="Удалить строку"
                                    data-tip={n ? `${n} стр. таблицы станут «нет в протоколе»` : undefined}
                                    onClick={() => onChange(rows.filter((_, j) => j !== i))}
                                >
                                    <Icon name="x" size={13} />
                                </button>
                                {dup && <span className="mt-msg">Число {r.number} уже у «{dup.name || 'без названия'}»</span>}
                            </div>
                        );
                    })}
                    {rows.length === 0 && <div className="mt-dr"><span className="mt-wide">Строк нет — все числа уходят пустыми</span></div>}
                </div>
                <div className="tb-foot">
                    <button type="button" className="cr-add" onClick={add}><Icon name="plus" size={11} />Строка</button>
                    <span className="note">0 — пусто, в словарь не входит</span>
                </div>
            </div>
        </section>
    );
}

export function DictionariesPanel({ value, defaults, usage, onChange }: {
    value: Dictionaries;
    defaults?: Dictionaries;
    usage: Record<string, Map<number, number>>;
    onChange: (v: Dictionaries) => void;
}) {
    const keys = Object.keys(value);
    return (
        <Group name="Словари протокола" n={keys.length}>
            <div className="mt-dicts">
                {keys.map(k => (
                    <DictCard
                        key={k}
                        id={k}
                        rows={value[k]}
                        changed={JSON.stringify(value[k]) !== JSON.stringify(defaults?.[k])}
                        used={usage[k]}
                        onChange={rows => onChange({ ...value, [k]: rows })}
                    />
                ))}
            </div>
        </Group>
    );
}
