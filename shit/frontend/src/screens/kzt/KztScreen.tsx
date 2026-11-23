// Экран КЖТ: эфир камеры КЖТ с рамками, Modbus, последние обнаружения и место на карте; вне оболочки, как трансляция

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Icon, IconSprite } from '../../app/Icons';
import { formatDeviceDate, formatDeviceTime, useDeviceClock } from '../../app/useDeviceClock';
import { krspsApi } from '../../features/krsps/api/client';
import type { GwModbusModule, GwStatus, GwTime } from '../../features/krsps/types';
import { dictName } from '../../features/krsps/utils/dictionaries';
import { journalApi } from '../../features/neural/api/journal';
import type { JournalDetection } from '../../features/neural/api/journal-types';
import { DetTags, detClass } from '../../features/neural/components/journal/DetectionRow';
import { VERDICT_CLASS, VERDICT_LABEL } from '../../features/neural/components/journal/Filters';
import { FrameViewer } from '../../features/neural/components/journal/FrameViewer';
import { JournalMap, type MapHere } from '../../features/neural/components/journal/JournalMap';
import { fmtCoord, fmtTime } from '../../features/neural/components/journal/format';
import { useCameraNames } from '../../features/neural/components/journal/useCameraNames';
import { useClassResolver, useZoneColors } from '../../features/neural/components/journal/useClassResolver';
import { PHONE_QUERY, useIsMobile } from '../../mobile/useIsMobile';
import { api } from '../../services/api';
import { signalingWsUrl } from '../../services/devices';
import type { CPPCamera } from '../../types';
import { wsUrl } from '../../utils/constants';
import { isProbeCamera } from '../../utils/probeFilter';
import { configurationsApi, dictionariesOf, isKztTable, type CfLink, type CfRules } from '../configurations/api';
import { Wall } from '../live/Wall';
import { DEFAULT_OVERLAYS, PRESETS, type LayoutState } from '../live/model';
import { cameraToWallSource } from '../live/sources';
import '../../styles/tokens.css';
import '../../styles/ui.css';
import '../translation/translation.css';
import '../../features/neural/components/journal/journal.css';
import './kzt.css';

const STATUS_POLL_MS = 3_000;
const SOURCES_POLL_MS = 10_000;
const RULES_POLL_MS = 30_000;
const JOURNAL_POLL_MS = 5_000;
const LIST_LIMIT = 30;
const MAP_LIMIT = 2_000;
const WORK_REGISTER = 0x1007;
const PERIODS: Array<[string, string, number]> = [['hour', 'Час', 3_600_000], ['shift', 'Смена', 43_200_000], ['day', 'Сутки', 86_400_000]];

