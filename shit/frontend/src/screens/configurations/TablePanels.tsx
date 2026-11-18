import { useEffect, useState, type ReactNode } from 'react';
import { FitText } from '../../app/FitText';
import { Icon } from '../../app/Icons';
import { Select, type SelectOption } from '../../app/Select';
import { dictName, type DictEntry, type Dictionaries } from '../../features/krsps/utils/dictionaries';
import {
    configurationsApi,
    isIskraTable,
    isKztTable,
    type CfLink,
    type IskraCamera,
    type IskraTable,
    type KztTable,
    type ModelTable,
    type RsmTable,
    type RuleModbus,
    type RulesTable,
} from './api';
import { NumField, type CameraRef } from './RulesPanels';

// Конфигурация нейросети профиля: классы по id, суперклассы по месту в списке, зоны по приоритету
export interface NeuralModel {
    id: string;
    name: string;
    file?: string;
    sources?: { name: string; cameras: string[]; slot: string }[];
    classes: { id: number; name: string; superclass: string }[];
    superclasses: { key: string; name: string; color: string }[];
    zones: { id: number; name: string; color: string }[];
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
    attachment: { title: 'Код навесного', proto: 'пакет 1', max: 65535 },
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
// КЖТ: суперкласс — одно навесное, класс без суперкласса — навесное сам; классы суперкласса грузов — в слоты
const KZT: Kind = { cls: 'attachment', sup: 'attachment', of: 'КЖТ', empty: 'пусто · не уходит', zones: false };

// Грузы КЖТ в секции конфигурации: ключ суперкласса грузов и классы слов 18–20
interface KztCargo {
    superclass: string;
    slots: string[];
}

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
const zoneNo = (rec: Record<string, number>, id: number) => rec[String(id)] ?? id;
// Строки зон: каталог и «вне зон» (id 0); без каталога строк нет
const zoneIds = (model: NeuralModel) => (model.zones.length ? [...model.zones.map(z => z.id), 0] : []);

// Заданных строк и чисел вне словаря в секции
function sectionStats(kind: Kind, dicts: Dictionaries, model: NeuralModel | undefined, value: ModelTable, override?: Record<string, number>, kzt?: KztCargo) {
    const zones = value.zones ?? {};
    const set = Object.keys(value.classes).length + (kind.sup ? Object.keys(value.superclasses).length : 0)
        + (kind.zones ? Object.keys(zones).length : 0) + Object.keys(override ?? {}).length;
    const outside = (key: string, n: number) => n !== 0 && !dictName(dicts, key, n);
    // У КЖТ код класса с суперклассом не берётся, грузы кода не получают
    let off = model?.classes.filter(c => !(kzt && c.superclass) && outside(kind.cls, autoNo(value.classes, c.id))).length ?? 0;
    if (kind.sup && model) off += model.superclasses.filter((s, i) => s.key !== kzt?.superclass && outside(kind.sup!, autoNo(value.superclasses, i))).length;
    if (kind.zones && model) off += zoneIds(model).filter(id => outside('zone', zoneNo(zones, id))).length;
    return { set, off };
}

// Класс КЖТ с суперклассом: груз в слот или навесное по коду суперкласса
function KztClassRow({ cls, sc, code, kzt, dicts }: {
    cls: NeuralModel['classes'][number];
    sc: NeuralModel['superclasses'][number];
    code: number;
    kzt: KztCargo;
    dicts: Dictionaries;
}) {
    const cargo = sc.key === kzt.superclass;
    const slot = kzt.slots.indexOf(cls.name);
    const name = code ? dictName(dicts, 'attachment', code) : undefined;
    const outside = !cargo && !!code && !name;
    return (
        <div className={`mt-r has-out${outside ? ' is-off' : ''}`}>
            <span className="mt-id">{cls.id}</span>
            <span className="mt-name">
                <b><FitText text={cls.name} /></b>
                <span className="mt-sc"><i style={{ background: sc.color || NEUTRAL }} />{sc.name || sc.key}</span>
            </span>
            {cargo
                ? <span className="kz-cargo"><span className="tag is-ok">груз</span>{slot >= 0 ? `слово ${18 + slot}` : 'не в слотах'}</span>
                : <span className="kz-cargo"><span className="mt-from">↳</span>от суперкласса</span>}
            <span className="mt-ar"><Icon name="arr" size={14} /></span>
            <span className={`mt-outc${outside ? ' is-off' : ''}`}>
                <span className="mt-code">{cargo ? '—' : code || '—'}</span>
                <span className="mt-outt">
                    <b>{cargo ? 'Число в слоте' : outside ? 'Нет в протоколе' : name ?? KZT.empty}</b>
                    <small>{cargo ? (slot >= 0 ? 'считается, если допустим' : 'не уходит') : outside ? 'Код не принят АС КРСПС' : 'код навесного'}</small>
                </span>
            </span>
        </div>
    );
}

function ModelSection({ kind, id, model, value, override, kzt, dicts, running, passport, open, onToggle, onRemove, onChange, onOverride }: {
    kind: Kind;
    // Грузы КЖТ; у других правил нет
    kzt?: KztCargo;
    id: string;
    model?: NeuralModel;
    // Отличия паспорта у конфигурации или её соответствий; undefined — паспорта нет
    passport?: boolean;
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
    const { set, off } = sectionStats(kind, dicts, model, value, override, kzt);

    let body: ReactNode = null;
    if (open && !model) {
        body = <div className="mt-line">Конфигурации нет в профиле — заданные строки сохранены</div>;
    } else if (open && model) {
        const places = (key: string) => (kind.sup ? model.superclasses.findIndex(s => s.key === key) : -1);
        const zones = value.zones ?? {};
        body = (
            <>
                {!!model.sources?.length && <div className="lb-source-bindings">{model.sources.map(source => <span key={source.slot}><b>{source.name}</b><span>{source.cameras.join(', ') || 'Нет камер'}</span><code>слот {source.slot}</code></span>)}</div>}
                <div className="mt-blk">
                    <BlockHead name="Классы" n={model.classes.length} dict={kind.cls} />
                    <div className={`mt-tab${override ? ' has-over' : ''}`}>
                        <div className="mt-r has-out is-head">
                            <span>id</span><span>Класс нейросети</span><span>{meta(kind.cls).title}</span>
                            {override && <span>Опасность класса<em>правило РСМ</em></span>}
                            <span /><span>Уходит в АС КРСПС</span>
                        </div>
                        {model.classes.map(c => {
                            const own = value.classes[String(c.id)];
                            const place = places(c.superclass);
                            const sc = place >= 0 ? model.superclasses[place] : undefined;
                            if (kzt && sc) return <KztClassRow key={c.id} cls={c} sc={sc} code={autoNo(value.superclasses, place)} kzt={kzt} dicts={dicts} />;
                            const n = own ?? c.id + 1;
                            const danger = override?.[String(c.id)] ?? (sc ? autoNo(value.superclasses, place) : 0);
                            const code = n && dictName(dicts, kind.cls, n) ? n : 0;
                            const outside = !!n && !code;
                            const effectiveDanger = danger && kind.sup && dictName(dicts, kind.sup, danger) ? danger : 0;
                            return (
                                <div key={c.id} className={`mt-r has-out${outside ? ' is-off' : ''}`}>
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
                                    <span className="mt-ar"><Icon name="arr" size={14} /></span>
                                    <span className={`mt-outc${outside ? ' is-off' : ''}`}>
                                        <span className="mt-code">{outside ? n : code || '—'}</span>
                                        <span className="mt-outt">
                                            <b>{outside ? 'Нет в протоколе' : code ? dictName(dicts, kind.cls, code) : kind.empty}</b>
                                            {outside
                                                ? <small>Код не принят АС КРСПС</small>
                                                : kzt ? <small>{code ? 'код навесного' : 'нет кода в словаре'}</small>
                                                : kind.sup && <small>Опасность {effectiveDanger}{effectiveDanger ? ` · ${dictName(dicts, kind.sup, effectiveDanger)}` : ' · пусто'}</small>}
                                        </span>
                                    </span>
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
                                if (kzt && s.key === kzt.superclass) {
                                    return (
                                        <div key={s.key} className="mt-r">
                                            <span className="mt-id">{i}</span>
                                            <span className="mt-name">
                                                <span className="mt-sc is-main"><i style={{ background: s.color || NEUTRAL }} /><b>{s.name || s.key}</b></span>
                                                <small>{s.key}</small>
                                            </span>
                                            <span className="kz-cargo is-sc"><span className="tag is-ok">Грузы</span>в слова 18–20</span>
                                        </div>
                                    );
                                }
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
                {model.zones.length > 0 && (!kind.zones ? (
                    <div className="mt-line"><b>Зоны</b><span className="n">{model.zones.length}</span>правилами {kind.of} не используются</div>
                ) : (
                    <div className="mt-blk mt-zones">
                        <BlockHead name="Зоны" n={model.zones.length} dict="zone" />
                        <div className="mt-tab">
                            <div className="mt-r has-out is-head"><span>id</span><span>Зона</span><span>Номер в записи</span><span /><span>Уходит в АС КРСПС</span></div>
                            {[...model.zones, { id: 0, name: 'Вне зон', color: '' }].map(z => {
                                const own = zones[String(z.id)];
                                const n = own ?? z.id;
                                const outside = !!n && !dictName(dicts, 'zone', n);
                                return (
                                    <div key={z.id} className={`mt-r has-out${z.id ? '' : ' is-out'}${outside ? ' is-off' : ''}`}>
                                        <span className="mt-id">{z.id}</span>
                                        <span className="mt-name">
                                            <b>
                                                {z.id > 0 && <i className="zone-g" style={{ '--z': z.color || NEUTRAL } as React.CSSProperties} />}
                                                <FitText text={z.name} />
                                            </b>
                                        </span>
                                        <NumberSelect
                                            entries={dicts.zone ?? []}
                                            value={own}
                                            auto={z.id}
                                            autoLabel="По умолчанию · id"
                                            autoMark={<span className="mt-plus">{z.id ? 'id' : '0'}</span>}
                                            empty="пусто"
                                            onChange={v => onChange({ ...value, zones: put(zones, String(z.id), v) })}
                                        />
                                        <span className="mt-ar"><Icon name="arr" size={14} /></span>
                                        <span className={`mt-outc${outside ? ' is-off' : ''}`}>
                                            <span className="mt-code">{n || '—'}</span>
                                            <span className="mt-outt">
                                                <b>{outside ? 'Нет в протоколе' : n ? dictName(dicts, 'zone', n) : 'пусто'}</b>
                                                {outside && <small>Код не принят АС КРСПС</small>}
                                            </span>
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
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
                {model?.file && <span className="tag">{model.file}</span>}
                {passport !== undefined && (passport ? <span className="tag is-pass">Есть отличия паспорта</span> : <span className="tag">Как в профиле</span>)}
                {running !== undefined && <Running devices={running} />}
                <span className="mt-sum">
                    {!model && <span className="tag is-warn">нет в профиле</span>}
                    {set ? <span className="tag is-acc">задано {set}</span> : <span className="tag">по умолчанию</span>}
                    {off > 0 && <span className="tag is-warn">нет в протоколе {off}</span>}
                </span>
                <button
                    type="button"
                    className="mt-x"
                    aria-label="Сбросить соответствия конфигурации"
                    data-tip="Восстановить автоматические соответствия"
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

// Каталог профиля и сохранённые соответствия отсутствующих конфигураций
function ModelsGroup({ kind, value, override, kzt, dicts, catalog, running, passportIds, onChange }: {
    kind: Kind;
    kzt?: KztCargo;
    value: Record<string, ModelTable>;
    override?: Record<string, Record<string, number>>;
    dicts: Dictionaries;
    catalog: NeuralModel[];
    running: RunningMap;
    passportIds?: Set<string>;
    onChange: (models: Record<string, ModelTable>, override?: Record<string, Record<string, number>>) => void;
}) {
    const ids = [...new Set([...catalog.map(model => model.id), ...Object.keys(value), ...Object.keys(override ?? {})])];
    const [open, setOpen] = useState<Set<string>>(() => new Set(ids.slice(0, 1)));
    const toggle = (id: string) => setOpen(s => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });
    const remove = (id: string) => onChange(put(value, id, undefined), override && put(override, id, undefined));

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
                        value={value[id] ?? { classes: {}, superclasses: {}, zones: {} }}
                        override={override ? o : undefined}
                        kzt={kzt}
                        dicts={dicts}
                        running={running.get(id)}
                        passport={passportIds ? passportIds.has(id) : undefined}
                        open={open.has(id)}
                        onToggle={() => toggle(id)}
                        onRemove={() => remove(id)}
                        onChange={v => onChange({ ...value, [id]: v }, override)}
                        onOverride={override ? v => onChange(value, put(override ?? {}, id, Object.keys(v).length ? v : undefined)) : undefined}
                    />
                );
            })}
        </Group>
    );
}

// ── Камеры ──

function RsmCamerasCard({ value, cameras, onChange }: { value: Record<string, number>; cameras: CameraRef[]; onChange: (v: Record<string, number>) => void }) {
    const used = new Set(Object.values(value));
    const ids = [...new Set([...cameras.map(camera => camera.id), ...Object.keys(value)])];

    return (
        <Card title="Номера камер для АС КРСПС" meta="Из камер профиля">
            <div className="gt">
                <table className="spec">
                    <thead><tr><th>Камера технического зрения</th><th>Идентификатор</th><th style={{ width: 220 }}>Номер в протоколе</th></tr></thead>
                    <tbody>
                        {ids.map(id => {
                            const cam = cameras.find(camera => camera.id === id);
                            const no = value[id] ?? 0;
                            return (
                                <tr key={id}>
                                    <td className="cam"><b>{cam?.name ?? id}</b>{!cam && <small>Нет в профиле</small>}</td>
                                    <td>{id}</td>
                                    <td>
                                        <Select
                                            value={String(no)}
                                            options={[{ value: '0', label: 'Не назначена' }, ...NUMBERS_1_8.filter(n => n === no || !used.has(n)).map(n => ({ value: String(n), label: `Номер ${n}` }))]}
                                            onChange={v => onChange(put(value, id, v === '0' ? undefined : Number(v)))}
                                        />
                                    </td>
                                </tr>
                            );
                        })}
                        {ids.length === 0 && <tr><td colSpan={3} className="dim">Камер технического зрения нет</td></tr>}
                    </tbody>
                </table>
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
    passportIds?: Set<string>;
}

export function RsmTablePanel({ value, onChange, dicts, catalog, running, cameras, passportIds }: PanelProps<RsmTable>) {
    return (
        <>
            <ModelsGroup
                kind={RSM}
                value={value.models}
                override={value.danger_override}
                dicts={dicts}
                catalog={catalog}
                running={running}
                passportIds={passportIds}
                onChange={(models, override) => onChange({ ...value, models, danger_override: override ?? {} })}
            />
            <RsmCamerasCard value={value.cameras} cameras={cameras} onChange={v => onChange({ ...value, cameras: v })} />
        </>
    );
}

export function IskraTablePanel({ value, onChange, dicts, catalog, running, cameras, passportIds }: PanelProps<IskraTable>) {
    return (
        <>
            <ModelsGroup kind={ISKRA} value={value.models} dicts={dicts} catalog={catalog} running={running} passportIds={passportIds} onChange={models => onChange({ ...value, models })} />
            <IskraCamerasCard value={value.cameras} cameras={cameras} onChange={v => onChange({ ...value, cameras: v })} />
        </>
    );
}

// ── КЖТ ──

// Коды навесного строк таблицы: классы без суперкласса и суперклассы кроме грузов, с повторами
function kztCodes(table: KztTable, catalog: NeuralModel[]): number[] {
    const codes: number[] = [];
    [...new Set([...catalog.map(model => model.id), ...Object.keys(table.models)])].forEach(id => {
        const t = table.models[id] ?? { classes: {}, superclasses: {} };
        const model = catalog.find(m => m.id === id);
        model?.classes.filter(c => !c.superclass).forEach(c => codes.push(autoNo(t.classes, c.id)));
        model?.superclasses.forEach((s, i) => {
            if (s.key !== table.cargo_superclass) codes.push(autoNo(t.superclasses, i));
        });
    });
    return codes;
}

// Значения каталога профиля без повторов по ключу
function uniqueBy<T>(items: T[], key: (item: T) => string | number): T[] {
    const seen = new Set<string | number>();
    return items.filter(item => !seen.has(key(item)) && !!seen.add(key(item)));
}

function KztCard({ value, modbus, catalog, cameras, onChange, onModbus }: {
    value: KztTable;
    modbus: RuleModbus;
    catalog: NeuralModel[];
    cameras: CameraRef[];
    onChange: (v: KztTable) => void;
    onModbus: (v: RuleModbus) => void;
}) {
    const zones = uniqueBy(catalog.flatMap(m => m.zones), z => z.id);
    const superclasses = uniqueBy(catalog.flatMap(m => m.superclasses), s => s.key);
    const cam = cameras.find(c => c.id === value.camera_id);
    const zone = zones.find(z => z.id === value.zone_id);
    const sc = superclasses.find(s => s.key === value.cargo_superclass);
    return (
        <section className={`card cr-card kz-card${modbus.enabled ? '' : ' is-off'}`}>
            <div className="card-h">
                <h3>Состав КЖТ</h3>
                <span className="id">пакет 1</span>
                <button type="button" className={`sw${modbus.enabled ? ' is-on' : ''}`} onClick={() => onModbus({ ...modbus, enabled: !modbus.enabled })}>
                    <i />Modbus
                </button>
            </div>
            <div className="card-b">
                <div className="cr-row">
                    <label>Камера</label>
                    <Select
                        value={value.camera_id}
                        options={[
                            { value: '', label: 'Все камеры', hint: 'камера не выбрана' },
                            ...cameras.map(c => ({ value: c.id, label: c.name, hint: c.device ? `${c.id} · ${c.device}` : c.id })),
                            ...(value.camera_id && !cam ? [{ value: value.camera_id, label: value.camera_id, hint: 'нет среди камер', muted: true }] : []),
                        ]}
                        display={value.camera_id ? <>{cam?.name ?? value.camera_id}<small>{cam?.device || value.camera_id}</small></> : 'Все камеры'}
                        onChange={camera_id => onChange({ ...value, camera_id })}
                    />
                </div>
                <div className="cr-row">
                    <label>Рабочая зона</label>
                    <Select
                        value={value.zone_id === null ? '' : String(value.zone_id)}
                        options={[
                            { value: '', label: 'Весь кадр', hint: 'зона не выбрана' },
                            ...zones.map(z => ({ value: String(z.id), label: z.name, hint: `id ${z.id}` })),
                            ...(value.zone_id !== null && !zone ? [{ value: String(value.zone_id), label: `Зона ${value.zone_id}`, hint: 'нет в каталоге', muted: true }] : []),
                        ]}
                        display={value.zone_id === null ? 'Весь кадр' : <>{zone?.name ?? `Зона ${value.zone_id}`}<small>id {value.zone_id}</small></>}
                        onChange={v => onChange({ ...value, zone_id: v === '' ? null : Number(v) })}
                    />
                </div>
                <div className="cr-row">
                    <label>Суперкласс грузов</label>
                    <Select
                        value={value.cargo_superclass}
                        options={[
                            { value: '', label: 'Не выбран', hint: 'всё — навесное' },
                            ...superclasses.map(s => ({ value: s.key, label: s.name || s.key, hint: s.key, color: s.color || undefined })),
                            ...(value.cargo_superclass && !sc ? [{ value: value.cargo_superclass, label: value.cargo_superclass, hint: 'нет в конфигурациях', muted: true }] : []),
                        ]}
                        display={value.cargo_superclass ? <>{sc?.name || value.cargo_superclass}<small>{value.cargo_superclass}</small></> : 'Не выбран'}
                        onChange={cargo_superclass => onChange({ ...value, cargo_superclass })}
                    />
                </div>
                {!value.cargo_superclass && <div className="kz-warn">Без суперкласса грузов все классы считаются навесным, слова 18–20 — нули</div>}
                <div className="cr-row"><label>Повтор пакета</label><NumField value={modbus.period_s ?? 60} unit="с" onChange={period_s => onModbus({ ...modbus, period_s })} /></div>
                <div className="cr-row" data-tip="Шлюз: нейросеть и камера КЖТ в порядке"><label>Флаг работы в 0</label><div className="tf-ro">после 300 с сбоя</div></div>
            </div>
        </section>
    );
}

const LINK_POLL_MS = 3000;

// Последний состав, отправленный мастером: лента /api/configurations/link
function KztPacketCard({ value, dicts }: { value: KztTable; dicts: Dictionaries }) {
    const [link, setLink] = useState<CfLink | null | undefined>(undefined);
    useEffect(() => {
        let alive = true;
        const load = () => configurationsApi.link().then(l => alive && setLink(l)).catch(() => alive && setLink(null));
        load();
        const timer = window.setInterval(load, LINK_POLL_MS);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, []);
    const entry = link?.feed.find(e => e.module === 'modbus' && e.event === 'state');

    let body: ReactNode;
    if (link === undefined) body = <div className="kz-none">Загрузка…</div>;
    else if (link === null) body = <div className="kz-none">Мастер обнаружений недоступен</div>;
    else if (link.rules !== 'kzt') body = <div className="kz-none">Мастер работает не по правилам КЖТ</div>;
    else if (!entry) body = <div className="kz-none">Мастер ещё не отправлял состав</div>;
    else {
        const att = entry.attachments ?? [];
        const cargo = entry.cargo ?? [];
        body = (
            <>
                <div className="kz-words">
                    {[0, 1, 2].map(i => (
                        <div key={`a${i}`} className="kz-w is-att">
                            <span className="r">{15 + i}</span>
                            <span className="v">{att[i] ?? 0}</span>
                            <span className="l">{att[i] ? <b>{dictName(dicts, 'attachment', att[i]) ?? 'нет в словаре'}</b> : 'навесное'}</span>
                        </div>
                    ))}
                    {[0, 1, 2].map(i => (
                        <div key={`c${i}`} className={`kz-w is-cargo${cargo[i] ? ' has' : ''}`}>
                            <span className="r">{18 + i}</span>
                            <span className="v">{cargo[i] ?? 0}</span>
                            <span className="l">{value.cargo[i] || '—'}</span>
                        </div>
                    ))}
                </div>
                <div className="kz-meta">
                    <span>Отправлен <b>{new Date(entry.t).toLocaleTimeString('ru-RU', { hour12: false })}</b></span>
                    <span>Новый пакет — при смене состава</span>
                    <span>Флаг работы ставит шлюз — страница «АС КРСПС»</span>
                </div>
            </>
        );
    }
    return (
        <section className="card cr-card kz-pkt">
            <div className="card-h"><h3>Пакет сейчас</h3><span className="id">слова 15–20</span></div>
            <div className="card-b">{body}</div>
        </section>
    );
}

function KztSlotsCard({ value, cargo, onChange }: { value: KztTable; cargo: string[]; onChange: (v: KztTable) => void }) {
    const slots = [0, 1, 2].map(i => value.cargo[i] ?? '');
    return (
        <Card title="Слоты грузов" meta="слова 18–20">
            <div className="kz-slots">
                {slots.map((name, i) => (
                    <div key={i} className="kz-slot">
                        <div className="kz-slot-h"><b>{18 + i}</b>слово пакета</div>
                        <Select
                            value={name}
                            options={[
                                { value: '', label: '— пусто', hint: 'слово всегда 0' },
                                ...cargo.map(c => ({ value: c, label: c })),
                                ...(name && !cargo.includes(name) ? [{ value: name, label: name, hint: 'не груз', muted: true }] : []),
                            ]}
                            display={!name ? <span className="mt-empty">— пусто</span> : cargo.includes(name) ? name : <span className="tag is-warn">{name} · не груз</span>}
                            onChange={v => onChange({ ...value, cargo: slots.map((s, j) => (j === i ? v : s)) })}
                        />
                    </div>
                ))}
            </div>
        </Card>
    );
}

// Допустимые грузы матрицей: строки — коды навесного, столбцы — грузы; строки нет — любые
function KztAllowedCard({ value, cargo, codes, dicts, onChange }: {
    value: KztTable;
    cargo: string[];
    codes: number[];
    dicts: Dictionaries;
    onChange: (v: KztTable) => void;
}) {
    const setRule = (code: number, rule: string[] | undefined) => onChange({ ...value, allowed: put(value.allowed, String(code), rule) });
    // Строка без ограничения: клик разрешает только этот груз
    const toggle = (code: number, name: string) => {
        const rule = value.allowed[String(code)];
        setRule(code, !rule ? [name] : rule.includes(name) ? rule.filter(x => x !== name) : [...rule, name]);
    };
    return (
        <Card title="Допустимые грузы" meta="по коду навесного">
            {cargo.length === 0 ? (
                <div className="mt-none"><b>Грузов нет</b>Выберите суперкласс грузов в карточке «Состав КЖТ».</div>
            ) : (
                <div className="kz-mx">
                    <table>
                        <thead>
                            <tr><th className="att">Навесное</th><th>Ограничение</th>{cargo.map(c => <th key={c}>{c}</th>)}</tr>
                        </thead>
                        <tbody>
                            {codes.map(code => {
                                const rule = value.allowed[String(code)];
                                return (
                                    <tr key={code} className={rule ? '' : 'is-free'}>
                                        <td className="att"><span className="k">{code}</span>{dictName(dicts, 'attachment', code) ?? <span className="tag is-warn">нет в словаре</span>}</td>
                                        <td className="mode">
                                            <button
                                                type="button"
                                                className={`kz-mode${rule ? ' is-set' : ''}`}
                                                data-tip={rule ? 'Снять ограничение' : 'Ограничить: ни один груз не допустим'}
                                                onClick={() => setRule(code, rule ? undefined : [])}
                                            >
                                                {rule ? `${rule.filter(r => cargo.includes(r)).length} из ${cargo.length}` : 'Любые грузы'}
                                            </button>
                                        </td>
                                        {cargo.map(c => (
                                            <td key={c}>
                                                <button type="button" className={`kz-cb${rule?.includes(c) ? ' is-on' : ''}`} aria-label={c} onClick={() => toggle(code, c)}>
                                                    <Icon name="check" size={13} />
                                                </button>
                                            </td>
                                        ))}
                                    </tr>
                                );
                            })}
                            {codes.length === 0 && <tr><td className="att" colSpan={cargo.length + 2}>Кодов навесного в таблице нет</td></tr>}
                        </tbody>
                    </table>
                </div>
            )}
            <div className="tb-foot"><span className="note">«Любые грузы» — строки в таблице нет. Ограничение действует, пока навесное в составе пакета.</span></div>
        </Card>
    );
}

export function KztTablePanel({ value, onChange, dicts, catalog, running, cameras, passportIds, modbus, onModbus }: PanelProps<KztTable> & {
    modbus: RuleModbus;
    onModbus: (v: RuleModbus) => void;
}) {
    const cargo = value.cargo_superclass
        ? [...new Set(catalog.flatMap(m => m.classes.filter(c => c.superclass === value.cargo_superclass).map(c => c.name)))]
        : [];
    const codes = [...new Set([...kztCodes(value, catalog), ...Object.keys(value.allowed).map(Number)])]
        .filter(n => n && (dictName(dicts, 'attachment', n) || value.allowed[String(n)]))
        .sort((a, b) => a - b);
    return (
        <>
            <div className="kz-top">
                <KztCard value={value} modbus={modbus} catalog={catalog} cameras={cameras} onChange={onChange} onModbus={onModbus} />
                <KztPacketCard value={value} dicts={dicts} />
            </div>
            <ModelsGroup
                kind={KZT}
                kzt={{ superclass: value.cargo_superclass, slots: value.cargo }}
                value={value.models}
                dicts={dicts}
                catalog={catalog}
                running={running}
                passportIds={passportIds}
                onChange={models => onChange({ ...value, models })}
            />
            <KztSlotsCard value={value} cargo={cargo} onChange={onChange} />
            <KztAllowedCard value={value} cargo={cargo} codes={codes} dicts={dicts} onChange={onChange} />
        </>
    );
}

// ── Словари ──

// Числа словаря в явных и автоматических соответствиях конфигураций профиля
export function tableUsage(table: RulesTable, catalog: NeuralModel[]): Record<string, Map<number, number>> {
    const usage: Record<string, Map<number, number>> = {};
    const add = (key: string, n: number) => {
        if (!n) return;
        const m = (usage[key] ??= new Map());
        m.set(n, (m.get(n) ?? 0) + 1);
    };
    if (isKztTable(table)) {
        kztCodes(table, catalog).forEach(n => add('attachment', n));
        return usage;
    }
    const kind = isIskraTable(table) ? ISKRA : RSM;
    [...new Set([...catalog.map(model => model.id), ...Object.keys(table.models)])].forEach(id => {
        const t = table.models[id] ?? { classes: {}, superclasses: {}, zones: {} };
        const model = catalog.find(m => m.id === id);
        model?.classes.forEach(c => add(kind.cls, autoNo(t.classes, c.id)));
        if (kind.sup) model?.superclasses.forEach((_, i) => add(kind.sup!, autoNo(t.superclasses, i)));
        if (kind.zones && model) zoneIds(model).forEach(z => add('zone', zoneNo(t.zones ?? {}, z)));
    });
    if (!isIskraTable(table)) Object.values(table.danger_override).forEach(o => Object.values(o).forEach(n => add('danger', n)));
    return usage;
}

// Ошибка, из-за которой настройки нельзя сохранить; пусто — можно
export function settingsError(dicts?: Dictionaries): string {
    const dup = Object.values(dicts ?? {}).some(rows => rows.some((r, i) => rows.slice(0, i).some(x => x.number === r.number)));
    if (dup) return 'число в словаре повторяется';
    for (const [key, rows] of Object.entries(dicts ?? {})) {
        if (rows.some(row => !Number.isInteger(row.number) || row.number < 1 || row.number > meta(key).max)) return `число должно быть от 1 до ${meta(key).max}`;
        if (rows.some(row => !row.name.trim())) return 'укажите название значения словаря';
    }
    return '';
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
                <span className={`tag${changed ? ' is-warn' : ''}`}>{changed ? 'изменён' : 'как в профиле'}</span>
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
        <Group name="Словари профиля" n={keys.length}>
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
