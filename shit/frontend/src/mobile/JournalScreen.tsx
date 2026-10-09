import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Icon } from '../app/Icons';
import { Select } from '../app/Select';
import { journalApi } from '../features/neural/api/journal';
import type { JournalDetection, Verdict } from '../features/neural/api/journal-types';
import { DetTags, detClass } from '../features/neural/components/journal/DetectionRow';
import { PRESETS, VERDICT_CLASS, VERDICT_LABEL, presetRange, type PresetKey } from '../features/neural/components/journal/Filters';
import { FrameWithBoxes, previewShot, useDetectionShots } from '../features/neural/components/journal/FrameWithBoxes';
import { JournalMap } from '../features/neural/components/journal/JournalMap';
import { REASON_LABEL, durationLabel, fmtCoord, fmtDate, fmtTime, pluralRecords } from '../features/neural/components/journal/format';
import { useCameraNames } from '../features/neural/components/journal/useCameraNames';
import { useClassResolver } from '../features/neural/components/journal/useClassResolver';
import '../features/neural/components/journal/journal.css';

const LIMIT = 100;
const POLL_MS = 5000;

type Mode = 'list' | 'map';

export default function JournalScreen() {
    const { state } = useLocation();
    const { resolve } = useClassResolver();
    const { cameraName, deviceName, cameras } = useCameraNames();

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

    // Список перечитывается, когда head показал новое или закрытое обнаружение
    useEffect(() => {
        head.current = '';
        setRefreshing(true);
        load();
        const timer = window.setInterval(() => {
            journalApi.head(filters)
                .then(h => {
                    const key = `${h.max_id}/${h.total}/${h.open}`;
                    if (head.current && head.current !== key) load();
                    head.current = key;
                })
                .catch(() => {});
        }, POLL_MS);
        return () => window.clearInterval(timer);
    }, [filters, load]);

    const open = openId === null ? null : dets.find(d => d.id === openId) ?? null;
    const openIndex = open ? dets.indexOf(open) : -1;
    const { shots, index: shotIndex, shot, setIndex: setShotIndex } = useDetectionShots(open);

    if (open) {
        const cls = detClass(open, resolve);
        const vd = VERDICT_CLASS[open.verdict];
        const gps = open.gps;
        return (
            <section className="m-screen">
                <div className="m-sub">
                    <button className="m-back" aria-label="Назад к списку" onClick={() => setOpenId(null)}><Icon name="chev" /></button>
                    <h2 className="num">{fmtTime(open.started_at)}</h2>
                    <span className="pill">{openIndex + 1} из {dets.length}</span>
                </div>
                <div className="m-scroll">
                    <div className="m-fv">
                        <FrameWithBoxes shot={shot} color={cls.color} name={cls.name} />
                        {shots.length > 1 && (
                            <>
                                <button className="jr-nav l" aria-label="Предыдущий снимок" disabled={shotIndex === 0} onClick={() => setShotIndex(shotIndex - 1)}>
                                    <Icon name="chev" size={18} />
                                </button>
                                <button className="jr-nav r" aria-label="Следующий снимок" disabled={shotIndex === shots.length - 1} onClick={() => setShotIndex(shotIndex + 1)}>
                                    <Icon name="chev" size={18} />
                                </button>
                                <span className="jr-count num">{shotIndex + 1} / {shots.length}</span>
                            </>
                        )}
                    </div>
                    <div className="m-fv-cap">
                        <div><small>Камера</small>{cameraName(open.camera_id)}</div>
                        <div><small>Вердикт</small><span className={`vd ${vd.vd}`}><span className={`dot${vd.dot ? ' ' + vd.dot : ''}`} />{VERDICT_LABEL[open.verdict]}</span></div>
                        <div><small>Дата</small><span className="num">{fmtDate(open.started_at)}</span></div>
                        <div><small>Длительность</small><span className="num">{durationLabel(open)}</span></div>
                        <div><small>Устройство</small>{deviceName(open.device_id)}</div>
                        <div><small>Треки</small><span className="num">{open.tracks}</span></div>
                        <div><small>Закрыто</small>{open.closed_reason ? REASON_LABEL[open.closed_reason] ?? open.closed_reason : '—'}</div>
                        <div><small>Координаты</small><span className="num">{gps ? `${fmtCoord(gps.lat)} ${fmtCoord(gps.lon)}` : '—'}</span></div>
                        <div><small>Скорость</small><span className="num seps">{gps?.speed != null ? <><span>{Math.round(gps.speed * 3.6)} км/ч</span>{gps.course != null && <span>курс {Math.round(gps.course)}°</span>}</> : <span>—</span>}</span></div>
                        <div style={{ gridColumn: '1 / -1' }}>
                            <small>Класс</small>
                            <span className="m-tags" style={{ marginTop: 2 }}>
                                <DetTags det={open} resolve={resolve} />
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
        const cls = detClass(det, resolve);
        const vd = VERDICT_CLASS[det.verdict];
        return (
            <button key={det.id} className="m-jl" onClick={() => setOpenId(det.id)}>
                <div className="thb"><FrameWithBoxes shot={previewShot(det)} color={cls.color} name={cls.name} compact /></div>
                <div className="t">
                    <div className="tm">{fmtTime(det.started_at)}{preset !== 'today' && <small>{fmtDate(det.started_at)}</small>}</div>
                    <div className="cm seps"><span>{cameraName(det.camera_id)}</span><span>{durationLabel(det)}</span></div>
                    <div className="m-tags">
                        <DetTags det={det} resolve={resolve} />
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
                    {!loading && !err && dets.length === 0 && (
                        <div className="empty">
                            <Icon name="empty" />
                            <b>Обнаружений нет</b>
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
