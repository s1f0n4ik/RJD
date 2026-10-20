import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { isModalOpen, Seg } from '../../app/Modal';
import { Select } from '../../app/Select';
import { useToast } from '../../app/Toast';
import { neuralApi, neuralDeviceId } from '../../features/neural/api/client';
import type { ConfigSummary, StreamTile, TileFit, VideoStream, ZoneDef, ZonePolygon } from '../../features/neural/api/types';
import { signalingWsUrl } from '../../services/devices';
import { CanvasGridModal, type GridCell } from './CanvasGridModal';
import { ratio, viewFor, type EditorCamera } from './editor-cameras';
import { modelQuant, modelSize, modelTask, plural, zoneCount } from './model-desc';
import {
    borderRuns, cellRect, clamp, cropForCell, edges, moveCrop, resizeCrop, svgPoint, tileAt, tileCell, tileDst,
    withCamerasOnly, zoomCrop, type Cell, type Crop, type Handle, type Rect,
} from './stream-geometry';
import { EDITOR_STREAM_ID, useEditorSession } from './useEditorSession';
import { VideoBox } from './VideoBox';
import { drawOrder, flatOf, ptsOf, ZoneOverlay, type ZoneState } from './ZoneOverlay';

// Размеры разметки в экранных пикселях: делятся на масштаб «пикселей экрана на единицу»
const ANCHOR_PX = 10.5;
const ANCHOR_HIT_PX = 22;
const SIDE_HIT_PX = 10;
const BORDER_HIT_PX = 16;
const ID_RE = /^[A-Za-z0-9_-]+$/;
// Размер кадра нейронки, пока камера его не сообщила
const FALLBACK_FRAME = { width: 1280, height: 960 };

type Drag =
    | { kind: 'pan'; i: number; x0: number; y0: number; crop: Crop; dst: Rect; moved: boolean }
    | { kind: 'win'; i: number; x0: number; y0: number; crop: Crop; moved: boolean }
    | { kind: 'wh'; i: number; h: Handle; crop: Crop; moved: boolean }
    | { kind: 'border'; vertical: boolean; i: number; e: number[]; fr: number[]; moved: boolean };

// Окна тайлов: рамки окон модели; зоны: многоугольники каталога на кадре камеры
type Mode = 'win' | 'zones';

const NO_ZONE_EDIT: Partial<ZoneState> = { poly: null, draw: null, armed: false };

const fullWeights = (n: number, fr: number[]) => (fr.length === n ? [...fr] : Array.from({ length: n }, () => 1));
const fmtCrop = (v: number) => v.toFixed(2).replace('.', ',');

interface StreamEditorProps {
    initial: VideoStream;
    isNew: boolean;
    configs: ConfigSummary[];
    /** Каталоги зон по конфигурациям */
    zonesBy: Record<string, ZoneDef[]>;
    cameras: EditorCamera[];
    /** Конфигурации слотов на этом потоке */
    slotConfigs: string[];
    onBack: () => void;
    onSaved: (stream: VideoStream) => void;
}

