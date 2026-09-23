import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Icon } from '../../app/Icons';
import { Select } from '../../app/Select';
import { useToast } from '../../features/birdview/components/common/Toast';
import { neuralApi } from '../../features/neural/api/client';
import type { ConfigSummary, StreamTile, TileFit, VideoStream } from '../../features/neural/api/types';
import { moduleDeviceId, signalingWsUrl } from '../../services/devices';
import { ratio, viewFor, type EditorCamera } from './editor-cameras';
import {
    borderRuns, cellRect, clamp, cropForCell, edges, mergeCells, moveCrop, resizeCrop, resizeGrid, tileAt, tileCell, tileDst,
    withCamerasOnly, zoomCrop, type Cell, type Crop, type Handle, type Rect,
} from './stream-geometry';
import { EDITOR_STREAM_ID, useEditorSession } from './useEditorSession';
import { VideoBox } from './VideoBox';

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

const plural = (n: number, one: string, few: string, many: string) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
};

const fullWeights = (n: number, fr: number[]) => (fr.length === n ? [...fr] : Array.from({ length: n }, () => 1));

// Координата указателя в единицах вьюбокса SVG
function svgPoint(svg: SVGSVGElement, e: { clientX: number; clientY: number }) {
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const m = svg.getScreenCTM();
    return m ? p.matrixTransform(m.inverse()) : p;
}

interface StreamEditorProps {
    initial: VideoStream;
    isNew: boolean;
    configs: ConfigSummary[];
    cameras: EditorCamera[];
    /** В скольких слотах стоит поток */
    slots: number;
    onBack: () => void;
    onSaved: (stream: VideoStream) => void;
}

