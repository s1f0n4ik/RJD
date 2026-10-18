import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { Modal, Switch, isModalOpen, Seg } from '../../app/Modal';
import { useSystem } from '../../app/SystemContext';
import { useToast } from '../../app/Toast';
import { reducedMotion } from '../../app/motion';
import { formatBytes } from '../devices/model';
import {
    MAX_HIGH, MIN_GAP, MIN_HIGH, STOP_PERCENT, disksLabel, poolApi, usePools,
    type Pool, type PoolVolume, type VolumePatch,
} from './pool';
import { isSettingsSection } from './sections';
import './settings.css';

const POLL_MS = 5000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Время записей — настенное время изделия, как в архиве
const wall = (ms: number) => new Date(ms).toLocaleString('ru-RU', {
    timeZone: 'UTC', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
}).replace(',', '');

// Момент, когда диск видели подключённым, — настоящие unix ms службы
const seen = (ms: number | null) => (ms === null ? '—' : new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
}).replace(',', ''));

const depth = (v: PoolVolume) => (v.segment_count && v.first_ms !== null && v.last_ms !== null
    ? `${wall(v.first_ms)} — ${wall(v.last_ms)}`
    : 'записей нет');

const usedPercent = (v: PoolVolume) => (v.total_bytes ? Math.round((v.used_bytes ?? 0) / v.total_bytes * 100) : 0);

const share = (bytes: number, total: number) => Math.max(0, Math.min(100, bytes / total * 100));

const FS_NAMES: Record<string, string> = { ntfs: 'NTFS', ntfs3: 'NTFS', vfat: 'FAT32', msdos: 'FAT', exfat: 'exFAT', fuseblk: 'FUSE' };
const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

export default function SettingsScreen() {
    const { section = '' } = useParams();
    if (!isSettingsSection(section)) return <Navigate to="/settings/storage" replace />;
    return <StorageSection />;
}

function VolumeTag({ v }: { v: PoolVolume }) {
    if (v.state === 'offline') return <span className="tag st-t-off">не подключён</span>;
    if (v.state === 'readonly') return <span className="tag is-warn">только чтение</span>;
    if (!v.enabled) return <span className="tag">выключен</span>;
    if (v.writing) return <span className="tag is-acc"><i className="dot acc" />пишется</span>;
    return v.internal ? null : <span className="tag">подключён</span>;
}

// Полоса тома: записи устройства, прочее занятое и пороги
function Meter({ v, high = v.high, low = v.low, big }: { v: PoolVolume; high?: number; low?: number; big?: boolean }) {
    const size = big ? ' is-big' : '';
    if (!v.total_bytes) return <div className={`st-m is-none${size}`} />;

    const used = v.used_bytes ?? 0;
    const rec = share(v.records_bytes, v.total_bytes);
    const other = share(Math.max(0, used - v.records_bytes), v.total_bytes);
    const tone = v.writing ? (usedPercent(v) >= high ? ' is-full' : ' is-writing')
        : v.state === 'readonly' ? ' is-ro' : !v.enabled ? ' is-dis' : '';

    return (
        <div className={`st-m${tone}${size}`}>
            <i className="st-rec" style={{ width: `${rec}%` }} />
            <i className="st-oth" style={{ left: `${rec}%`, width: `${other}%` }} />
            <i className="st-lo" style={{ left: `${low}%` }} />
            <i className="st-hi" style={{ left: `${high}%` }} />
        </div>
    );
}

function PoolPill({ pool }: { pool: Pool }) {
    const { state, writing } = pool.summary;
    if (state === 'stuck') return <span className="pill err"><span className="dot" />писать некуда</span>;
    if (state === 'ring') {
        return (
            <span className="pill warn">
                <span className="dot" />
                <span className="seps">{writing && <span>«{writing}»</span>}<span>удаляются старые</span></span>
            </span>
        );
    }
    return writing ? <span className="pill ok"><span className="dot" />пишется на «{writing}»</span> : null;
}