export function StreamEditor({ initial, isNew, configs, zonesBy, cameras, slotConfigs, onBack, onSaved }: StreamEditorProps) {
    const toast = useToast();
    const navigate = useNavigate();

    // Конфигурация редактора: под её модель полотно и её зоны рисуются; сначала — конфигурация слота на потоке
    const [configId, setConfigId] = useState(() =>
        slotConfigs[0]
        ?? configs.find(c => c.model && c.model.input_width === initial.width && c.model.input_height === initial.height)?.id
        ?? configs[0]?.id ?? '');
    const session = useEditorSession(initial, configId);

    const [S, setS] = useState<VideoStream>(initial);
    const [saved, setSaved] = useState(() => JSON.stringify(initial));
    const [created, setCreated] = useState(!isNew);
    const [sel, setSel] = useState<Cell>(() => (initial.tiles[0] ? { r: initial.tiles[0].row, c: initial.tiles[0].col } : { r: 0, c: 0 }));
    const [saving, setSaving] = useState(false);
    const [srcShare, setSrcShare] = useState<number | null>(null);
    const [gridOpen, setGridOpen] = useState(false);
    const [mode, setMode] = useState<Mode>('win');
    const [zcam, setZcam] = useState('');
    const [zs, setZsState] = useState<ZoneState>({ zone: 0, poly: null, armed: false, draw: null });
    // Режим зон: кадр вне окон модели затемнён
    const [dimOut, setDimOut] = useState(true);
    const setZs = useCallback((p: Partial<ZoneState>) => setZsState(s => ({ ...s, ...p })), []);

    const sRef = useRef(S);
    sRef.current = S;
    const dragRef = useRef<Drag | null>(null);
    const [dragging, setDragging] = useState<Drag | null>(null);

    const deviceId = useMemo(() => neuralDeviceId(), []);

    // Размер полотна задаёт модель конфигурации: его сообщает редактор при открытии
    useEffect(() => {
        const size = session.size;
        if (!size) return;
        setS(prev => (prev.width === size.width && prev.height === size.height ? prev : { ...prev, width: size.width, height: size.height }));
    }, [session.size]);

    const { update } = session;
    const commit = useCallback((next: VideoStream, final = true) => {
        setS(next);
        update(next, final);
    }, [update]);

    const config = configs.find(c => c.id === configId) ?? null;
    const catalog = zonesBy[configId] ?? [];
    const curZone = catalog.some(z => z.id === zs.zone) ? zs.zone : catalog[0]?.id ?? 0;

    const dirty = JSON.stringify(S) !== saved || !created;
    const selIdx = tileAt(S, sel.r, sel.c);
    const selTile: StreamTile | null = selIdx >= 0 ? S.tiles[selIdx] : null;
    const streamCams = [...new Set(S.tiles.map(t => t.camera).filter(Boolean))];
    const camOf = (id: string) => cameras.find(c => c.id === id) ?? null;
    const frameOf = (id: string) => {
        const c = camOf(id);
        if (c?.neural.width && c.neural.height) return { width: c.neural.width, height: c.neural.height };
        const t = session.tiles.find(p => p.camera === id && p.camera_width > 0);
        return t ? { width: t.camera_width, height: t.camera_height } : FALLBACK_FRAME;
    };
    const tileState = (cam: string) => session.tiles.find(p => p.camera === cam)?.state ?? null;
    const dead = (cam: string) => tileState(cam) === 'no_camera' || tileState(cam) === 'stalled';
    const polysOf = (cam: string): ZonePolygon[] => S.zones?.[configId]?.[cam] ?? [];
    const polys = polysOf(zcam);

    // Слоты на потоке, чья модель не под нынешнее полотно: сохранение они отвергнут
    const blocking = slotConfigs
        .map(id => configs.find(c => c.id === id)?.model)
        .filter(m => !!m && (m.input_width !== S.width || m.input_height !== S.height));

    const patchTile = (i: number, p: Partial<StreamTile>, final = true) =>
        commit({ ...sRef.current, tiles: sRef.current.tiles.map((t, j) => (j === i ? { ...t, ...p } : t)) }, final);

    const removeSelected = () => {
        const s = sRef.current;
        const i = tileAt(s, sel.r, sel.c);
        if (i < 0 || !s.tiles[i].camera) return;
        commit({ ...s, tiles: s.tiles.filter((_, j) => j !== i) });
    };

    const assign = (camera: string) => {
        const s = sRef.current;
        const i = tileAt(s, sel.r, sel.c);
        if (i >= 0) patchTile(i, { camera });
        else commit({ ...s, tiles: [...s.tiles, { camera, row: sel.r, col: sel.c, row_span: 1, col_span: 1, crop: [0, 0, 1, 1], fit: 'letterbox' }] });
    };

    // Ячейка, которая начинается там же, где тайл с камерой, сохраняет камеру и окно; остальные приходят пустыми
    const applyGrid = (rows: number, cols: number, cells: GridCell[]) => {
        const s = sRef.current;
        const old = (r: number, c: number) => s.tiles.find(t => t.row === r && t.col === c && t.camera);
        const tiles: StreamTile[] = cells.map(x => {
            const t = old(x.row, x.col);
            return t
                ? { ...t, row_span: x.rowSpan, col_span: x.colSpan }
                : { camera: '', row: x.row, col: x.col, row_span: x.rowSpan, col_span: x.colSpan, crop: [0, 0, 1, 1], fit: 'letterbox' };
        });
        commit({ ...s, rows, cols, row_fr: rows === s.rows ? s.row_fr : [], col_fr: cols === s.cols ? s.col_fr : [], tiles });
        const first = tiles.find(t => t.camera) ?? tiles[0];
        setSel(first ? { r: first.row, c: first.col } : { r: 0, c: 0 });
        setGridOpen(false);
    };

    const changeConfig = (id: string) => {
        setConfigId(id);
        session.reopen(sRef.current, id);
        setZs(NO_ZONE_EDIT);
        if (!zonesBy[id]?.length) setMode('win');
    };

    // ── Зоны ──
    const setPolys = (list: ZonePolygon[], final: boolean) => {
        const s = sRef.current;
        const byCam = { ...(s.zones?.[configId] ?? {}) };
        if (list.length) byCam[zcam] = list;
        else delete byCam[zcam];
        const zones = { ...(s.zones ?? {}) };
        if (Object.keys(byCam).length) zones[configId] = byCam;
        else delete zones[configId];
        commit({ ...s, zones }, final);
    };

    const closeDraw = () => {
        if (!zs.draw || zs.draw.pts.length < 3) return;
        const list = [...polys, { zone: curZone, points: flatOf(zs.draw.pts) }];
        setPolys(list, true);
        setZs({ poly: list.length - 1, draw: null, armed: false });
    };

    const deletePoly = () => {
        if (zs.poly == null) return;
        setPolys(polys.filter((_, i) => i !== zs.poly), true);
        setZs({ poly: null });
    };

    // Выбран контур — меняется его зона, иначе зона нового контура
    const pickZone = (id: number) => {
        if (zs.poly != null && polys[zs.poly]) {
            setPolys(polys.map((p, i) => (i === zs.poly ? { ...p, zone: id } : p)), true);
            setZs({ zone: id });
        } else setZs({ zone: id, armed: true });
    };

    const switchCam = (cam: string) => {
        setZcam(cam);
        setZs({ poly: null, draw: null });
    };

    const zonesBlocked = !catalog.length ? `В конфигурации «${config?.name || configId}» зон нет` : !streamCams.length ? 'Поставьте камеру в полотно' : null;
    const toggleZones = () => {
        if (mode === 'zones') { setMode('win'); setZs(NO_ZONE_EDIT); return; }
        if (zonesBlocked) return;
        setZcam(selTile?.camera || streamCams[0]);
        setZs(NO_ZONE_EDIT);
        setMode('zones');
    };

    // Окна: Delete освобождает ячейку. Зоны: Enter замыкает, Esc снимает по шагу, Delete удаляет контур
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (t?.closest('input, textarea, select, [contenteditable="true"]') || isModalOpen()) return;
            if (mode === 'win') {
                if (e.key !== 'Delete') return;
                removeSelected();
            } else if (e.key === 'Enter' && zs.draw && zs.draw.pts.length >= 3) closeDraw();
            else if (e.key === 'Escape') {
                if (zs.draw) setZs({ draw: null });
                else if (zs.poly != null) setZs({ poly: null });
                else if (zs.armed) setZs({ armed: false });
                else return;
            } else if (e.key === 'Delete' && zs.poly != null) deletePoly();
            else return;
            e.preventDefault();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    const save = async () => {
        const s = sRef.current;
        if (!created && !ID_RE.test(s.id)) { toast('Нужен идентификатор', 'Латиница, цифры, «_» и «-»', 'err'); return; }
        if (!s.tiles.some(t => t.camera)) { toast('Нет камер', 'Поставьте в полотно хотя бы одну камеру', 'err'); return; }
        if (blocking.length) {
            const n = blocking.length;
            toast('Не сохранено', `В ${n} ${plural(n, 'слоте', 'слотах', 'слотах')} модель ${modelSize(blocking[0]!)}, полотно ${s.width}×${s.height}`, 'err');
            return;
        }
        setSaving(true);
        try {
            const res = await neuralApi.saveStream(withCamerasOnly({ ...s, name: s.name.trim() || s.id }));
            const next = { ...s, name: res.name };
            setS(next);
            setSaved(JSON.stringify(next));
            setCreated(true);
            toast('Видеопоток сохранён', slotConfigs.length ? 'Слоты с ним перезапускаются' : next.name, 'ok');
            onSaved(res);
        } catch (e) {
            toast('Не сохранено', e instanceof Error ? e.message : String(e), 'err');
        } finally {
            setSaving(false);
        }
    };

    const undo = () => {
        commit(JSON.parse(saved) as VideoStream);
        setZs(NO_ZONE_EDIT);
    };

    // ── Перетаскивание: полотно и кадр камеры ──
    const beginDrag = (svg: SVGSVGElement, pointerId: number, d: Drag) => {
        svg.setPointerCapture(pointerId);
        dragRef.current = d;
        setDragging(d);
    };

    const onCanvasDown = (e: React.PointerEvent<SVGSVGElement>) => {
        if (e.button !== 0) return;
        const a = (e.target as Element).closest('[data-act]') as SVGElement | null;
        if (!a) return;
        const svg = e.currentTarget, p = svgPoint(svg, e), s = sRef.current, act = a.dataset.act;
        if (mode === 'zones') {
            const t = act === 'tile' ? s.tiles[Number(a.dataset.i)] : null;
            if (t?.camera && t.camera !== zcam) switchCam(t.camera);
            return;
        }
        if (act === 'del') { removeSelected(); return; }
        if (act === 'empty') { setSel({ r: Number(a.dataset.r), c: Number(a.dataset.c) }); return; }
        if (act === 'dc' || act === 'dr') {
            const vertical = act === 'dc', i = Number(a.dataset.i);
            beginDrag(svg, e.pointerId, {
                kind: 'border', vertical, i, moved: false,
                e: vertical ? edges(s.width, s.cols, s.col_fr) : edges(s.height, s.rows, s.row_fr),
                fr: vertical ? fullWeights(s.cols, s.col_fr) : fullWeights(s.rows, s.row_fr),
            });
            return;
        }
        if (act === 'tile') {
            const i = Number(a.dataset.i), t = s.tiles[i];
            setSel({ r: t.row, c: t.col });
            if (!t.camera) return;
            const f = frameOf(t.camera);
            beginDrag(svg, e.pointerId, { kind: 'pan', i, x0: p.x, y0: p.y, crop: t.crop, dst: tileDst(s, t, f.width, f.height), moved: false });
        }
    };

    const onSourceDown = (e: React.PointerEvent<SVGSVGElement>) => {
        if (e.button !== 0) return;
        const a = (e.target as Element).closest('[data-act]') as SVGElement | null;
        if (!a) return;
        const svg = e.currentTarget, p = svgPoint(svg, e), s = sRef.current, i = Number(a.dataset.i), t = s.tiles[i];
        if (!t) return;
        setSel({ r: t.row, c: t.col });
        if (a.dataset.act === 'win') beginDrag(svg, e.pointerId, { kind: 'win', i, x0: p.x, y0: p.y, crop: t.crop, moved: false });
        if (a.dataset.act === 'wh') beginDrag(svg, e.pointerId, { kind: 'wh', i, h: a.dataset.h as Handle, crop: t.crop, moved: false });
    };

    const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
        const d = dragRef.current;
        if (!d) return;
        const p = svgPoint(e.currentTarget, e), s = sRef.current;
        d.moved = true;
        if (d.kind === 'border') {
            const i = d.i, v = clamp(d.vertical ? p.x : p.y, d.e[i - 1] + 40, d.e[i + 1] - 40);
            const pair = d.fr[i - 1] + d.fr[i], a = v - d.e[i - 1], b = d.e[i + 1] - v;
            const fr = [...d.fr];
            fr[i - 1] = (pair * a) / (a + b);
            fr[i] = (pair * b) / (a + b);
            commit(d.vertical ? { ...s, col_fr: fr } : { ...s, row_fr: fr }, false);
            return;
        }
        const t = s.tiles[d.i];
        if (!t) return;
        const f = frameOf(t.camera);
        if (d.kind === 'pan') patchTile(d.i, { crop: moveCrop(d.crop, -(p.x - d.x0) / d.dst.w * d.crop[2], -(p.y - d.y0) / d.dst.h * d.crop[3]) }, false);
        if (d.kind === 'win') patchTile(d.i, { crop: moveCrop(d.crop, (p.x - d.x0) / f.width, (p.y - d.y0) / f.height) }, false);
        if (d.kind === 'wh') patchTile(d.i, { crop: resizeCrop(d.crop, d.h, p.x / f.width, p.y / f.height) }, false);
    };

    const onUp = () => {
        const d = dragRef.current;
        dragRef.current = null;
        setDragging(null);
        if (d?.moved) update(sRef.current, true);
    };

    // Колесо — масштаб окна; итог уходит, когда прокрутка затихла
    const wheelEnd = useRef<number | null>(null);
    const onWheel = (source: boolean) => (e: WheelEvent, svg: SVGSVGElement) => {
        if (mode === 'zones') return;
        const a = (e.target as Element).closest(source ? '[data-act="win"]' : '[data-act="tile"]') as SVGElement | null;
        if (!a) return;
        const s = sRef.current, i = Number(a.dataset.i), t = s.tiles[i];
        if (!t?.camera) return;
        e.preventDefault();
        const p = svgPoint(svg, e), f = frameOf(t.camera);
        let fx: number, fy: number;
        if (source) { fx = (p.x / f.width - t.crop[0]) / t.crop[2]; fy = (p.y / f.height - t.crop[1]) / t.crop[3]; }
        else { const d = tileDst(s, t, f.width, f.height); fx = (p.x - d.x) / d.w; fy = (p.y - d.y) / d.h; }
        setSel({ r: t.row, c: t.col });
        patchTile(i, { crop: zoomCrop(t.crop, e.deltaY > 0 ? 1.08 : 1 / 1.08, clamp(fx, 0, 1), clamp(fy, 0, 1)) }, false);
        if (wheelEnd.current) window.clearTimeout(wheelEnd.current);
        wheelEnd.current = window.setTimeout(() => update(sRef.current, true), 180);
    };

    // ── Разделитель кадр | полотно, как в «Сборке» 360 ──
    const splitRef = useRef<HTMLDivElement>(null);
    const onGutterDown = (e: React.PointerEvent<HTMLDivElement>) => {
        const box = splitRef.current;
        if (!box) return;
        const r = box.getBoundingClientRect(), g = e.currentTarget;
        g.setPointerCapture(e.pointerId);
        g.classList.add('is-drag');
        const move = (ev: PointerEvent) => setSrcShare(clamp((ev.clientX - r.left) / r.width, 0.2, 0.8));
        const up = () => { g.classList.remove('is-drag'); g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); };
        g.addEventListener('pointermove', move);
        g.addEventListener('pointerup', up);
    };

    // ── Кадр слева: камера выбранной ячейки или камера зон ──
    const zonesOn = mode === 'zones';
    const configOptions = configs.map(c => ({
        value: c.id,
        label: c.name || c.id,
        hint: c.model ? `${modelSize(c.model)} · ${modelQuant(c.model)} · ${zoneCount(zonesBy[c.id]?.length ?? 0)}` : 'модель не прочитана',
        muted: !c.model,
    }));
    const stageCam = zonesOn ? zcam : selTile?.camera || '';
    const stageCamObj = stageCam ? camOf(stageCam) : null;
    const stageView = stageCamObj ? viewFor(stageCamObj) : null;
    const stageFrame = stageCam ? frameOf(stageCam) : FALLBACK_FRAME;
    const selPoly = zs.poly != null ? polys[zs.poly] ?? null : null;
    const stZone = catalog.find(z => z.id === (selPoly ? selPoly.zone : curZone)) ?? null;
    const vertices = zs.draw ? zs.draw.pts.length : selPoly ? selPoly.points.length / 2 : 0;
    const zoneOn = (z: ZoneDef) => (selPoly ? selPoly.zone === z.id : curZone === z.id);

    const zoneBtn = (
        <button className={`btn btn--sm ve-zbtn${zonesOn ? ' is-on' : ''}`} aria-disabled={!zonesOn && !!zonesBlocked}
            data-tip={zonesOn ? undefined : zonesBlocked ?? undefined} onClick={toggleZones}>
            <Icon name="poly" className="ico" />Зоны
        </button>
    );

    return (
        <div className="ve">
            <div className="ve-h">
                <button className="ve-back" onClick={onBack}><Icon name="chev" size={13} />Видеопотоки</button>
                <span className="ve-cfg">
                    <Select value={config ? configId : ''} options={configOptions} onChange={changeConfig} placeholder="Конфигурация" />
                </span>
                <label className="ve-namebox" data-tip="Переименовать видеопоток">
                    <input className="ve-name" value={S.name} placeholder={created ? S.id : 'Название'} aria-label="Название видеопотока"
                        onChange={e => setS({ ...S, name: e.target.value })} />
                    <Icon name="pen" size={14} />
                </label>
                {created
                    ? <span className="ve-id">{S.id}</span>
                    : <input className="tf-in ve-idin" value={S.id} placeholder="идентификатор" aria-label="Идентификатор"
                        onChange={e => setS({ ...S, id: e.target.value.trim() })} />}
                <span className="spacer" />
                {dirty && <span className="tag is-warn">не сохранено</span>}
                <button className="btn" disabled={!created || JSON.stringify(S) === saved || saving} onClick={undo}>Отменить</button>
                <button className="btn btn--acc" disabled={!dirty || saving} onClick={save}>Сохранить</button>
            </div>

            <div className="ve-split" ref={splitRef}>
                <section className="ve-pane" style={srcShare ? { flex: `0 0 ${(srcShare * 100).toFixed(1)}%` } : undefined}>
                    <div className="ve-pane-h">
                        {zonesOn ? (
                            <>
                                <Seg className="ve-camseg">
                                    {streamCams.map(c => <button key={c} className={c === zcam ? 'is-on' : ''} onClick={() => switchCam(c)}>{c}</button>)}
                                </Seg>
                                <span className="spacer" />
                                {zoneBtn}
                            </>
                        ) : selTile?.camera ? (
                            <>
                                <span className="ve-cam">
                                    <Select value={selTile.camera} onChange={assign}
                                        options={cameras.map(c => ({ value: c.id, label: c.name, hint: `${c.neural.width}×${c.neural.height}` }))} />
                                </span>
                                <CellCap s={S} sel={sel} idx={selIdx} />
                                <span className="spacer" />
                                {zoneBtn}
                                <Seg className="ve-fit">
                                    {(['letterbox', 'stretch'] as TileFit[]).map(f => (
                                        <button key={f} className={selTile.fit === f ? 'is-on' : ''} onClick={() => patchTile(selIdx, { fit: f })}>
                                            {f === 'letterbox' ? 'Вписать' : 'Растянуть'}
                                        </button>
                                    ))}
                                </Seg>
                            </>
                        ) : (
                            <><CellCap s={S} sel={sel} idx={selIdx} /><span className="spacer" />{zoneBtn}</>
                        )}
                    </div>

                    {zonesOn ? (
                        <div className="ve-zrow">
                            {catalog.map((z, i) => (
                                <button key={z.id} className={`ve-zc${zoneOn(z) ? ' is-on' : ''}`} style={{ '--z': z.color } as React.CSSProperties} onClick={() => pickZone(z.id)}>
                                    <b>{i + 1}</b><i className="zone-g" /><span>{z.name}</span>
                                </button>
                            ))}
                            <button className="ve-zlink" onClick={() => navigate(`/neural/configs?config=${encodeURIComponent(configId)}`)}>
                                Изменить в конфигурации<Icon name="chev" />
                            </button>
                        </div>
                    ) : selTile?.camera && stageCamObj && !dead(selTile.camera) && (
                        stageView === null ? (
                            <div className="ve-view warn"><i />У камеры нет потока с назначением «Просмотр» — кадр показать нечем</div>
                        ) : stageView.self ? (
                            <div className="ve-view"><i />Просмотр: <b>{stageView.stream.key} · {stageView.stream.width}×{stageView.stream.height}</b> — тот же поток, что идёт в нейронку</div>
                        ) : stageView.same ? (
                            <div className="ve-view"><i />Просмотр: <b>{stageView.stream.key} · {stageView.stream.width}×{stageView.stream.height}</b> — пропорция как у нейронки ({stageCamObj.neural.width}×{stageCamObj.neural.height})</div>
                        ) : (
                            <div className="ve-view warn"><i /><span>Просмотр <b>{stageView.stream.width}×{stageView.stream.height} ({ratio(stageView.stream.width, stageView.stream.height)})</b> растянут под нейронку <b>{stageCamObj.neural.width}×{stageCamObj.neural.height} ({ratio(stageCamObj.neural.width, stageCamObj.neural.height)})</b>: картинка искажена, окно стоит точно. Без искажений — добавьте камере поток просмотра {ratio(stageCamObj.neural.width, stageCamObj.neural.height)}.</span></div>
                        )
                    )}

                    <div className="ve-stage">
                        {!stageCam ? (
                            <Picker cameras={cameras} deviceId={deviceId} sel={sel} onPick={assign} />
                        ) : dead(stageCam) ? (
                            <div className="ve-nocam">Камеры {stageCam} нет в хранилище.<br />Её ячейка уходит в модель серой, остальные работают.</div>
                        ) : stageCamObj && stageView ? (
                            <VideoBox key={`${stageCam}:${stageView.stream.key}`} cameraId={stageCam} stream={stageView.stream.key}
                                signalingUrl={signalingWsUrl(deviceId, `/client/${stageCam}`)} aspect={stageFrame.width / stageFrame.height}>
                                {size => zonesOn ? (
                                    <ZoneOverlay
                                        polys={polys} catalog={catalog} frame={stageFrame} u={stageFrame.width / size.w} dim={dimOut}
                                        windows={S.tiles.flatMap((t, i) => (t.camera === stageCam ? [{ n: i + 1, crop: t.crop }] : []))}
                                        zs={{ ...zs, zone: curZone }} setZs={setZs} onPolys={setPolys} onCloseDraw={closeDraw} onDelete={deletePoly}
                                    />
                                ) : (
                                    <SourceOverlay
                                        s={S} cam={stageCam} selIdx={selIdx} frame={stageFrame} u={stageFrame.width / size.w}
                                        polys={polysOf(stageCam)} catalog={catalog}
                                        onDown={onSourceDown} onMove={onMove} onUp={onUp} onWheel={onWheel(true)}
                                    />
                                )}
                            </VideoBox>
                        ) : (
                            <div className="ve-nocam">Камеры {stageCam} нет среди камер с назначением «Техническое зрение»</div>
                        )}
                    </div>

                    <div className="ve-pane-f">
                        {zonesOn ? (
                            <>
                                {stZone && <span className="ve-zst"><i className="zone-g" style={{ '--z': stZone.color } as React.CSSProperties} />{stZone.name}</span>}
                                {vertices > 0 && <span className="ve-zn">{vertices} {plural(vertices, 'вершина', 'вершины', 'вершин')}</span>}
                                <span className="ve-hint">
                                    {zs.draw ? (
                                        <><span><kbd>Enter</kbd>замкнуть</span><span><kbd>2×щелчок</kbd>последняя вершина</span><span><kbd>Esc</kbd>отменить</span></>
                                    ) : selPoly ? (
                                        <><span><kbd>тянуть</kbd>сдвиг</span><span><kbd>2×щелчок</kbd>по вершине — убрать</span><span><kbd>Delete</kbd>удалить</span><span><kbd>Esc</kbd>снять</span></>
                                    ) : (
                                        <><span><kbd>щелчок</kbd>первая вершина</span><span><kbd>щелчок</kbd>по контуру — выбрать</span></>
                                    )}
                                </span>
                                <button className={`icon-btn ve-dimbtn${dimOut ? ' is-on' : ''}`} aria-pressed={dimOut} data-tip="Затемнять вне окон модели"
                                    onClick={() => setDimOut(v => !v)}>
                                    <Icon name="dim" size={15} />
                                </button>
                            </>
                        ) : selTile?.camera ? (
                            <>
                                <span className="ve-crop">
                                    <span className="eyebrow">Окно</span>
                                    <span className="seps">
                                        {(['x', 'y', 'ш', 'в'] as const).map((k, j) => <span key={k}><em>{k}</em>{fmtCrop(selTile.crop[j])}</span>)}
                                    </span>
                                </span>
                                <span className="spacer" />
                                <button className="icon-btn" data-tip="Окно под ячейку"
                                    onClick={() => patchTile(selIdx, { crop: cropForCell(selTile.crop, tileCell(S, selTile), stageFrame.width, stageFrame.height) })}>
                                    <Icon name="gab" size={15} />
                                </button>
                                <button className="icon-btn" data-tip="Весь кадр" onClick={() => patchTile(selIdx, { crop: [0, 0, 1, 1] })}><Icon name="full" size={15} /></button>
                            </>
                        ) : (
                            <span className="ve-hint">Кадр камеры появится здесь, окно на нём ставится рамкой</span>
                        )}
                    </div>
                </section>

                <div className="ve-gutter" onPointerDown={onGutterDown} onDoubleClick={() => setSrcShare(null)} title="Тянуть — поделить место; двойной клик — как было"><i /></div>

                <section className="ve-pane is-cnv">
                    <div className="ve-pane-h">
                        <span className="eyebrow">Полотно</span>
                        {zonesOn
                            ? <span className="ve-dim">{S.width}×{S.height}</span>
                            : <button className="btn btn--sm" onClick={() => setGridOpen(true)}><Icon name="grid" className="ico" />Собрать полотно</button>}
                        <span className={`ve-live${session.phase === 'open' ? ' is-on' : ''}`} data-tip="Поток neural_editor с устройства — то, что увидит модель">
                            <i />{session.phase === 'open' ? 'вживую' : 'нет связи'}
                        </span>
                    </div>
                    <div className="ve-stage">
                        <VideoBox cameraId={EDITOR_STREAM_ID} signalingUrl={signalingWsUrl(deviceId, `/client/${EDITOR_STREAM_ID}`)}
                            aspect={S.width / S.height} enabled={session.phase === 'open'}>
                            {size => (
                                <CanvasOverlay
                                    s={S} sel={sel} selIdx={selIdx} u={S.width / size.w} dragging={dragging}
                                    zonesCam={zonesOn ? zcam : null} frameOf={frameOf} dead={dead}
                                    onDown={onCanvasDown} onMove={onMove} onUp={onUp}
                                    onDouble={e => { if (!zonesOn && (e.target as Element).closest('[data-act="tile"]')) removeSelected(); }}
                                    onWheel={onWheel(false)}
                                />
                            )}
                        </VideoBox>
                        {session.phase !== 'open' && (
                            <div className="ve-session">
                                {session.phase === 'busy' ? (
                                    <>
                                        <b>Редактором пользуется другой клиент{session.holder ? ` (${session.holder})` : ''}</b>
                                        <span>Редактор на устройстве один. Перехват закроет чужую сессию.</span>
                                        <button className="btn btn--acc btn--sm" onClick={session.takeover}>Перехватить</button>
                                    </>
                                ) : session.phase === 'closed' ? (
                                    <>
                                        <b>Нет связи с редактором</b>
                                        {session.error && <span>{session.error}</span>}
                                        <button className="btn btn--sm" onClick={session.reconnect}>Подключиться снова</button>
                                    </>
                                ) : (
                                    <><span className="spin" /><span>{session.phase === 'opening' ? 'Открываю редактор…' : 'Подключение к редактору…'}</span></>
                                )}
                            </div>
                        )}
                        {session.phase === 'open' && session.error && <div className="ve-err">{session.error}</div>}
                    </div>
                    <div className="ve-pane-f">
                        <span className="ve-mf seps">
                            <span>{configId || 'без конфигурации'}</span>
                            <span className={blocking.length ? 'w' : undefined}
                                data-tip={blocking.length ? `В ${blocking.length} ${plural(blocking.length, 'слоте', 'слотах', 'слотах')} модель ${modelSize(blocking[0]!)} — сохранить нельзя` : undefined}>
                                {S.width}×{S.height}
                            </span>
                            {config?.model && <><span>{modelQuant(config.model)}</span><span>{modelTask(config.model)}</span></>}
                        </span>
                        {zonesOn && (
                            <>
                                <span className="spacer" />
                                <span className="ve-leg">
                                    {catalog.map((z, i) => (
                                        <span key={z.id}><i className="zone-g" style={{ '--z': z.color } as React.CSSProperties} /><b>{i + 1}</b>{z.name}</span>
                                    ))}
                                </span>
                            </>
                        )}
                    </div>
                </section>
            </div>

            {gridOpen && (
                <CanvasGridModal
                    rows={S.rows} cols={S.cols} width={S.width} height={S.height}
                    cells={S.tiles.map(t => ({ row: t.row, col: t.col, rowSpan: t.row_span, colSpan: t.col_span }))}
                    cameraAt={(r, c) => S.tiles.find(t => t.row === r && t.col === c && t.camera)?.camera ?? null}
                    onClose={() => setGridOpen(false)}
                    onApply={applyGrid}
                />
            )}
        </div>
    );
}