export function StreamEditor({ initial, isNew, configs, cameras, slots, onBack, onSaved }: StreamEditorProps) {
    const toast = useToast();
    const session = useEditorSession(initial);

    const [S, setS] = useState<VideoStream>(initial);
    const [saved, setSaved] = useState(() => JSON.stringify(initial));
    const [created, setCreated] = useState(!isNew);
    const [sel, setSel] = useState<Cell>(() => (initial.tiles[0] ? { r: initial.tiles[0].row, c: initial.tiles[0].col } : { r: 0, c: 0 }));
    const [multi, setMulti] = useState<Cell[]>([]);
    const [saving, setSaving] = useState(false);
    const [srcShare, setSrcShare] = useState<number | null>(null);

    const sRef = useRef(S);
    sRef.current = S;
    const dragRef = useRef<Drag | null>(null);
    const [dragging, setDragging] = useState<Drag | null>(null);

    const deviceId = useMemo(() => { try { return moduleDeviceId('neural'); } catch { return ''; } }, []);

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

    const dirty = JSON.stringify(S) !== saved || !created;
    const selIdx = tileAt(S, sel.r, sel.c);
    const selTile: StreamTile | null = selIdx >= 0 ? S.tiles[selIdx] : null;
    const camOf = (id: string) => cameras.find(c => c.id === id) ?? null;
    const frameOf = (id: string) => {
        const c = camOf(id);
        if (c?.neural.width && c.neural.height) return { width: c.neural.width, height: c.neural.height };
        const t = session.tiles.find(p => p.camera === id && p.camera_width > 0);
        return t ? { width: t.camera_width, height: t.camera_height } : FALLBACK_FRAME;
    };
    const tileState = (cam: string) => session.tiles.find(p => p.camera === cam)?.state ?? null;
    const dead = (cam: string) => tileState(cam) === 'no_camera' || tileState(cam) === 'stalled';

    const patchTile = (i: number, p: Partial<StreamTile>, final = true) =>
        commit({ ...sRef.current, tiles: sRef.current.tiles.map((t, j) => (j === i ? { ...t, ...p } : t)) }, final);

    const select = (c: Cell, add = false) => {
        if (add) setMulti(m => (m.some(x => x.r === c.r && x.c === c.c) ? m : [...m, c]));
        else { setSel(c); setMulti([]); }
    };

    const removeSelected = useCallback(() => {
        const s = sRef.current;
        const i = tileAt(s, sel.r, sel.c);
        if (i < 0 || !s.tiles[i].camera) return;
        commit({ ...s, tiles: s.tiles.filter((_, j) => j !== i) });
    }, [commit, sel]);

    const assign = (camera: string) => {
        const s = sRef.current;
        const i = tileAt(s, sel.r, sel.c);
        if (i >= 0) patchTile(i, { camera });
        else commit({ ...s, tiles: [...s.tiles, { camera, row: sel.r, col: sel.c, row_span: 1, col_span: 1, crop: [0, 0, 1, 1], fit: 'letterbox' }] });
    };

    const setGrid = (rows: number, cols: number) => {
        if (rows < 1 || cols < 1 || rows > 6 || cols > 6) return;
        commit(resizeGrid(sRef.current, rows, cols));
        setSel(c => ({ r: Math.min(c.r, rows - 1), c: Math.min(c.c, cols - 1) }));
        setMulti([]);
    };

    const merge = () => {
        const res = mergeCells(sRef.current, [...multi, sel]);
        setMulti([]);
        if (!res) { toast('Нельзя объединить', 'В прямоугольнике больше одной камеры или ячейка торчит наружу', 'err'); return; }
        commit(res.stream);
        setSel(res.at);
    };

    const changeConfig = (configId: string) => {
        const next = { ...sRef.current, config_id: configId };
        setS(next);
        session.reopen(next);
    };

    // Delete освобождает выбранную ячейку; в полях ввода клавиша своя
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Delete') return;
            const t = e.target as HTMLElement | null;
            if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
            e.preventDefault();
            removeSelected();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [removeSelected]);

    const save = async () => {
        const s = sRef.current;
        if (!created && !ID_RE.test(s.id)) { toast('Нужен идентификатор', 'Латиница, цифры, «_» и «-»', 'err'); return; }
        if (!s.config_id) { toast('Нужна конфигурация', 'Выберите конфигурацию в шапке', 'err'); return; }
        if (!s.tiles.some(t => t.camera)) { toast('Нет камер', 'Поставьте в полотно хотя бы одну камеру', 'err'); return; }
        setSaving(true);
        try {
            const res = await neuralApi.saveStream(withCamerasOnly({ ...s, name: s.name.trim() || s.id }));
            const next = { ...s, name: res.name };
            setS(next);
            setSaved(JSON.stringify(next));
            setCreated(true);
            toast('Видеопоток сохранён', slots ? 'Слот с ним перезапускается' : next.name, 'ok');
            onSaved(res);
        } catch (e) {
            toast('Не сохранено', e instanceof Error ? e.message : String(e), 'err');
        } finally {
            setSaving(false);
        }
    };

    const undo = () => {
        const s = JSON.parse(saved) as VideoStream;
        commit(s);
        setMulti([]);
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
        if (act === 'del') { removeSelected(); return; }
        if (act === 'empty') { select({ r: Number(a.dataset.r), c: Number(a.dataset.c) }, e.shiftKey); return; }
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
            select({ r: t.row, c: t.col }, e.shiftKey);
            if (e.shiftKey || !t.camera) return;
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
        setMulti([]);
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

    // ── Шапка ──
    const tilesCount = S.tiles.filter(t => t.camera).length;
    const configMissing = !!S.config_id && !configs.some(c => c.id === S.config_id);
    const configOptions = configs.map(c => ({ value: c.id, label: c.name || c.id, hint: c.id }));

    const selCam = selTile?.camera ? camOf(selTile.camera) : null;
    const view = selCam ? viewFor(selCam) : null;
    const selFrame = selTile?.camera ? frameOf(selTile.camera) : FALLBACK_FRAME;

    return (
        <div className="ve">
            <div className="ve-h">
                <button className="ve-back" onClick={onBack}><Icon name="chev" size={13} />Видеопотоки</button>
                <input className="ve-name" value={S.name} placeholder={created ? S.id : 'Название'} aria-label="Название видеопотока"
                    onChange={e => setS({ ...S, name: e.target.value })} />
                {created
                    ? <span className="ve-id">{S.id}</span>
                    : <input className="tf-in ve-idin" value={S.id} placeholder="идентификатор" aria-label="Идентификатор"
                        onChange={e => setS({ ...S, id: e.target.value.trim() })} />}
                <span className="ve-meta">
                    <span className="ve-cfg">
                        <Select value={configMissing ? '' : S.config_id} options={configOptions} onChange={changeConfig}
                            placeholder={configMissing ? 'Конфигурация удалена' : 'Конфигурация'} />
                    </span>
                    <span data-tip="Размер входа модели конфигурации">полотно {S.width}×{S.height}</span>
                    <span>{tilesCount} {plural(tilesCount, 'тайл', 'тайла', 'тайлов')}</span>
                    <span>{slots ? `в ${slots} ${plural(slots, 'слоте', 'слотах', 'слотах')}` : 'не используется'}</span>
                </span>
                {dirty && <span className="tag is-warn">не сохранено</span>}
                <button className="btn spacer" disabled={!created || JSON.stringify(S) === saved || saving} onClick={undo}>Отменить</button>
                <button className="btn btn--acc" disabled={!dirty || saving} onClick={save}>Сохранить</button>
            </div>

            <div className="ve-split" ref={splitRef}>
                <section className="ve-pane" style={srcShare ? { flex: `0 0 ${(srcShare * 100).toFixed(1)}%` } : undefined}>
                    <div className="ve-pane-h">
                        {selTile?.camera ? (
                            <>
                                <span className="ve-cam">
                                    <Select value={selTile.camera} onChange={assign}
                                        options={cameras.map(c => ({ value: c.id, label: c.name, hint: `${c.neural.width}×${c.neural.height}` }))} />
                                </span>
                                <CellCap s={S} sel={sel} idx={selIdx} />
                                <div className="seg ve-fit">
                                    {(['letterbox', 'stretch'] as TileFit[]).map(f => (
                                        <button key={f} className={selTile.fit === f ? 'is-on' : ''} onClick={() => patchTile(selIdx, { fit: f })}>
                                            {f === 'letterbox' ? 'Вписать' : 'Растянуть'}
                                        </button>
                                    ))}
                                </div>
                            </>
                        ) : (
                            <><span className="eyebrow">Кадр камеры</span><CellCap s={S} sel={sel} idx={selIdx} /></>
                        )}
                    </div>

                    {selTile?.camera && selCam && !dead(selTile.camera) && (
                        view === null ? (
                            <div className="ve-view warn"><i />У камеры нет потока с назначением «Просмотр» — кадр показать нечем</div>
                        ) : view.self ? (
                            <div className="ve-view"><i />Просмотр: <b>{view.stream.key} · {view.stream.width}×{view.stream.height}</b> — тот же поток, что идёт в нейронку</div>
                        ) : view.same ? (
                            <div className="ve-view"><i />Просмотр: <b>{view.stream.key} · {view.stream.width}×{view.stream.height}</b> — пропорция как у нейронки ({selCam.neural.width}×{selCam.neural.height})</div>
                        ) : (
                            <div className="ve-view warn"><i /><span>Просмотр <b>{view.stream.width}×{view.stream.height} ({ratio(view.stream.width, view.stream.height)})</b> растянут под нейронку <b>{selCam.neural.width}×{selCam.neural.height} ({ratio(selCam.neural.width, selCam.neural.height)})</b>: картинка искажена, окно стоит точно. Без искажений — добавьте камере поток просмотра {ratio(selCam.neural.width, selCam.neural.height)}.</span></div>
                        )
                    )}

                    <div className="ve-stage">
                        {!selTile?.camera ? (
                            <Picker cameras={cameras} deviceId={deviceId} sel={sel} onPick={assign} />
                        ) : dead(selTile.camera) ? (
                            <div className="ve-nocam">Камеры {selTile.camera} нет в хранилище.<br />Её ячейка уходит в модель серой, остальные работают.</div>
                        ) : selCam && view ? (
                            <VideoBox key={`${selCam.id}:${view.stream.key}`} cameraId={selCam.id} stream={view.stream.key}
                                signalingUrl={signalingWsUrl(deviceId, `/client/${selCam.id}`)} aspect={selFrame.width / selFrame.height}>
                                {size => (
                                    <SourceOverlay
                                        s={S} cam={selTile.camera} selIdx={selIdx} frame={selFrame} u={selFrame.width / size.w}
                                        onDown={onSourceDown} onMove={onMove} onUp={onUp} onWheel={onWheel(true)}
                                    />
                                )}
                            </VideoBox>
                        ) : (
                            <div className="ve-nocam">Камеры {selTile.camera} нет среди камер с назначением «Техническое зрение»</div>
                        )}
                    </div>

                    <div className="ve-pane-f">
                        {selTile?.camera ? (
                            <>
                                <span className="ve-crop">окно
                                    {(['x', 'y', 'ш', 'в'] as const).map((k, j) => (
                                        <CropField key={k} label={k} value={selTile.crop[j]} onCommit={v => {
                                            const c = [...selTile.crop] as Crop;
                                            c[j] = clamp(v, 0, 1);
                                            c[2] = clamp(c[2], 0.05, 1 - c[0]);
                                            c[3] = clamp(c[3], 0.05, 1 - c[1]);
                                            patchTile(selIdx, { crop: c });
                                        }} />
                                    ))}
                                </span>
                                <button className="btn btn--sm" onClick={() => patchTile(selIdx, { crop: cropForCell(selTile.crop, tileCell(S, selTile), selFrame.width, selFrame.height) })}>Окно под ячейку</button>
                                <button className="btn btn--sm" onClick={() => patchTile(selIdx, { crop: [0, 0, 1, 1] })}>Весь кадр</button>
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
                        <span className="ve-grid">
                            <span className="ve-step"><button onClick={() => setGrid(S.rows - 1, S.cols)} aria-label="Меньше строк">−</button><b>{S.rows}</b><button onClick={() => setGrid(S.rows + 1, S.cols)} aria-label="Больше строк">+</button></span>
                            ×
                            <span className="ve-step"><button onClick={() => setGrid(S.rows, S.cols - 1)} aria-label="Меньше столбцов">−</button><b>{S.cols}</b><button onClick={() => setGrid(S.rows, S.cols + 1)} aria-label="Больше столбцов">+</button></span>
                        </span>
                        <button className="btn btn--sm" disabled={!multi.length} onClick={merge}>Объединить</button>
                        {selTile && (selTile.row_span > 1 || selTile.col_span > 1) && (
                            <button className="btn btn--sm" onClick={() => patchTile(selIdx, { row_span: 1, col_span: 1 })}>Разделить</button>
                        )}
                        <span className={`ve-live${session.phase === 'open' ? ' is-on' : ''}`} data-tip="Поток neural_editor с устройства — то, что увидит модель">
                            <i />{session.phase === 'open' ? 'вживую' : 'нет связи'}
                        </span>
                    </div>
                    <div className="ve-stage">
                        <VideoBox cameraId={EDITOR_STREAM_ID} signalingUrl={signalingWsUrl(deviceId, `/client/${EDITOR_STREAM_ID}`)}
                            aspect={S.width / S.height} enabled={session.phase === 'open'}>
                            {size => (
                                <CanvasOverlay
                                    s={S} sel={sel} selIdx={selIdx} multi={multi} u={S.width / size.w} dragging={dragging}
                                    dead={dead}
                                    onDown={onCanvasDown} onMove={onMove} onUp={onUp}
                                    onDouble={e => { if ((e.target as Element).closest('[data-act="tile"]')) removeSelected(); }}
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
                        <span className="ve-hint">
                            <span><kbd>shift</kbd>объединить</span>
                            <span><kbd>Delete</kbd>освободить</span>
                            <span><kbd>тянуть</kbd>сдвиг окна</span>
                            <span><kbd>колесо</kbd>масштаб</span>
                        </span>
                    </div>
                </section>
            </div>
        </div>
    );
}

function CellCap({ s, sel, idx }: { s: VideoStream; sel: Cell; idx: number }) {
    const t = idx >= 0 ? s.tiles[idx] : null;
    if (!t || !t.camera) return <span className="ve-cellcap"><b>Пустая ячейка</b><span>ячейка {sel.r + 1}·{sel.c + 1}</span></span>;
    const span = (a: number, n: number) => (n > 1 ? `${a + 1}–${a + n}` : String(a + 1));
    return <span className="ve-cellcap"><b>{idx + 1}</b><span>ячейка {span(t.row, t.row_span)}·{span(t.col, t.col_span)}</span></span>;
}

// Число окна с коммитом по blur/Enter; показывается с запятой
function CropField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
    const fmt = (v: number) => v.toFixed(2).replace('.', ',');
    const [text, setText] = useState(fmt(value));
    const [focused, setFocused] = useState(false);
    useEffect(() => { if (!focused) setText(fmt(value)); }, [value, focused]);
    const commit = () => {
        const v = parseFloat(text.replace(',', '.'));
        if (Number.isFinite(v) && Math.abs(v - value) > 1e-4) onCommit(v);
        else setText(fmt(value));
    };
    return (
        <input className="ve-num" value={text} aria-label={label} title={label}
            onChange={e => setText(e.target.value)} onFocus={() => setFocused(true)}
            onBlur={() => { setFocused(false); commit(); }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    );
}

function Picker({ cameras, deviceId, sel, onPick }: { cameras: EditorCamera[]; deviceId: string; sel: Cell; onPick: (id: string) => void }) {
    if (!cameras.length) return <div className="ve-nocam">Нет камер с назначением «Техническое зрение».<br />Назначьте его потоку камеры в разделе «Камеры».</div>;
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
    multi: Cell[];
    u: number;
    dragging: Drag | null;
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

function CanvasOverlay({ s, sel, selIdx, multi, u, dragging, dead, onDown, onMove, onUp, onDouble, onWheel }: CanvasOverlayProps) {
    const ref = useWheel(onWheel);
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
                        <rect data-act="tile" data-i={i} x={c.x} y={c.y} width={c.w} height={c.h} className="hit-tile" />
                        {dead(t.camera) && (
                            <g pointer-events="none" transform={`translate(${c.x + c.w / 2},${c.y + c.h / 2}) scale(${u})`}>
                                <rect x={-86} y={-14} width={172} height={28} rx={14} className="dark" />
                                <circle cx={-68} cy={0} r={4} fill="var(--err)" />
                                <text x={-56} y={4} className="lbl-t" fontSize={12}>{t.camera} · нет кадра</text>
                            </g>
                        )}
                    </g>
                );
            })}

            {empties.map(({ rect, r, c }) => {
                const p = 14 * u, on = sel.r === r && sel.c === c;
                return (
                    <g key={`e${r}:${c}`} className={`empty${on ? ' is-sel' : ''}`} data-act="empty" data-r={r} data-c={c} style={{ '--dash': 16 * u } as React.CSSProperties}>
                        <rect className="eb" x={rect.x} y={rect.y} width={rect.w} height={rect.h} />
                        <rect className="dash" x={rect.x + p} y={rect.y + p} width={Math.max(0, rect.w - 2 * p)} height={Math.max(0, rect.h - 2 * p)}
                            rx={8 * u} fill="none" strokeWidth={2 * u} strokeDasharray={`${9 * u} ${7 * u}`} />
                        <text className="elbl" x={rect.x + rect.w / 2} y={rect.y + rect.h / 2 + 6 * u} textAnchor="middle" fontSize={17 * u} fontWeight={600}>Добавить камеру</text>
                    </g>
                );
            })}

            {s.tiles.map((t, i) => {
                if (!t.camera) return null;
                const c = tileCell(s, t), on = i === selIdx, f = 11 * u;
                return (
                    <g key={`l${i}`} pointer-events="none" className={on ? 'fade' : ''}>
                        <rect x={c.x + 8 * u} y={c.y + 8 * u} width={((t.camera.length + 4) * 6.8 + 12) * u} height={20 * u} rx={4 * u} className={on ? 'chip-on' : 'chip'} />
                        <text x={c.x + 15 * u} y={c.y + 22 * u} fontSize={f} fontWeight={on ? 700 : 400} className={on ? 'chip-t-on' : 'chip-t'}>{i + 1} · {t.camera}</text>
                    </g>
                );
            })}

            {multi.map(m => {
                const c = cellRect(s, m.r, m.c);
                return <rect key={`m${m.r}:${m.c}`} className="multi fade" x={c.x + 3 * u} y={c.y + 3 * u} width={c.w - 6 * u} height={c.h - 6 * u} strokeWidth={2 * u} strokeDasharray={`${6 * u} ${5 * u}`} pointerEvents="none" />;
            })}

            <g key={`sel${sel.r}:${sel.c}`} className="fade" pointerEvents="none">
                <FrameLine r={{ x: selRect.x + b, y: selRect.y + b, w: selRect.w - 2 * b, h: selRect.h - 2 * b }} u={u * 1.4} on />
            </g>

            {/* Границы поверх рамки выбора: иначе двойная рамка закрывает линии */}
            {[true, false].map(vertical => {
                const n = vertical ? s.cols : s.rows, e = vertical ? edges(s.width, s.cols, s.col_fr) : edges(s.height, s.rows, s.row_fr);
                return Array.from({ length: n - 1 }, (_, k) => k + 1).map(i => {
                    const pos = e[i], on = dragging?.kind === 'border' && dragging.vertical === vertical && dragging.i === i;
                    return borderRuns(s, vertical, i).map(([a, z], j) => (
                        <g key={`b${vertical ? 'v' : 'h'}${i}:${j}`}>
                            {vertical
                                ? <rect data-act="dc" data-i={i} x={pos - (BORDER_HIT_PX / 2) * u} y={a} width={BORDER_HIT_PX * u} height={z - a} className="hit-border v" />
                                : <rect data-act="dr" data-i={i} x={a} y={pos - (BORDER_HIT_PX / 2) * u} width={z - a} height={BORDER_HIT_PX * u} className="hit-border h" />}
                            <path className={`border${on ? ' is-on' : ''}`} d={vertical ? `M${pos} ${a}V${z}` : `M${a} ${pos}H${z}`} strokeWidth={2.6 * u} pointerEvents="none" />
                        </g>
                    ));
                });
            })}

            {selTile?.camera && (() => {
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
    onDown: (e: React.PointerEvent<SVGSVGElement>) => void;
    onMove: (e: React.PointerEvent<SVGSVGElement>) => void;
    onUp: () => void;
    onWheel: (e: WheelEvent, svg: SVGSVGElement) => void;
}

function SourceOverlay({ s, cam, selIdx, frame, u, onDown, onMove, onUp, onWheel }: SourceOverlayProps) {
    const ref = useWheel(onWheel);
    const W = frame.width, H = frame.height;
    const idxs = s.tiles.map((t, i) => (t.camera === cam ? i : -1)).filter(i => i >= 0).sort((a, b) => Number(a === selIdx) - Number(b === selIdx));
    const win = (i: number): Rect => { const c = s.tiles[i].crop; return { x: c[0] * W, y: c[1] * H, w: c[2] * W, h: c[3] * H }; };
    const hole = idxs.reduce((d, i) => { const k = win(i); return `${d}M${k.x} ${k.y}v${k.h}h${k.w}v${-k.h}Z`; }, `M0 0H${W}V${H}H0Z`);
    const bs = 16 * u;

    return (
        <svg className="ve-svg src" viewBox={`0 0 ${W} ${H}`} ref={ref}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
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