// Опрос с остановкой при уходе с экрана; ошибка даёт null
function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[]): T | null | undefined {
    const [value, setValue] = useState<T | null | undefined>(undefined);
    useEffect(() => {
        let alive = true;
        const run = () => load().then(v => alive && setValue(v)).catch(() => alive && setValue(null));
        run();
        const timer = window.setInterval(run, ms);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return value;
}

const seconds = (ms: number) => (ms / 1000).toFixed(1).replace('.', ',');
const mmss = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Состояние Modbus одной строкой: тон пилюли, подпись и показатели
function modbusView(status: GwStatus | null | undefined, module: GwModbusModule | undefined) {
    if (status === undefined) return { tone: '', label: 'загрузка…', master: '', stale: false };
    if (status === null) return { tone: 'err', label: 'шлюз недоступен', master: '', stale: true };
    if (!module) return { tone: 'err', label: 'нет модуля Modbus', master: '', stale: true };
    if (!module.connection.connected) return { tone: 'err', label: 'порт не открыт', master: module.connection.error || '', stale: true };
    const age = module.master.age_ms;
    if (!module.master.online) return { tone: 'warn', label: 'мастер молчит', master: age < 0 ? 'запросов не было' : `молчит ${mmss(age)}`, stale: true };
    return { tone: 'ok', label: 'на связи', master: `мастер ${seconds(age)} с`, stale: false };
}

export default function KztScreen() {
    const mobile = useIsMobile(PHONE_QUERY);
    const { unixMs, source: clockSource } = useDeviceClock();

    const status = usePoll<GwStatus>(() => krspsApi.getStatus(), STATUS_POLL_MS, []);
    const rules = usePoll<CfRules>(() => configurationsApi.getRules('kzt'), RULES_POLL_MS, []);
    const link = usePoll<CfLink>(() => configurationsApi.link(), STATUS_POLL_MS, []);
    const time = usePoll<GwTime>(() => krspsApi.getTime(), STATUS_POLL_MS, []);
    const cameras = usePoll<CPPCamera[]>(
        () => api.getSources().then(r => r.cameras.filter(c => !isProbeCamera(c.id))), SOURCES_POLL_MS, [],
    );

    // Экран живёт только при конфигурации КЖТ
    useEffect(() => {
        if (status && status.id && status.id !== 'kzt') window.location.replace('/translation');
    }, [status]);

    const rawTable = rules?.settings?.table;
    const table = isKztTable(rawTable) ? rawTable : undefined;
    const dicts = dictionariesOf(rules?.settings);
    const camera = useMemo(() => {
        const list = cameras ?? [];
        if (table?.camera_id) return list.find(c => c.id === table.camera_id) ?? null;
        return list.find(c => Object.values(c.streams ?? {}).some(s => s.purposes?.includes('neural'))) ?? null;
    }, [cameras, table?.camera_id]);
    const cameraId = camera?.id ?? '';

    // ── Видео: стена из одной ячейки ──
    const [seq, setSeq] = useState(0);
    const [boxes, setBoxes] = useState(true);
    const [corrected, setCorrected] = useState(false);
    const [live, setLive] = useState(0);
    const layout = useMemo<LayoutState>(() => ({
        name: 'kzt',
        grid: PRESETS[0].grid,
        cells: (cameraId ? { '0': cameraId } : {}) as Record<string, string>,
        streams: {},
        corrections: (cameraId ? { [cameraId]: corrected } : {}) as Record<string, boolean>,
        detections: (cameraId ? { [cameraId]: boxes } : {}) as Record<string, boolean>,
        overlays: { ...DEFAULT_OVERLAYS },
    }), [cameraId, boxes, corrected]);
    const sources = useMemo(() => (camera ? [cameraToWallSource(camera)] : []), [camera]);
    const signalingUrlOf = useCallback((sourceId: string, ownerId: string = sourceId) => {
        const owner = sources.find(item => item.id === ownerId)?.deviceId;
        return owner ? signalingWsUrl(owner, `/client/${sourceId}`) : wsUrl(`/signaling/client/${sourceId}`);
    }, [sources]);
    const view = camera ? Object.values(camera.streams ?? {}).find(s => s.purposes?.includes('view')) ?? Object.values(camera.streams ?? {})[0] : undefined;
    const ratio = view && view.width > 0 && view.height > 0 ? view.width / view.height : 4 / 3;

    // ── Обнаружения камеры ──
    const [dets, setDets] = useState<JournalDetection[]>([]);
    const [journalUp, setJournalUp] = useState<boolean | undefined>(undefined);
    useEffect(() => {
        if (!cameraId) return;
        let alive = true;
        const load = () => journalApi.list({ cameraId }, { limit: LIST_LIMIT })
            .then(r => { if (alive) { setDets(r.detections ?? []); setJournalUp(true); } })
            .catch(() => alive && setJournalUp(false));
        load();
        const timer = window.setInterval(load, JOURNAL_POLL_MS);
        return () => { alive = false; window.clearInterval(timer); };
    }, [cameraId]);

    const { resolve, configs } = useClassResolver();
    const zoneColor = useZoneColors(configs);
    const { cameraName } = useCameraNames();
    const [selected, setSelected] = useState<number | null>(null);
    const [viewer, setViewer] = useState<number | null>(null);

    // ── Карта на всё поле ──
    const [mapOpen, setMapOpen] = useState(false);
    const [period, setPeriod] = useState('shift');
    const [hidden, setHidden] = useState<Set<string>>(new Set());
    const [fixes, setFixes] = useState<JournalDetection[]>([]);
    const nowRef = useRef(unixMs);
    nowRef.current = unixMs;
    useEffect(() => {
        if (!mapOpen || !cameraId) return;
        let alive = true;
        const span = PERIODS.find(p => p[0] === period)![2];
        const load = () => journalApi.list({ cameraId, tFrom: (nowRef.current ?? Date.now()) - span }, { limit: MAP_LIMIT })
            .then(r => alive && setFixes(r.detections ?? []))
            .catch(() => alive && setFixes([]));
        load();
        const timer = window.setInterval(load, JOURNAL_POLL_MS);
        return () => { alive = false; window.clearInterval(timer); };
    }, [mapOpen, cameraId, period]);
    const classKey = (d: JournalDetection) => `${d.config_id}:${d.class_id}`;
    const classes = useMemo(() => {
        const out = new Map<string, { name: string; color: string; count: number }>();
        for (const d of fixes) {
            const c = detClass(d, resolve);
            const row = out.get(classKey(d)) ?? { name: c.name, color: c.color, count: 0 };
            row.count += 1;
            out.set(classKey(d), row);
        }
        return [...out.entries()];
    }, [fixes, resolve]);
    const shownFixes = useMemo(() => fixes.filter(d => !hidden.has(classKey(d))), [fixes, hidden]);

    // ── Положение ──
    const gps = time?.gps;
    const gpsNone = !gps || time?.source.gps === 'none' || (gps.lat === 0 && gps.lon === 0);
    const here: MapHere | null = gpsNone ? null : { lat: gps!.lat, lng: gps!.lon, fresh: gps!.valid };

    // ── Modbus и пакет ──
    const module = status?.modules.find(m => m.transport === 'modbus') as GwModbusModule | undefined;
    const mb = modbusView(status, module);
    const entry = link?.feed.find(e => e.module === 'modbus' && e.event === 'state');
    const attachments = entry?.attachments ?? [];
    const cargo = entry?.cargo ?? [];
    const cargoNames = table?.cargo ?? [];
    const work = module?.state?.registers.find(r => r.addr === WORK_REGISTER)?.value;
    const attName = (code: number) => dictName(dicts, 'attachment', code) ?? 'нет в словаре';

    const exit = () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        window.location.href = mobile ? '/app' : '/app/live';
    };
    const toggleFullscreen = () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen?.().catch(() => {});
    };
    const [fullscreen, setFullscreen] = useState(false);
    useEffect(() => {
        const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
    }, []);

    // Esc закрывает карту, если кадр не открыт поверх
    useEffect(() => {
        if (!mapOpen || viewer != null) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMapOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [mapOpen, viewer]);

    const openDet = (id: number) => {
        setSelected(id);
        setViewer(id);
    };
    const viewerList = mapOpen ? shownFixes : dets;
    const viewerIndex = viewer == null ? -1 : viewerList.findIndex(d => d.id === viewer);

    const verdict = (d: JournalDetection) => (
        <span className={`vd ${VERDICT_CLASS[d.verdict].vd}`}>
            <span className={`dot${VERDICT_CLASS[d.verdict].dot ? ' ' + VERDICT_CLASS[d.verdict].dot : ''}`} />
            {VERDICT_LABEL[d.verdict]}
        </span>
    );

    const packetTiles = (
        <div className={`kzs-words${mb.stale ? ' is-stale' : ''}`}>
            {[0, 1, 2].map(i => (
                <div key={`a${i}`} className="kzs-w is-att">
                    <span className="r">{15 + i}</span>
                    <span className="v">{attachments[i] ?? 0}</span>
                    <span className="l">{attachments[i] ? <b>{attName(attachments[i])}</b> : 'навесное'}</span>
                </div>
            ))}
            {[0, 1, 2].map(i => (
                <div key={`c${i}`} className={`kzs-w is-cargo${cargo[i] ? ' has' : ''}`}>
                    <span className="r">{18 + i}</span>
                    <span className="v">{cargo[i] ?? 0}</span>
                    <span className="l">{cargoNames[i] || '—'}</span>
                </div>
            ))}
            <div className={`kzs-w is-flag${work === 1 ? ' has' : ''}`}>
                <span className="r">21</span>
                <span className="v">{work ?? '—'}</span>
                <span className="l">работа</span>
            </div>
        </div>
    );
    const packetLine = (
        <div className={`kzs-pkt${mb.stale ? ' is-stale' : ''}`}>
            {attachments.length ? attachments.slice(0, 3).map(code => (
                <span key={code} className="kzs-att"><span className="kzs-code num">{code}</span><b>{attName(code)}</b></span>
            )) : <span className="kzs-dim">навесного нет</span>}
            <span className="kzs-cargo">
                {cargo.some(n => n > 0)
                    ? cargo.map((n, i) => n > 0 && <span key={i} className="otag">{cargoNames[i] || `груз ${i + 1}`}<span className="num">{n}</span></span>)
                    : <span className="kzs-dim">груза нет</span>}
            </span>
        </div>
    );

    return (
        <div className="tr kzs">
            <IconSprite />
            <div className="tr-bar">
                <b className="tr-title">КЖТ</b>
                <span className="tr-name">{camera?.display_name || cameraId || 'камера не выбрана'}</span>
                <span className={`pill ${live > 0 ? 'ok' : 'warn'}`}><span className="dot" />{live > 0 ? 'в эфире' : 'нет кадров'}</span>
                <span className="spacer" />
                <span className={`pill num${clockSource && clockSource !== 'server' ? '' : ' is-dim'}`}>
                    <span className="seps"><span>{formatDeviceDate(unixMs)}</span><span>{formatDeviceTime(unixMs)}</span></span>
                </span>
                <button className="icon-btn tr-plain" data-tip="Обновить поток" aria-label="Обновить поток" onClick={() => setSeq(v => v + 1)}>
                    <Icon name="refresh" />
                </button>
                <button className="icon-btn tr-plain" data-tip={fullscreen ? 'Свернуть' : 'Во весь экран'} aria-label={fullscreen ? 'Свернуть' : 'Во весь экран'} onClick={toggleFullscreen}>
                    <Icon name={fullscreen ? 'unfull' : 'full'} />
                </button>
                <button className="icon-btn tr-plain tr-exit" data-tip={mobile ? 'На главную' : 'Выйти в редактор'} aria-label={mobile ? 'На главную' : 'Выйти в редактор'} onClick={exit}>
                    <Icon name="x" />
                </button>
            </div>

            <div className="kzs-body">
                <div className="kzs-grid" style={{ '--ar': ratio } as CSSProperties}>
                    <div className="kzs-video">
                        {camera ? (
                            <Wall
                                grid={layout.grid}
                                layout={layout}
                                sources={sources}
                                switchKey={`${cameraId}#${seq}`}
                                signalingUrlOf={signalingUrlOf}
                                deviceTimeMs={unixMs}
                                onDetectionsChange={(_, value) => setBoxes(value)}
                                onCorrectedChange={(_, value) => setCorrected(value)}
                                onLiveCount={n => setLive(n)}
                            />
                        ) : (
                            <div className="kzs-empty">
                                {cameras === undefined || rules === undefined ? 'Загрузка…'
                                    : table?.camera_id ? `Камеры ${table.camera_id} нет в профиле` : 'Камера КЖТ не выбрана в правилах КЖТ'}
                            </div>
                        )}
                    </div>

                    <section className="card kzs-mb">
                        <div className="card-h">
                            <h3>Modbus</h3>
                            <span className={`pill ${mb.tone}`} data-tip={mb.tone === 'err' && mb.master ? mb.master : undefined}><span className="dot" />{mb.label}</span>
                            <span className="spacer" />
                            <span className="meta">{entry ? `пакет ${new Date(entry.t).toLocaleTimeString('ru-RU', { hour12: false })}` : 'пакета ещё не было'}</span>
                        </div>
                        <div className="kzs-mb-b">
                            {packetTiles}
                            {packetLine}
                            {module && (
                                <div className="kzs-mb-line seps">
                                    {mb.tone !== 'err' && <span className={mb.tone === 'warn' ? 'warn' : ''}>{mb.master}</span>}
                                    <span className={module.queue.visible > 0 && mb.stale ? 'warn' : ''}>в очереди {module.queue.visible}</span>
                                    <span className={module.counters.exceptions + module.counters.crc_errors > 0 ? 'warn' : ''}>
                                        ошибок {module.counters.exceptions + module.counters.crc_errors}
                                    </span>
                                </div>
                            )}
                        </div>
                    </section>

                    <section className="card kzs-list">
                        <div className="card-h">
                            <h3>Последние обнаружения</h3>
                            <span className="tag">{dets.length}</span>
                            <span className="spacer" />
                            <a className="btn btn--ghost btn--sm" href="/app/neural/journal">Журнал</a>
                        </div>
                        <div className="kzs-lw">
                            <div className="j-head kzs-jh"><span>Время</span><span>Объект</span><span>Координаты</span><span>Вердикт</span></div>
                            <div className="kzs-rows">
                                {dets.map(d => (
                                    <button key={d.id} type="button" className={`kzs-dr${selected === d.id ? ' is-sel' : ''}`} onClick={() => openDet(d.id)}>
                                        <span className="j-ts">{fmtTime(d.started_at)}</span>
                                        <span className="j-obj"><DetTags det={d} resolve={resolve} /></span>
                                        <span className="j-tr">{d.gps ? `${fmtCoord(d.gps.lat)}, ${fmtCoord(d.gps.lon)}` : 'нет координат'}</span>
                                        {verdict(d)}
                                    </button>
                                ))}
                                {dets.length === 0 && (
                                    <div className="kzs-none">
                                        {journalUp === false ? 'Журнал обнаружений недоступен' : journalUp ? 'Обнаружений пока нет' : 'Загрузка…'}
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>

                    <section className="card kzs-geo">
                        <div className="card-h">
                            <h3>Положение</h3>
                            {gpsNone ? <span className="pill warn"><span className="dot" />нет данных</span>
                                : gps!.valid ? <span className="pill ok"><span className="dot" />актуальны</span>
                                    : <span className="pill err"><span className="dot" />устарели</span>}
                        </div>
                        <div className="kzs-coords">
                            <div><span className="k">Широта</span><span className="v">{here ? `${here.lat.toFixed(5)}° ${here.lat < 0 ? 'S' : 'N'}` : '—'}</span></div>
                            <div><span className="k">Долгота</span><span className="v">{here ? `${here.lng.toFixed(5)}° ${here.lng < 0 ? 'W' : 'E'}` : '—'}</span></div>
                        </div>
                        <div className="kzs-geo-map">
                            {!mapOpen && (
                                <JournalMap
                                    detections={dets}
                                    selectedId={selected}
                                    mode="single"
                                    resolve={resolve}
                                    cameraName={cameraName}
                                    onSelect={setSelected}
                                    onOpenViewer={openDet}
                                    here={here}
                                />
                            )}
                            {!mobile && (
                                <button className="icon-btn fs kzs-expand" onClick={() => setMapOpen(true)} aria-label="Развернуть карту" data-tip="Развернуть карту">
                                    <Icon name="full" size={14} />
                                </button>
                            )}
                        </div>
                    </section>

                    {mapOpen && (
                        <div className="kzs-over">
                            <div className="j-full">
                                <JournalMap
                                    detections={shownFixes}
                                    selectedId={selected}
                                    mode="full"
                                    resolve={resolve}
                                    cameraName={cameraName}
                                    onSelect={setSelected}
                                    onOpenViewer={openDet}
                                    here={here}
                                />
                                <div className="pane">
                                    <div className="blk-h"><h3>Фиксации</h3><span className="spacer" /><span className="tag">{shownFixes.filter(d => d.gps).length}</span></div>
                                    <div className="blk-b">
                                        <div className="seg">
                                            {PERIODS.map(([key, label]) => (
                                                <button key={key} className={period === key ? 'is-on' : ''} onClick={() => setPeriod(key)}>{label}</button>
                                            ))}
                                        </div>
                                        <div className="kzs-cls-list">
                                            {classes.map(([key, c]) => (
                                                <button
                                                    key={key}
                                                    className={`kzs-cls${hidden.has(key) ? ' is-off' : ''}`}
                                                    onClick={() => setHidden(prev => {
                                                        const next = new Set(prev);
                                                        if (next.has(key)) next.delete(key); else next.add(key);
                                                        return next;
                                                    })}
                                                >
                                                    <i className="sw-col" style={{ background: c.color }} />
                                                    <span>{c.name}</span>
                                                    <b className="num">{c.count}</b>
                                                </button>
                                            ))}
                                            {classes.length === 0 && <span className="kzs-dim">За период обнаружений нет</span>}
                                        </div>
                                    </div>
                                </div>
                                <button className="icon-btn close" onClick={() => setMapOpen(false)} aria-label="Закрыть карту" data-tip="Закрыть карту">
                                    <Icon name="x" size={14} />
                                </button>
                                <div className="cnt">
                                    <span className="tag">{fixes.length} обнаружений</span>
                                    <span className="tag">{fixes.filter(d => d.gps).length} с координатами</span>
                                    <span className={`tag${here ? ' is-acc' : ' is-warn'}`}>{here ? 'текущее место на карте' : 'текущее место неизвестно'}</span>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {viewer != null && viewerIndex >= 0 && (
                <FrameViewer
                    det={viewerList[viewerIndex]}
                    initialShot={null}
                    resolve={resolve}
                    zoneColor={zoneColor}
                    cameraName={cameraName}
                    hasPrev={viewerIndex > 0}
                    hasNext={viewerIndex < viewerList.length - 1}
                    onPrev={() => setViewer(viewerList[viewerIndex - 1].id)}
                    onNext={() => setViewer(viewerList[viewerIndex + 1].id)}
                    onClose={() => setViewer(null)}
                    onChange={updated => {
                        setDets(list => list.map(d => (d.id === updated.id ? updated : d)));
                        setFixes(list => list.map(d => (d.id === updated.id ? updated : d)));
                    }}
                />
            )}
        </div>
    );
}