function CellCap({ s, sel, idx }: { s: VideoStream; sel: Cell; idx: number }) {
    const t = idx >= 0 ? s.tiles[idx] : null;
    if (!t || !t.camera) return <span className="ve-cellcap"><b>Пустая ячейка</b><span>ячейка {sel.r + 1}·{sel.c + 1}</span></span>;
    const span = (a: number, n: number) => (n > 1 ? `${a + 1}–${a + n}` : String(a + 1));
    return <span className="ve-cellcap"><b>{idx + 1}</b><span>ячейка {span(t.row, t.row_span)}·{span(t.col, t.col_span)}</span></span>;
}

function Picker({ cameras, deviceId, sel, onPick }: { cameras: EditorCamera[]; deviceId: string; sel: Cell; onPick: (id: string) => void }) {
    if (!cameras.length) return <div className="ve-nocam">На устройстве нет камер с назначением «Техническое зрение».<br />Назначьте его потоку камеры в разделе «Камеры».</div>;
    return (
        <div className="ve-pick">
            <div className="ve-pick-t">Какая камера встанет в ячейку {sel.r + 1}·{sel.c + 1}?</div>
            {cameras.map((c, n) => {
                const v = viewFor(c);
                return (
                    <button key={c.id} style={{ '--i': n } as React.CSSProperties} onClick={() => onPick(c.id)}>
                        <div className="thumb">
                            {v ? <VideoBox cameraId={c.id} stream={v.stream.key} signalingUrl={signalingWsUrl(deviceId, `/client/${c.id}`)} aspect={4 / 3} />
                                : <div className="nof">нет потока просмотра</div>}
                        </div>
                        <span><i />{c.name}{c.name !== c.id && <em>{c.id}</em>}<em>{c.neural.width}×{c.neural.height}</em></span>
                    </button>
                );
            })}
        </div>
    );
}

