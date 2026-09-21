import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Icon } from '../app/Icons';
import { Select } from '../app/Select';
import { moduleDeviceId } from '../services/devices';
import { journalApi } from '../features/neural/api/journal';
import type { JournalDetection, Verdict } from '../features/neural/api/journal-types';
import { aggClasses, classColor } from '../features/neural/components/journal/DetectionRow';
import { PRESETS, VERDICT_CLASS, VERDICT_LABEL, presetRange, type PresetKey } from '../features/neural/components/journal/Filters';
import { FrameWithBoxes } from '../features/neural/components/journal/FrameWithBoxes';
import { JournalMap } from '../features/neural/components/journal/JournalMap';
import { fmtCoord, fmtDate, fmtTime, pluralRecords } from '../features/neural/components/journal/format';
import { useCameraNames } from '../features/neural/components/journal/useCameraNames';
import { useClassResolver } from '../features/neural/components/journal/useClassResolver';
import '../features/neural/components/journal/journal.css';

const LIMIT = 100;
const POLL_MS = 5000;

type Mode = 'list' | 'map';

export default function JournalScreen() {
    const { state } = useLocation();
    const { resolve } = useClassResolver();
    const { cameraName, cameras } = useCameraNames();

    const [preset, setPreset] = useState<PresetKey>('today');
    const [cameraId, setCameraId] = useState('');
    const [verdict, setVerdict] = useState<Verdict | ''>('');
    const [mode, setMode] = useState<Mode>('list');
    const [dets, setDets] = useState<JournalDetection[]>([]);
    const [total, setTotal] = useState(0);
    // Скелет только при первом открытии; смена фильтра держит прежние строки до ответа
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [openId, setOpenId] = useState<number | null>((state as { open?: number } | null)?.open ?? null);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const head = useRef('');

    const filters = useMemo(() => {
        const range = presetRange(preset);
        return { tFrom: range.from, tTo: range.to, cameraId: cameraId || undefined, verdict: verdict || undefined };
    }, [preset, cameraId, verdict]);

    const load = useCallback(() => journalApi.list(filters, { limit: LIMIT })
        .then(res => { setDets(res.detections); setTotal(res.total); setErr(null); })
        .catch(e => setErr(String(e)))
        .finally(() => { setLoading(false); setRefreshing(false); }), [filters]);

    // Список перечитывается только когда лёгкая ручка head показала изменение
    useEffect(() => {
        if (!moduleDeviceId('neural')) { setLoading(false); return; }
        head.current = '';
        setRefreshing(true);
        load();
        const timer = window.setInterval(() => {
            journalApi.head(filters)
                .then(h => {
                    const key = `${h.max_id}/${h.total}`;
                    if (head.current && head.current !== key) load();
                    head.current = key;
                })
                .catch(() => {});
        }, POLL_MS);
        return () => window.clearInterval(timer);
    }, [filters, load]);

    const open = openId === null ? null : dets.find(d => d.id === openId) ?? null;
    const openIndex = open ? dets.indexOf(open) : -1;

    if (!moduleDeviceId('neural')) {
        return (
            <section className="m-screen">
                <div className="empty">
                    <Icon name="eye" />
                    <b>Модуль технического зрения не поднят</b>
                    <p>Журнал появится, когда модуль будет назначен на устройство. Назначение делается с рабочего места.</p>
                </div>
            </section>
        );
    }

    if (open) {
        const classes = aggClasses(open, resolve);
        const vd = VERDICT_CLASS[open.verdict];
        return (
            <section className="m-screen">
                <div className="m-sub">
                    <button className="m-back" aria-label="Назад к списку" onClick={() => setOpenId(null)}><Icon name="chev" /></button>
                    <h2 className="num">{fmtTime(open.ts)}</h2>
                    <span className="pill">{openIndex + 1} из {dets.length}</span>
                </div>
                <div className="m-scroll">
                    <div className="m-fv"><FrameWithBoxes det={open} resolve={resolve} /></div>
                    <div className="m-fv-cap">
                        <div><small>Камера</small>{cameraName(open.camera_id)}</div>
                        <div><small>Вердикт</small><span className={`vd ${vd.vd}`}><span className={`dot${vd.dot ? ' ' + vd.dot : ''}`} />{VERDICT_LABEL[open.verdict]}</span></div>
                        <div><small>Дата</small><span className="num">{fmtDate(open.ts)}</span></div>
                        <div><small>Трек</small><span className="num seps"><span>{open.track_id ?? '—'}</span>{open.event && <span>{open.event}</span>}</span></div>
                        <div><small>Координаты</small><span className="num">{open.gps ? `${fmtCoord(open.gps.lat)} ${fmtCoord(open.gps.lon)}` : '—'}</span></div>
                        <div><small>Скорость</small><span className="num seps">{open.gps ? <><span>{Math.round(open.gps.speed)} км/ч</span><span>курс {Math.round(open.gps.course)}°</span></> : <span>—</span>}</span></div>
                        <div style={{ gridColumn: '1 / -1' }}>
                            <small>Объекты</small>
                            <span className="m-tags" style={{ marginTop: 2 }}>
                                {classes.map((c, i) => (
                                    <span className="otag" key={i}>
                                        <i className="sw-col" style={{ background: classColor(c) }} />
                                        {c.name || '—'}{c.count > 1 && <span className="num">×{c.count}</span>}<span className="num">{c.cf.toFixed(2)}</span>
                                    </span>
                                ))}
                                {classes.length === 0 && <span className="muted">нет</span>}
                            </span>
                        </div>
                        {open.verdict_note && <div style={{ gridColumn: '1 / -1' }}><small>Заметка</small>{open.verdict_note}</div>}
                    </div>
                    <div className="m-fv-nav">
                        <button className="btn" disabled={openIndex >= dets.length - 1} onClick={() => setOpenId(dets[openIndex + 1].id)}>
                            <Icon name="chev" size={16} className="ico m-flip" />Раньше
                        </button>
                        <button className="btn" disabled={openIndex <= 0} onClick={() => setOpenId(dets[openIndex - 1].id)}>
                            Позже<Icon name="chev" size={16} />
                        </button>
                    </div>
                </div>
            </section>
        );
    }

    const row = (det: JournalDetection) => {
        const classes = aggClasses(det, resolve);
        const vd = VERDICT_CLASS[det.verdict];
        return (
            <button key={det.id} className="m-jl" onClick={() => setOpenId(det.id)}>
                <div className="thb"><FrameWithBoxes det={det} resolve={resolve} compact /></div>
                <div className="t">
                    <div className="tm">{fmtTime(det.ts)}{preset !== 'today' && <small>{fmtDate(det.ts)}</small>}</div>
                    <div className="cm seps"><span>{cameraName(det.camera_id)}</span>{det.track_id !== null && <span>трек {det.track_id}</span>}</div>
                    <div className="m-tags">
                        {classes.map((c, i) => (
                            <span className="otag" key={i}>
                                <i className="sw-col" style={{ background: classColor(c) }} />
                                {c.name || '—'}{c.count > 1 && <span className="num">×{c.count}</span>}<span className="num">{c.cf.toFixed(2)}</span>
                            </span>
                        ))}
                    </div>
                </div>
                <div className="vd">
                    <span className={`dot${vd.dot ? ' ' + vd.dot : ''}`} title={VERDICT_LABEL[det.verdict]} />
                    <Icon name="chev" />
                </div>
            </button>
        );
    };

    const selected = selectedId === null ? null : dets.find(d => d.id === selectedId) ?? null;

    return (
        <section className="m-screen">
            <div className="seg">
                <button className={mode === 'list' ? 'is-on' : ''} onClick={() => setMode('list')}><Icon name="list" size={15} />Список</button>
                <button className={mode === 'map' ? 'is-on' : ''} onClick={() => setMode('map')}><Icon name="map" size={15} />Карта</button>
            </div>
            <div className="m-chips">
                {PRESETS.map(p => (
                    <button key={p.key} className={`m-chip${preset === p.key ? ' is-on' : ''}`} onClick={() => setPreset(p.key)}>
                        {p.key === 'today' && <Icon name="cal" size={13} />}{p.label}
                    </button>
                ))}
            </div>
            <div className="m-sels" style={{ paddingTop: 0 }}>
                <Select
                    value={cameraId}
                    options={[{ value: '', label: 'Все камеры' }, ...cameras.map(c => ({ value: c.id, label: c.name }))]}
                    onChange={setCameraId}
                />
                <Select
                    value={verdict}
                    options={[{ value: '', label: 'Любой вердикт' }, ...(Object.keys(VERDICT_LABEL) as Verdict[]).map(v => ({ value: v, label: VERDICT_LABEL[v] }))]}
                    onChange={v => setVerdict(v as Verdict | '')}
                />
            </div>
            <div className="m-cnt seps">
                {loading
                    ? <span className="skel h10" style={{ width: 140 }} />
                    : <><b>{pluralRecords(total)}</b>{total > LIMIT && <span>показаны последние {LIMIT}</span>}{refreshing && <span>обновление…</span>}</>}
            </div>
            {err && <div className="banner is-err"><Icon name="warn" /><span>Журнал не отвечает: {err}</span></div>}

            {mode === 'list' ? (
                <div className="m-scroll">
                    {loading && [0, 1, 2, 3, 4, 5].map(i => (
                        <div key={i} className="m-jl">
                            <div className="m-skthb" />
                            <div className="t">
                                <span className="skel h16" style={{ width: 80 }} />
                                <span className="skel h10" style={{ width: '60%', marginTop: 8 }} />
                                <span className="skel h16" style={{ width: 70 + (i % 3) * 20, marginTop: 8, borderRadius: 5 }} />
                            </div>
                            <div className="vd"><span className="dot" /></div>
                        </div>
                    ))}
                    {dets.map(row)}
                    {!loading && dets.length === 0 && (
                        <div className="empty">
                            <Icon name="empty" />
                            <b>Обнаружений нет</b>
                            <p>За выбранный период по этим фильтрам записей не было.</p>
                        </div>
                    )}
                </div>
            ) : (
                <>
                    <div className="m-map">
                        <JournalMap
                            detections={dets}
                            selectedId={selectedId}
                            mode="full"
                            resolve={resolve}
                            cameraName={cameraName}
                            onSelect={setSelectedId}
                            onOpenViewer={setOpenId}
                        />
                    </div>
                    {selected && <div className="m-sheet">{row(selected)}</div>}
                </>
            )}
        </section>
    );
}