const dotTone = (pool: Pool | null | undefined) =>
    !pool ? '' : pool.summary.state === 'stuck' ? ' err' : pool.summary.state === 'ring' ? ' warn' : ' ok';

function StorageSection() {
    const { devices } = useSystem();
    const toast = useToast();
    const { pools, put, reload } = usePools(devices, POLL_MS);

    const [picked, setPicked] = useState<string | null>(null);
    const device = devices.find(d => d.id === picked) ?? devices[0] ?? null;
    const pool = device ? pools[device.id] : undefined;

    const [selId, setSelId] = useState<string | null>(null);
    const [closing, setClosing] = useState(false);
    const selected = pool?.volumes.find(v => v.id === selId) ?? null;

    const pick = (id: string) => {
        setClosing(false);
        setSelId(id);
    };
    // Закрытие отдаёт переходу доиграть: снятие выбора — по концу перехода шторки
    const closeDrawer = () => {
        if (reducedMotion()) setSelId(null);
        else setClosing(true);
    };
    const [forgetting, setForgetting] = useState<PoolVolume | null>(null);

    // Esc закрывает шторку, уступая модалкам
    useEffect(() => {
        if (!selected) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !isModalOpen()) closeDrawer();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [selected]);

    // Правка применяется сразу; ответ — свежий снимок пула
    const apply = async (action: (deviceId: string) => Promise<Pool>, fail: string) => {
        if (!device) return;
        try {
            put(device.id, await action(device.id));
        } catch (e) {
            toast(fail, message(e), 'err');
            void reload();
        }
    };
    const update = (id: string, patch: VolumePatch) =>
        apply(deviceId => poolApi.update(deviceId, id, patch), 'Не удалось сохранить');
    const reorder = (ids: string[]) =>
        apply(deviceId => poolApi.reorder(deviceId, ids), 'Порядок записи не сохранён');

    const forget = async () => {
        const target = forgetting;
        setForgetting(null);
        if (!device || !target) return;
        try {
            const { removed } = await poolApi.forget(device.id, target.id);
            setSelId(null);
            toast(`Диск «${target.name}» забыт`, `Удалено из индекса сегментов: ${removed}`, 'ok');
        } catch (e) {
            toast('Диск не забыт', message(e), 'err');
        }
        void reload();
    };

    if (!device) {
        return (
            <section className="screen mod-screen st-screen">
                <div className="notice">
                    <Icon name="warn" className="ico" />
                    <h2>Устройства не добавлены</h2>
                </div>
            </section>
        );
    }

    return (
        <section className="screen mod-screen st-screen">
            <div className="st-bar">
                <span className="st-cap">Устройство</span>
                <Seg className="st-seg">
                    {devices.map(d => (
                        <button
                            key={d.id}
                            type="button"
                            className={d.id === device.id ? 'is-on' : ''}
                            onClick={() => { setPicked(d.id); setSelId(null); }}
                        >
                            <i className={`dot${dotTone(pools[d.id])}`} />
                            {d.name}
                        </button>
                    ))}
                </Seg>
                {pool && (
                    <span className="seps">
                        <span>{disksLabel(pool.summary.disk_count)}</span>
                        <span>{formatBytes(pool.summary.total_bytes)}</span>
                        <span>свободно {formatBytes(pool.summary.free_bytes)}</span>
                    </span>
                )}
                <span className="st-end">{pool && <PoolPill pool={pool} />}</span>
            </div>

            {pool === null && (
                <div className="notice">
                    <Icon name="warn" className="ico" />
                    <h2>Служба хранения не отвечает</h2>
                </div>
            )}

            {pool && (
                <div className={`st-body${selected ? ' is-drawer' : ''}`}>
                    <div className="st-main">
                        <div className="st-gh"><h4>Порядок записи</h4><span className="n">{pool.volumes.length}</span></div>
                        <VolumeTable
                            pool={pool}
                            selId={selId}
                            onSelect={pick}
                            onToggle={(v, on) => void update(v.id, { enabled: on })}
                            onReorder={ids => void reorder(ids)}
                        />

                        {pool.unsuitable.length > 0 && (
                            <>
                                <div className="st-gh"><h4>Не подходят</h4><span className="n">{pool.unsuitable.length}</span></div>
                                <div className="st-un">
                                    {pool.unsuitable.map(u => (
                                        <span key={u.path} className="st-un-i">
                                            <b>{baseName(u.path)}</b>
                                            <span className="fs">{FS_NAMES[u.fstype] ?? u.fstype}</span>
                                            {u.reason === 'fs'
                                                ? <span className="tag is-err">не подходит</span>
                                                : <span className="tag is-warn">только чтение</span>}
                                        </span>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>

                    {selected && (
                        <aside
                            className={`st-drawer${closing ? ' is-closing' : ''}`}
                            onTransitionEnd={e => {
                                if (!closing || e.target !== e.currentTarget || e.propertyName !== 'flex-basis') return;
                                setSelId(null);
                                setClosing(false);
                            }}
                        >
                            <VolumeDrawer
                                key={selected.id}
                                deviceId={device.id}
                                v={selected}
                                onClose={closeDrawer}
                                onUpdate={patch => update(selected.id, patch)}
                                onForget={() => setForgetting(selected)}
                            />
                        </aside>
                    )}
                </div>
            )}

            {forgetting && (
                <Modal
                    title={`Забыть «${forgetting.name}»?`}
                    className="modal--confirm"
                    onClose={() => setForgetting(null)}
                    footer={(
                        <>
                            <button type="button" className="btn btn--ghost spacer" onClick={() => setForgetting(null)}>Отмена</button>
                            <button type="button" className="btn btn--err" onClick={() => void forget()}>
                                <Icon name="trash" size={15} />
                                Забыть
                            </button>
                        </>
                    )}
                >
                    <div className="modal-b">
                        <div className="kv"><span className="k">Сегментов</span><span className="v">{forgetting.segment_count.toLocaleString('ru-RU')}</span></div>
                        <div className="kv"><span className="k">Архив</span><span className="v">{formatBytes(forgetting.records_bytes)}</span></div>
                        <div className="kv"><span className="k">Глубина</span><span className="v">{depth(forgetting)}</span></div>
                        <div className="kv"><span className="k">Был подключён</span><span className="v">{seen(forgetting.seen_ms)}</span></div>
                    </div>
                </Modal>
            )}
        </section>
    );
}

interface TableProps {
    pool: Pool;
    selId: string | null;
    onSelect: (id: string) => void;
    onToggle: (v: PoolVolume, on: boolean) => void;
    onReorder: (ids: string[]) => void;
}

// Тома в порядке записи: внутренний первым и на месте, внешние перетаскиваются за ручку
function VolumeTable({ pool, selId, onSelect, onToggle, onReorder }: TableProps) {
    const externals = pool.volumes.filter(v => !v.internal).map(v => v.id);
    const byId = new Map(pool.volumes.map(v => [v.id, v]));

    // Строка перетаскивается, только пока нажата её ручка
    const [armed, setArmed] = useState<string | null>(null);
    const [drag, setDrag] = useState<{ id: string; order: string[] } | null>(null);

    const order = drag?.order ?? externals;
    const rows = [
        ...pool.volumes.filter(v => v.internal),
        ...order.map(id => byId.get(id)).filter((v): v is PoolVolume => !!v),
    ];

    const dragOver = (overId: string) => {
        if (!drag || overId === drag.id || !order.includes(overId)) return;
        const next = order.filter(id => id !== drag.id);
        next.splice(order.indexOf(overId), 0, drag.id);
        setDrag({ ...drag, order: next });
    };

    const dragEnd = () => {
        if (drag && drag.order.join() !== externals.join()) onReorder(drag.order);
        setDrag(null);
        setArmed(null);
    };

    return (
        <div className="st-tab">
            <div className="st-r is-head">
                <span /><span>№</span><span>Диск</span><span>Занято</span><span>Архив устройства</span><span>Состояние</span><span>Запись</span>
            </div>
            {rows.map(v => (
                <div
                    key={v.id}
                    className={`st-r${v.id === selId ? ' is-sel' : ''}${v.state === 'offline' ? ' is-off' : ''}`
                        + `${!v.enabled ? ' is-dis' : ''}${drag?.id === v.id ? ' is-drag' : ''}`}
                    draggable={armed === v.id}
                    onDragStart={e => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', v.id);
                        setDrag({ id: v.id, order: externals });
                    }}
                    onDragOver={e => { if (drag) { e.preventDefault(); dragOver(v.id); } }}
                    onDragEnd={dragEnd}
                    onClick={() => onSelect(v.id)}
                >
                    {v.internal ? (
                        <span className="st-lock"><Icon name="lock" size={13} /></span>
                    ) : (
                        <span
                            className="st-grip"
                            data-tip="Перетащить: порядок записи"
                            onPointerDown={() => {
                                setArmed(v.id);
                                window.addEventListener('pointerup', () => setArmed(null), { once: true });
                            }}
                            onClick={e => e.stopPropagation()}
                        >
                            <Icon name="grip" size={14} />
                        </span>
                    )}
                    {v.internal ? <span /> : <span className="st-no">{order.indexOf(v.id) + 1}</span>}
                    <span className="st-nm"><b>{v.name}</b><small>{v.path}</small></span>
                    <span className="st-use">
                        <Meter v={v} />
                        <span className="t">
                            {v.total_bytes ? (
                                <>
                                    <span className="st-lg"><i />архив устройства</span>
                                    <span className="st-lg"><i className="is-oth" />прочее</span>
                                    <span className="seps">
                                        <span>{usedPercent(v)} %</span>
                                        <span>{formatBytes(v.used_bytes)} из {formatBytes(v.total_bytes)}</span>
                                    </span>
                                </>
                            ) : <span>последний раз {seen(v.seen_ms)}</span>}
                        </span>
                    </span>
                    <span className="st-arc">
                        <b>{v.segment_count ? formatBytes(v.records_bytes) : '—'}</b>
                        <small>{depth(v)}</small>
                    </span>
                    <span><VolumeTag v={v} /></span>
                    {v.internal ? <span /> : (
                        <span className="st-sw" onClick={e => e.stopPropagation()}>
                            <Switch on={v.enabled} onToggle={on => onToggle(v, on)}>{null}</Switch>
                        </span>
                    )}
                </div>
            ))}
        </div>
    );
}

interface DrawerProps {
    deviceId: string;
    v: PoolVolume;
    onClose: () => void;
    onUpdate: (patch: VolumePatch) => Promise<void>;
    onForget: () => void;
}

// Число из поля процента; запятая допустима
const parsePercent = (text: string) => Number(text.trim().replace(',', '.'));
const percentText = (n: number) => String(n).replace('.', ',');

function VolumeDrawer({ deviceId, v, onClose, onUpdate, onForget }: DrawerProps) {
    const toast = useToast();

    // Черновики полей живут, пока поле в работе; опрос их не перетирает
    const [name, setName] = useState<string | null>(null);
    const [highText, setHighText] = useState<string | null>(null);
    const [lowText, setLowText] = useState<string | null>(null);

    const [foreign, setForeign] = useState<Array<{ device_id: string; bytes: number }>>([]);
    const [clearing, setClearing] = useState<{ device_id: string; bytes: number } | null>(null);

    // Чужие архивы считаются обходом каталога — один раз на открытие шторки
    const attached = !v.internal && v.state !== 'offline';
    useEffect(() => {
        if (!attached) { setForeign([]); return; }
        let alive = true;
        poolApi.foreign(deviceId, v.id)
            .then(result => { if (alive) setForeign(result.devices); })
            .catch(() => { if (alive) setForeign([]); });
        return () => { alive = false; };
    }, [deviceId, v.id, attached]);

    const high = highText === null ? v.high : parsePercent(highText);
    const low = lowText === null ? v.low : parsePercent(lowText);
    const highOk = Number.isFinite(high) && high >= MIN_HIGH && high <= MAX_HIGH;
    const shownHigh = highOk ? high : v.high;
    const lowOk = Number.isFinite(low) && low > 0 && low <= shownHigh - MIN_GAP;
    const shownLow = lowOk ? low : v.low;

    const abs = (percent: number) => (v.total_bytes ? formatBytes(v.total_bytes * percent / 100) : '—');

    const commitName = () => {
        if (name === null) return;
        const next = name.trim();
        setName(null);
        if (next !== v.custom_name) void onUpdate({ name: next });
    };

    // Верхний ниже нижнего + 5 тянет нижний за собой
    const commitHigh = () => {
        if (highText === null) return;
        setHighText(null);
        if (!highOk) {
            toast('Порог не сохранён', `Начало удаления — от ${MIN_HIGH} до ${MAX_HIGH} %`, 'err');
            return;
        }
        if (high === v.high) return;
        const patch: VolumePatch = { high };
        if (v.low > high - MIN_GAP) patch.low = high - MIN_GAP;
        void onUpdate(patch);
    };

    const commitLow = () => {
        if (lowText === null) return;
        setLowText(null);
        if (!lowOk) {
            toast('Порог не сохранён', `Удаление до — не выше ${v.high - MIN_GAP} %`, 'err');
            return;
        }
        if (low !== v.low) void onUpdate({ low });
    };

    const clear = async () => {
        const target = clearing;
        setClearing(null);
        if (!target) return;
        try {
            await poolApi.clearForeign(deviceId, v.id, target.device_id);
            setForeign(list => list.filter(f => f.device_id !== target.device_id));
            toast('Архив удалён', `${target.device_id} · ${formatBytes(target.bytes)}`, 'ok');
        } catch (e) {
            toast('Архив не удалён', message(e), 'err');
        }
    };

    const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') e.currentTarget.blur();
    };

    return (
        <div className="st-dw">
            <div className="st-dh">
                <h2>{v.name}</h2>
                <VolumeTag v={v} />
                <button type="button" className="x" onClick={onClose} aria-label="Закрыть">
                    <Icon name="x" size={15} />
                </button>
            </div>

            <div className="st-dscroll">
                <div className="st-blk-h">Диск</div>
                <div className="st-blk-b">
                    <div className="st-fgrid">
                        {!v.internal && (
                            <>
                                <label htmlFor="st-name">Название</label>
                                <input
                                    id="st-name"
                                    className="inp inp--text"
                                    value={name ?? v.custom_name}
                                    placeholder={v.custom_name ? '' : v.name}
                                    maxLength={64}
                                    onChange={e => setName(e.target.value)}
                                    onBlur={commitName}
                                    onKeyDown={blurOnEnter}
                                />
                                <label>Запись</label>
                                <Switch on={v.enabled} onToggle={on => void onUpdate({ enabled: on })}>{null}</Switch>
                            </>
                        )}
                        <label>Ёмкость</label>
                        <span className="ro">{v.total_bytes ? formatBytes(v.total_bytes) : '—'}</span>
                        <label>Путь</label>
                        <span className="ro">{v.path ?? '—'}</span>
                    </div>
                </div>

                <div className="st-blk-h">Пороги</div>
                <div className="st-blk-b">
                    <div>
                        <Meter v={v} high={shownHigh} low={shownLow} big />
                        <div className="st-scale">
                            <span style={{ left: 0, transform: 'none' }}>0</span>
                            <span style={{ left: `${shownLow}%` }}>{percentText(shownLow)}</span>
                            <span className="is-hi" style={{ left: `${shownHigh}%` }}>{percentText(shownHigh)}</span>
                        </div>
                    </div>
                    <div className="st-fgrid st-th">
                        <label htmlFor="st-high">Начало удаления</label>
                        <div className="tf-unit">
                            <input
                                id="st-high"
                                className={`tf-in${highOk ? '' : ' is-err'}`}
                                inputMode="decimal"
                                value={highText ?? percentText(v.high)}
                                onChange={e => setHighText(e.target.value)}
                                onBlur={commitHigh}
                                onKeyDown={blurOnEnter}
                            />
                            <span className="u">%</span>
                        </div>
                        <span className="ro">{abs(shownHigh)}</span>

                        <label htmlFor="st-low">Удаление до</label>
                        <div className="tf-unit">
                            <input
                                id="st-low"
                                className={`tf-in${lowOk ? '' : ' is-err'}`}
                                inputMode="decimal"
                                value={lowText ?? percentText(v.low)}
                                onChange={e => setLowText(e.target.value)}
                                onBlur={commitLow}
                                onKeyDown={blurOnEnter}
                            />
                            <span className="u">%</span>
                        </div>
                        <span className="ro">{abs(shownLow)}</span>

                        <label>Остановка записи</label>
                        <span className="ro">{STOP_PERCENT} %</span>
                        <span className="ro">{abs(STOP_PERCENT)}</span>
                    </div>
                </div>

                <div className="st-blk-h">Архив устройства</div>
                <div className="st-blk-b">
                    <div>
                        <div className="kv"><span className="k">Объём</span><span className="v">{v.segment_count ? formatBytes(v.records_bytes) : '—'}</span></div>
                        <div className="kv"><span className="k">Сегментов</span><span className="v">{v.segment_count.toLocaleString('ru-RU')}</span></div>
                        <div className="kv"><span className="k">Глубина</span><span className="v">{depth(v)}</span></div>
                        {v.state === 'offline' && (
                            <div className="kv"><span className="k">Был подключён</span><span className="v">{seen(v.seen_ms)}</span></div>
                        )}
                    </div>
                </div>

                {foreign.length > 0 && (
                    <>
                        <div className="st-blk-h">Чужие архивы<span className="n">{foreign.length}</span></div>
                        <div className="st-blk-b">
                            {foreign.map(f => (
                                <div key={f.device_id} className="st-fr">
                                    <Icon name="dev" size={14} />
                                    <b>{f.device_id}</b>
                                    <span className="num">{formatBytes(f.bytes)}</span>
                                    <button
                                        type="button"
                                        className="icon-btn is-err"
                                        data-tip={`Удалить архив ${f.device_id}`}
                                        onClick={() => setClearing(f)}
                                    >
                                        <Icon name="trash" size={14} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </div>

            {v.state === 'offline' && (
                <div className="st-dfoot">
                    <button type="button" className="btn btn--err" onClick={onForget}>
                        <Icon name="trash" size={15} />
                        Забыть диск
                    </button>
                </div>
            )}

            {clearing && (
                <Modal
                    title={`Удалить архив ${clearing.device_id}?`}
                    className="modal--confirm"
                    onClose={() => setClearing(null)}
                    footer={(
                        <>
                            <button type="button" className="btn btn--ghost spacer" onClick={() => setClearing(null)}>Отмена</button>
                            <button type="button" className="btn btn--err" onClick={() => void clear()}>
                                <Icon name="trash" size={15} />
                                Удалить
                            </button>
                        </>
                    )}
                >
                    <div className="modal-b">
                        <div className="kv"><span className="k">Диск</span><span className="v">{v.name}</span></div>
                        <div className="kv"><span className="k">Объём</span><span className="v">{formatBytes(clearing.bytes)}</span></div>
                    </div>
                </Modal>
            )}
        </div>
    );
}