// Двойная рамка: светлая или акцентная линия на тёмной подложке
function FrameLine({ r, u, on }: { r: Rect; u: number; on: boolean }) {
    const sw = (on ? 2 : 1.2) * u;
    return (
        <>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" className="fl-under" strokeWidth={sw + 3 * u} />
            <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" className={on ? 'fl-on' : 'fl-off'} strokeWidth={sw * 0.8} />
        </>
    );
}

interface CanvasOverlayProps {
    s: VideoStream;
    sel: Cell;
    selIdx: number;
    u: number;
    dragging: Drag | null;
    /** Режим зон: камера, чьи тайлы обведены; null — режим окон */
    zonesCam: string | null;
    frameOf: (cam: string) => { width: number; height: number };
    dead: (cam: string) => boolean;
    onDown: (e: React.PointerEvent<SVGSVGElement>) => void;
    onMove: (e: React.PointerEvent<SVGSVGElement>) => void;
    onUp: () => void;
    onDouble: (e: React.MouseEvent<SVGSVGElement>) => void;
    onWheel: (e: WheelEvent, svg: SVGSVGElement) => void;
}

// Колесо вешается нативно: React-обработчик пассивный и не может отменить прокрутку страницы
function useWheel(onWheel: (e: WheelEvent, svg: SVGSVGElement) => void): RefObject<SVGSVGElement> {
    const ref = useRef<SVGSVGElement>(null);
    const handler = useRef(onWheel);
    handler.current = onWheel;
    useEffect(() => {
        const svg = ref.current;
        if (!svg) return;
        const fn = (e: WheelEvent) => handler.current(e, svg);
        svg.addEventListener('wheel', fn, { passive: false });
        return () => svg.removeEventListener('wheel', fn);
    }, []);
    return ref;
}

