import { useEffect, useState } from 'react';
import { Icon } from '../../app/Icons';
import { Modal } from '../../app/Modal';
import type { CfRules, FeedEntry, FeedStatus, RuleClassFilter, RuleModbus, RuleStitch } from './api';

export const MODULE_SHORT: Record<string, string> = { websocket: 'ЦПУ', can: 'CAN', modbus: 'Modbus' };

// Коды записи 28163 Искры
export const ISKRA_CODES = [
    'человек, СИЗ не распознан', 'в СИЗ', 'без СИЗа', 'легковая', 'грузовая', 'строительная техника',
    'сыпучие отходы', 'твёрдые отходы', 'шпала (мусор)', 'граффити', 'борщевик',
];
// Роли камер Искры: номер — бит маски камер
export const ROLES = [
    { value: 1, label: 'Дальняя' },
    { value: 2, label: 'Ближняя' },
    { value: 3, label: 'Левая' },
    { value: 4, label: 'Правая' },
];

export interface ClassCatalog {
    superclasses: { key: string; name: string; count: number; color: string }[];
    classes: { name: string; superclass: string }[];
}

export interface CameraRef {
    id: string;
    name: string;
    device: string;
}

// Число отличающихся значений настроек
export function countDiff(a: unknown, b: unknown): number {
    const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (plain(a) && plain(b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        let n = 0;
        keys.forEach(k => { n += countDiff(a[k], b[k]); });
        return n;
    }
    return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
}

const fmtNum = (v: number) => String(v).replace('.', ',');

function parseNum(text: string): number | null {
    const n = Number(text.replace(',', '.').trim());
    return text.trim() !== '' && Number.isFinite(n) ? n : null;
}

// Число с единицей: текст правится свободно, в настройки уходит только разобранное
function NumField({ value, unit, onChange }: { value: number; unit: string; onChange: (v: number) => void }) {
    const [text, setText] = useState(fmtNum(value));
    useEffect(() => {
        if (parseNum(text) !== value) setText(fmtNum(value));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);
    return (
        <div className="tf tf-unit">
            <input
                className={`tf-in${parseNum(text) === null ? ' is-err' : ''}`}
                inputMode="decimal"
                value={text}
                onChange={e => {
                    setText(e.target.value);
                    const n = parseNum(e.target.value);
                    if (n !== null) onChange(n);
                }}
            />
            <span className="u">{unit}</span>
        </div>
    );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
    return (
        <button type="button" className={`sw${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}>
            <i />Включено
        </button>
    );
}

export function StitchCard({ value, onChange }: { value: RuleStitch; onChange: (v: RuleStitch) => void }) {
    return (
        <section className="card cr-card">
            <div className="card-h"><h3>Сшивка обрывков</h3><span className="eyebrow">та же камера</span></div>
            <div className="card-b">
                <div className="cr-row"><label>Пауза</label><NumField value={value.gap_s} unit="с" onChange={gap_s => onChange({ ...value, gap_s })} /></div>
                <div className="cr-row"><label>Расстояние</label><NumField value={value.distance} unit="диаг" onChange={distance => onChange({ ...value, distance })} /></div>
            </div>
        </section>
    );
}

export function MasterEnvCard({ env }: { env: CfRules['env'] }) {
    return (
        <section className="card cr-card">
            <div className="card-h"><h3>Мастер</h3><span className="eyebrow">окружение</span></div>
            <div className="card-b">
                <div className="cr-row"><label>Опоздание пакета</label><div className="tf-ro">{fmtNum(env.late_s)} с</div></div>
                <div className="cr-row"><label>Тишина камеры</label><div className="tf-ro">{fmtNum(env.silence_s)} с</div></div>
                <div className="cr-row"><label>Обрыв связи</label><div className="tf-ro">{fmtNum(env.link_lost_s)} с</div></div>
            </div>
        </section>
    );
}

interface ModuleHead {
    id: string;
    dot: string;
    detail: string;
}

function CardHead({ head, on, onToggle }: { head: ModuleHead; on: boolean; onToggle: (v: boolean) => void }) {
    return (
        <div className="card-h">
            <i className={`dot ${head.dot}`} />
            <h3>{MODULE_SHORT[head.id] ?? head.id}</h3>
            {head.detail && <span className="id">{head.detail}</span>}
            <Switch on={on} onChange={onToggle} />
        </div>
    );
}

// Каталог не пришёл — про пропавшие имена сказать нечего
export const missing = (name: string, catalog: ClassCatalog) =>
    catalog.classes.length > 0 && !catalog.classes.some(c => c.name === name) && !catalog.superclasses.some(s => s.key === name);

function classLabel(name: string, catalog: ClassCatalog): { label: string; superclass: boolean; known: boolean } {
    const sc = catalog.superclasses.find(s => s.key === name);
    if (sc) return { label: sc.name, superclass: true, known: true };
    return { label: name, superclass: false, known: !missing(name, catalog) };
}

function ClassRows({ value, onChange, catalog, onPick }: {
    value: RuleClassFilter;
    onChange: (v: RuleClassFilter) => void;
    catalog: ClassCatalog;
    onPick: () => void;
}) {
    return (
        <div className="cr-row">
            <label>Классы</label>
            <div className="seg seg--xs">
                <button type="button" className={value.classes_all ? 'is-on' : ''} onClick={() => onChange({ ...value, classes_all: true })}>Все</button>
                <button type="button" className={value.classes_all ? '' : 'is-on'} onClick={() => onChange({ ...value, classes_all: false })}>Выбранные</button>
            </div>
            {!value.classes_all && (
                <div className="cr-chips">
                    {value.classes.map(name => {
                        const c = classLabel(name, catalog);
                        return (
                            <span key={name} className={`tag${c.superclass ? ' is-acc' : ''}${c.known ? '' : ' is-gone'}`} data-tip={c.known ? undefined : 'Нет в нейросетях устройств'}>
                                <b>{c.label}</b>
                                {c.superclass && <small>суперкласс</small>}
                                <button type="button" className="x" aria-label="Убрать" onClick={() => onChange({ ...value, classes: value.classes.filter(n => n !== name) })}>
                                    <Icon name="x" size={9} />
                                </button>
                            </span>
                        );
                    })}
                    <button type="button" className="cr-add" onClick={onPick}><Icon name="plus" size={11} />Класс</button>
                </div>
            )}
        </div>
    );
}

export function WebSocketCard({ head, value, onChange, catalog, onPick }: {
    head: ModuleHead;
    value: RuleClassFilter & { late_s: number };
    onChange: (v: RuleClassFilter & { late_s: number }) => void;
    catalog: ClassCatalog;
    onPick: () => void;
}) {
    return (
        <section className={`card cr-card${value.enabled ? '' : ' is-off'}`}>
            <CardHead head={head} on={value.enabled} onToggle={enabled => onChange({ ...value, enabled })} />
            <div className="card-b">
                <ClassRows value={value} onChange={v => onChange({ ...value, ...v })} catalog={catalog} onPick={onPick} />
                <div className="cr-row"><label>Предел опоздания кадра</label><NumField value={value.late_s} unit="с" onChange={late_s => onChange({ ...value, late_s })} /></div>
            </div>
        </section>
    );
}

export function CanCard({ head, value, onChange, catalog, onPick }: {
    head: ModuleHead;
    value: RuleClassFilter;
    onChange: (v: RuleClassFilter) => void;
    catalog: ClassCatalog;
    onPick: () => void;
}) {
    return (
        <section className={`card cr-card${value.enabled ? '' : ' is-off'}`}>
            <CardHead head={head} on={value.enabled} onToggle={enabled => onChange({ ...value, enabled })} />
            <div className="card-b">
                <ClassRows value={value} onChange={onChange} catalog={catalog} onPick={onPick} />
            </div>
        </section>
    );
}

export function ModbusCard({ head, value, zone, onChange, onOpenTable }: {
    head: ModuleHead;
    value: RuleModbus;
    zone: string;
    onChange: (v: RuleModbus) => void;
    onOpenTable: () => void;
}) {
    return (
        <section className={`card cr-card${value.enabled ? '' : ' is-off'}`}>
            <CardHead head={head} on={value.enabled} onToggle={enabled => onChange({ ...value, enabled })} />
            <div className="card-b">
                <div className="cr-row"><label>Запись не позже</label><NumField value={value.ceiling_s} unit="с" onChange={ceiling_s => onChange({ ...value, ceiling_s })} /></div>
                <div className="cr-row">
                    <label>Зона по умолчанию</label>
                    <div className="tf-ro"><button type="button" className="cr-link" onClick={onOpenTable}>{zone}<Icon name="tune" size={13} /></button></div>
                </div>
                <div className="cr-row"><label>Число объектов</label><div className="tf-ro">1</div></div>
            </div>
        </section>
    );
}

// Окно выбора классов модуля: суперклассы и классы всех нейросетей
export function ClassPicker({ title, value, catalog, onDone, onClose }: {
    title: string;
    value: string[];
    catalog: ClassCatalog;
    onDone: (v: string[]) => void;
    onClose: () => void;
}) {
    const [sel, setSel] = useState<string[]>(value);
    const toggle = (name: string) => setSel(s => (s.includes(name) ? s.filter(n => n !== name) : [...s, name]));
    const extra = sel.filter(n => !catalog.superclasses.some(s => s.key === n) && !catalog.classes.some(c => c.name === n));
    const scCount = sel.filter(n => catalog.superclasses.some(s => s.key === n)).length;
    const scName = (key: string) => catalog.superclasses.find(s => s.key === key)?.name ?? key;
    return (
        <Modal
            title={title}
            onClose={onClose}
            footer={
                <>
                    <span className="seps cr-pick-sum"><span>суперклассов {scCount}</span><span>классов {sel.length - scCount}</span></span>
                    <span className="spacer" />
                    <button className="btn btn--ghost" onClick={onClose}>Отмена</button>
                    <button className="btn btn--acc" onClick={() => onDone(sel)}>Готово</button>
                </>
            }
        >
            <div className="modal-b cr-cls">
                <span className="eyebrow">Суперклассы</span>
                <div className="cr-cls-g">
                    {catalog.superclasses.length === 0 && <span className="cr-none">Нет</span>}
                    {catalog.superclasses.map(s => (
                        <button key={s.key} type="button" className={`tag${sel.includes(s.key) ? ' is-acc' : ''}`} onClick={() => toggle(s.key)}>
                            <b>{s.name}</b><small>{s.count}</small>
                        </button>
                    ))}
                </div>
                <span className="eyebrow">Классы</span>
                <div className="cr-cls-g">
                    {catalog.classes.map(c => (
                        <button key={c.name} type="button" className={`tag${sel.includes(c.name) ? ' is-acc' : ''}`} onClick={() => toggle(c.name)}>
                            <b>{c.name}</b>{c.superclass && <small>{scName(c.superclass)}</small>}
                        </button>
                    ))}
                    {extra.map(n => (
                        <button key={n} type="button" className={`tag is-acc${missing(n, catalog) ? ' is-gone' : ''}`} onClick={() => toggle(n)}>
                            <b>{n}</b>{missing(n, catalog) && <small>нет в нейросетях</small>}
                        </button>
                    ))}
                </div>
            </div>
        </Modal>
    );
}

// ── Лента отправленного ──

const STATUS: Record<FeedStatus, { label: string; dot: string; err?: boolean }> = {
    new: { label: 'ждёт ответа', dot: 'warn' },
    sent: { label: 'ждёт ответа', dot: 'warn' },
    accepted: { label: 'принято', dot: 'ok' },
    rejected: { label: 'отклонено', dot: 'err', err: true },
    dropped: { label: 'не ушло', dot: 'err', err: true },
    late: { label: 'опоздал', dot: 'err', err: true },
};

function Answer({ e }: { e: FeedEntry }) {
    const s = STATUS[e.status] ?? STATUS.new;
    const label = e.module === 'modbus' && e.status === 'accepted' ? 'в очереди' : s.label;
    return <span className={`cr-ans${s.err ? ' is-err' : ''}`}><i className={`dot ${s.dot}`} />{label}</span>;
}

function Event({ e }: { e: FeedEntry }) {
    if (e.event === 'confirmed') return <span className="tag is-ok">Подтверждён</span>;
    if (e.event === 'removed') return <span className="tag">Удалён</span>;
    return <span className="tag is-acc">Запись</span>;
}

const time = (t: number) => new Date(t).toLocaleTimeString('ru-RU', { hour12: false });
const conf = (e: FeedEntry) => (e.confidence !== undefined ? <span className="cf">{e.confidence.toFixed(2).replace('.', ',')}</span> : null);
const ids = (e: FeedEntry) => (e.more?.length ? `${e.detection_id} +${e.more.length}` : String(e.detection_id));

function roleNames(mask?: number): string {
    const names = ROLES.filter(r => mask && mask & (1 << (r.value - 1))).map(r => r.label.toLowerCase());
    return names.length ? names.join(', ') : '—';
}

export function FeedTable({ node, entries, cameraName }: { node: string; entries: FeedEntry[]; cameraName: (id: string) => string }) {
    const rows = node === 'master' ? entries : entries.filter(e => e.module === node);
    if (rows.length === 0) return <div className="cr-feed cr-feed-empty">Сообщений нет</div>;
    const head = (cols: [string, string][]) => (
        <>
            <colgroup>{cols.map(([, w], i) => <col key={i} style={w ? { width: w } : undefined} />)}</colgroup>
            <thead><tr>{cols.map(([h], i) => <th key={i}>{h}</th>)}</tr></thead>
        </>
    );
    return (
        <div className="cr-feed tab-wrap">
            <table className="tab">
                {node === 'master' && head([['Время', '76px'], ['Модуль', '84px'], ['Событие', '124px'], ['Обнаружение', '122px'], ['Класс', ''], ['Ответ', '112px']])}
                {node === 'websocket' && head([['Время', '76px'], ['Обнаружение', '122px'], ['Класс', ''], ['Камера', ''], ['Ответ', '112px']])}
                {node === 'can' && head([['Время', '76px'], ['Событие', '124px'], ['Обнаружение', '122px'], ['Класс', ''], ['Ответ', '112px']])}
                {node === 'modbus' && head([['Время', '76px'], ['Обнаружение', '122px'], ['Код', ''], ['Камеры', ''], ['Зона', '66px'], ['Ответ', '112px']])}
                <tbody>
                    {rows.map(e => (
                        <tr key={e.seq}>
                            <td className="tm">{time(e.t)}</td>
                            {node === 'master' && <td>{MODULE_SHORT[e.module] ?? e.module}</td>}
                            {(node === 'master' || node === 'can') && <td><Event e={e} /></td>}
                            <td className="no">{ids(e)}</td>
                            {node === 'modbus' ? (
                                <>
                                    <td><span className="mono">{e.code}</span> {ISKRA_CODES[e.code ?? -1] ?? ''}</td>
                                    <td>{roleNames(e.camera_mask)}</td>
                                    <td className="mono">{e.zone}</td>
                                </>
                            ) : (
                                <td>{e.class_name}{node === 'websocket' && conf(e)}</td>
                            )}
                            {node === 'websocket' && <td>{cameraName(e.camera_id)}</td>}
                            <td><Answer e={e} /></td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