function CanvasOverlay({ s, sel, selIdx, u, dragging, zonesCam, frameOf, dead, onDown, onMove, onUp, onDouble, onWheel }: CanvasOverlayProps) {
    const ref = useWheel(onWheel);
    const zones = zonesCam !== null;
    const covered = new Set<string>();
    s.tiles.forEach(t => { for (let r = t.row; r < t.row + t.row_span; r++) for (let c = t.col; c < t.col + t.col_span; c++) covered.add(`${r}:${c}`); });
    const empties: { rect: Rect; r: number; c: number }[] = [];
    for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) if (!covered.has(`${r}:${c}`)) empties.push({ rect: cellRect(s, r, c), r, c });
    s.tiles.forEach(t => { if (!t.camera) empties.push({ rect: tileCell(s, t), r: t.row, c: t.col }); });

    const selRect = selIdx >= 0 ? tileCell(s, s.tiles[selIdx]) : cellRect(s, sel.r, sel.c);
    const selTile = selIdx >= 0 ? s.tiles[selIdx] : null;
    const b = 1.5 * u;

    return (
        <svg className="ve-svg cnv" viewBox={`0 0 ${s.width} ${s.height}`} ref={ref}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={onDouble}>
            {s.tiles.map((t, i) => {
                if (!t.camera) return null;
                const c = tileCell(s, t);
                return (
                    <g key={`t${i}`}>
                        <rect data-act="tile" data-i={i} x={c.x} y={c.y} width={c.w} height={c.h} className={`hit-tile${zones ? ' is-pick' : ''}`} />
                        {dead(t.camera) && (
                            <g pointerEvents="none" transform={`translate(${c.x + c.w / 2},${c.y + c.h / 2}) scale(${u})`}>
                                <rect x={-86} y={-14} width={172} height={28} rx={14} className="dark" />
                                <circle cx={-68} cy={0} r={4} fill="var(--err)" />
                                <text x={-56} y={4} className="lbl-t" fontSize={12}>{t.camera} · нет кадра</text>
                            </g>
                        )}
                    </g>
                );
            })}

            {/* Режим зон: тайлы камеры зон обведены по картинке */}
            {zones && s.tiles.map((t, i) => {
                if (t.camera !== zonesCam) return null;
                const f = frameOf(t.camera), d = tileDst(s, t, f.width, f.height);
                return <rect key={`z${i}`} className="zn-camt" x={d.x + u} y={d.y + u} width={d.w - 2 * u} height={d.h - 2 * u}
                    strokeWidth={1.6 * u} strokeDasharray={`${6 * u} ${5 * u}`} pointerEvents="none" />;
            })}

            {empties.map(({ rect, r, c }) => {
                const p = 14 * u, on = !zones && sel.r === r && sel.c === c;
                return (
                    <g key={`e${r}:${c}`} className={`empty${on ? ' is-sel' : ''}`} data-act={zones ? undefined : 'empty'} data-r={r} data-c={c}
                        pointerEvents={zones ? 'none' : undefined} style={{ '--dash': 16 * u } as React.CSSProperties}>
                        <rect className="eb" x={rect.x} y={rect.y} width={rect.w} height={rect.h} />
                        <rect className="dash" x={rect.x + p} y={rect.y + p} width={Math.max(0, rect.w - 2 * p)} height={Math.max(0, rect.h - 2 * p)}
                            rx={8 * u} fill="none" strokeWidth={2 * u} strokeDasharray={`${9 * u} ${7 * u}`} />
                        <text className="elbl" x={rect.x + rect.w / 2} y={rect.y + rect.h / 2 + 6 * u} textAnchor="middle" fontSize={Math.min(17 * u, (rect.w - 2 * p) / 9)} fontWeight={600}>Добавить камеру</text>
                    </g>
                );
            })}

            {s.tiles.map((t, i) => {
                if (!t.camera) return null;
                const c = tileCell(s, t), on = zones ? t.camera === zonesCam : i === selIdx, f = 11 * u;
                return (
                    <g key={`l${i}`} pointerEvents="none" className={on ? 'fade' : ''}>
                        <rect x={c.x + 8 * u} y={c.y + 8 * u} width={((t.camera.length + 4) * 6.8 + 12) * u} height={20 * u} rx={4 * u} className={on ? 'chip-on' : 'chip'} />
                        <text x={c.x + 15 * u} y={c.y + 22 * u} fontSize={f} fontWeight={on ? 700 : 400} className={on ? 'chip-t-on' : 'chip-t'}>{i + 1} · {t.camera}</text>
                    </g>
                );
            })}

            {!zones && (
                <g key={`sel${sel.r}:${sel.c}`} className="fade" pointerEvents="none">
                    <FrameLine r={{ x: selRect.x + b, y: selRect.y + b, w: selRect.w - 2 * b, h: selRect.h - 2 * b }} u={u * 1.4} on />
                </g>
            )}

            {/* Границы поверх рамки выбора: иначе двойная рамка закрывает линии */}
            {[true, false].map(vertical => {
                const n = vertical ? s.cols : s.rows, e = vertical ? edges(s.width, s.cols, s.col_fr) : edges(s.height, s.rows, s.row_fr);
                return Array.from({ length: n - 1 }, (_, k) => k + 1).map(i => {
                    const pos = e[i], on = dragging?.kind === 'border' && dragging.vertical === vertical && dragging.i === i;
                    return borderRuns(s, vertical, i).map(([a, z], j) => (
                        <g key={`b${vertical ? 'v' : 'h'}${i}:${j}`}>
                            {!zones && (vertical
                                ? <rect data-act="dc" data-i={i} x={pos - (BORDER_HIT_PX / 2) * u} y={a} width={BORDER_HIT_PX * u} height={z - a} className="hit-border v" />
                                : <rect data-act="dr" data-i={i} x={a} y={pos - (BORDER_HIT_PX / 2) * u} width={z - a} height={BORDER_HIT_PX * u} className="hit-border h" />)}
                            <path className={`border${on ? ' is-on' : ''}${zones ? ' is-faint' : ''}`} d={vertical ? `M${pos} ${a}V${z}` : `M${a} ${pos}H${z}`} strokeWidth={2.6 * u} pointerEvents="none" />
                        </g>
                    ));
                });
            })}

            {!zones && selTile?.camera && (() => {
                const c = tileCell(s, selTile), r = 13 * u, cx = c.x + c.w - 10 * u - r, cy = c.y + 10 * u + r;
                return (
                    <g key={`del${selIdx}`} className="del pop" data-act="del">
                        <title>Освободить ячейку · Delete или двойной клик</title>
                        <circle cx={cx} cy={cy} r={r} strokeWidth={u} />
                        <use href="#i-trash" x={cx - 7 * u} y={cy - 7 * u} width={14 * u} height={14 * u} pointerEvents="none" />
                    </g>
                );
            })()}
        </svg>
    );
}

interface SourceOverlayProps {
    s: VideoStream;
    cam: string;
    selIdx: number;
    frame: { width: number; height: number };
    u: number;
    /** Зоны камеры — пунктиром под окнами */
    polys: ZonePolygon[];
    catalog: ZoneDef[];
    onDown: (e: React.PointerEvent<SVGSVGElement>) => void;
    onMove: (e: React.PointerEvent<SVGSVGElement>) => void;
    onUp: () => void;
    onWheel: (e: WheelEvent, svg: SVGSVGElement) => void;
}

function SourceOverlay({ s, cam, selIdx, frame, u, polys, catalog, onDown, onMove, onUp, onWheel }: SourceOverlayProps) {
    const ref = useWheel(onWheel);
    const W = frame.width, H = frame.height;
    const idxs = s.tiles.map((t, i) => (t.camera === cam ? i : -1)).filter(i => i >= 0).sort((a, b) => Number(a === selIdx) - Number(b === selIdx));
    const win = (i: number): Rect => { const c = s.tiles[i].crop; return { x: c[0] * W, y: c[1] * H, w: c[2] * W, h: c[3] * H }; };
    const hole = idxs.reduce((d, i) => { const k = win(i); return `${d}M${k.x} ${k.y}v${k.h}h${k.w}v${-k.h}Z`; }, `M0 0H${W}V${H}H0Z`);
    const bs = 16 * u;

    return (
        <svg className="ve-svg src" viewBox={`0 0 ${W} ${H}`} ref={ref}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
            {drawOrder(polys, catalog).map(i => (
                <g key={`z${i}`} className="zn-pg is-faint" pointerEvents="none" style={{ '--z': catalog.find(z => z.id === polys[i].zone)!.color } as React.CSSProperties}>
                    <path className="l" d={`M${ptsOf(polys[i]).map(([x, y]) => `${x * W} ${y * H}`).join('L')}Z`} strokeWidth={1.4 * u} strokeDasharray={`${7 * u} ${6 * u}`} />
                </g>
            ))}
            <path d={hole} className="mask" fillRule="evenodd" pointerEvents="none" />
            {idxs.map(i => {
                const k = win(i), on = i === selIdx;
                const t = SIDE_HIT_PX * u;
                const sides: [Handle, number, number, number, number, string][] = [
                    ['n', k.x, k.y - t / 2, k.w, t, 'ns'], ['s', k.x, k.y + k.h - t / 2, k.w, t, 'ns'],
                    ['w', k.x - t / 2, k.y, t, k.h, 'ew'], ['e', k.x + k.w - t / 2, k.y, t, k.h, 'ew'],
                ];
                const corners: [Handle, number, number][] = [['nw', k.x, k.y], ['ne', k.x + k.w, k.y], ['sw', k.x, k.y + k.h], ['se', k.x + k.w, k.y + k.h]];
                const a = ANCHOR_PX * u, hit = ANCHOR_HIT_PX * u;
                return (
                    <g key={i}>
                        {!on && <rect x={k.x} y={k.y} width={k.w} height={k.h} className="dim-fill" pointerEvents="none" />}
                        <rect data-act="win" data-i={i} x={k.x} y={k.y} width={k.w} height={k.h} className="hit-win" />
                        <g key={on ? 'on' : 'off'} className={on ? 'fade' : 'dim'} pointerEvents="none">
                            <FrameLine r={k} u={u} on={on} />
                            <rect x={k.x + 4 * u} y={k.y + 4 * u} width={bs} height={bs} rx={3 * u} className={on ? 'chip-on' : 'chip'} />
                            <text x={k.x + 4 * u + bs / 2} y={k.y + 4 * u + bs * 0.72} textAnchor="middle" fontSize={10 * u} fontWeight={700} className={on ? 'chip-t-on' : 'chip-t'}>{i + 1}</text>
                        </g>
                        {on && (
                            <>
                                {sides.map(([h, x, y, w, hh, cur]) => (
                                    <rect key={h} data-act="wh" data-i={i} data-h={h} x={x} y={y} width={w} height={hh} className="side" style={{ cursor: `${cur}-resize` }} />
                                ))}
                                {corners.map(([h, x, y]) => (
                                    <g key={h}>
                                        <rect data-act="wh" data-i={i} data-h={h} x={x - hit / 2} y={y - hit / 2} width={hit} height={hit} className="hit-anc"
                                            style={{ cursor: h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize' }} />
                                        <g className="anc pop" pointerEvents="none">
                                            <rect x={x - a / 2} y={y - a / 2} width={a} height={a} rx={2 * u} strokeWidth={1.6 * u} />
                                        </g>
                                    </g>
                                ))}
                            </>
                        )}
                    </g>
                );
            })}
        </svg>
    );
}
