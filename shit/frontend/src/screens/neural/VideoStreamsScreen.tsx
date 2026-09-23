import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '../../app/Icons';
import { Modal } from '../../app/Modal';
import { Select } from '../../app/Select';
import { ConfirmModal } from '../../features/birdview/components/common/ConfirmModal';
import { useToast } from '../../features/birdview/components/common/Toast';
import { neuralApi } from '../../features/neural/api/client';
import type { ConfigSummary, VideoStream } from '../../features/neural/api/types';
import { loadEditorCameras, type EditorCamera } from './editor-cameras';
import { cellRect, freeCells, tileCell } from './stream-geometry';
import { StreamEditor } from './StreamEditor';

// Новый видеопоток до сохранения; id вводится в шапке редактора
const NEW_ID = '_new';

const plural = (n: number, one: string, few: string, many: string) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
};

const blankStream = (configId: string): VideoStream => ({
    id: '', name: '', config_id: configId, width: 640, height: 640,
    rows: 1, cols: 1, row_fr: [], col_fr: [], tiles: [],
});

/** Раздел «Видеопотоки»: список карточек, редактор открывается по ?edit=<id> */
export function VideoStreamsScreen() {
    const toast = useToast();
    const [params, setParams] = useSearchParams();
    const editId = params.get('edit');

    const [streams, setStreams] = useState<VideoStream[] | null>(null);
    const [configs, setConfigs] = useState<ConfigSummary[]>([]);
    const [cameras, setCameras] = useState<EditorCamera[]>([]);
    const [usage, setUsage] = useState<Record<string, number>>({});
    const [toDelete, setToDelete] = useState<VideoStream | null>(null);
    const [fromCamera, setFromCamera] = useState(false);

    const reload = useCallback(async () => {
        const [list, cfgs, state] = await Promise.all([
            neuralApi.listStreams().then(r => r.streams ?? []).catch(() => [] as VideoStream[]),
            neuralApi.listConfigurations().then(r => r.configurations).catch(() => [] as ConfigSummary[]),
            neuralApi.getState().catch(() => []),
        ]);
        setStreams(list);
        setConfigs(cfgs);
        const map: Record<string, number> = {};
        for (const d of state) map[d.stream_id] = (map[d.stream_id] ?? 0) + 1;
        setUsage(map);
    }, []);

    useEffect(() => {
        reload();
        loadEditorCameras().then(setCameras).catch(() => setCameras([]));
    }, [reload]);

    const open = (id: string | null) => setParams(id ? { edit: id } : {});

    const remove = async (s: VideoStream) => {
        setToDelete(null);
        try {
            await neuralApi.deleteStream(s.id);
            toast('Видеопоток удалён', s.name || s.id, 'ok');
            reload();
        } catch (e) {
            toast('Не удалено', e instanceof Error ? e.message : String(e), 'err');
        }
    };

    const editing = useMemo(() => {
        if (!editId || !streams) return null;
        if (editId === NEW_ID) return blankStream(configs[0]?.id ?? '');
        return streams.find(s => s.id === editId) ?? null;
    }, [editId, streams, configs]);

    if (editId && editing) {
        return (
            // Ключ постоянный: после первого сохранения id в адресе меняется, а сессия редактора должна остаться той же
            <StreamEditor
                key="editor"
                initial={editing}
                isNew={editId === NEW_ID}
                configs={configs}
                cameras={cameras}
                slots={usage[editing.id] ?? 0}
                onBack={() => { open(null); reload(); }}
                onSaved={s => {
                    setStreams(prev => [...(prev ?? []).filter(x => x.id !== s.id), s]);
                    if (editId === NEW_ID) open(s.id);
                    reload();
                }}
            />
        );
    }

    return (
        <div className="vl-wrap">
            <div className="vl-top">
                <h2>Видеопотоки</h2>
                {streams && <span className="num">{streams.length}</span>}
                {editId && streams && !editing && <span className="tag is-err">Видеопоток «{editId}» не найден</span>}
            </div>
            <div className="vl">
                <div className="vcard new">
                    <div className="thumb"><Icon name="plus" size={40} /></div>
                    <div className="body">
                        <button className="btn btn--acc btn--sm" disabled={!configs.length} onClick={() => open(NEW_ID)}>Новый видеопоток</button>
                        <button className="btn btn--sm" disabled={!configs.length || !cameras.length} onClick={() => setFromCamera(true)}>Из камеры как есть</button>
                        <span className="note">{configs.length ? 'Один тайл на всё полотно, кадр целиком' : 'Сначала создайте конфигурацию'}</span>
                    </div>
                </div>
                {(streams ?? []).map(s => {
                    const used = usage[s.id] ?? 0;
                    const lost = !s.config_id || !configs.some(c => c.id === s.config_id);
                    const tiles = s.tiles.length;
                    return (
                        <div key={s.id} className="vcard" role="button" tabIndex={0} onClick={() => open(s.id)}
                            onKeyDown={e => { if (e.key === 'Enter') open(s.id); }}>
                            <div className="thumb"><Schema s={s} /></div>
                            <div className="body">
                                <div className="row">
                                    <b>{s.name || s.id}</b>
                                    <span className="id">{s.id}</span>
                                    {used
                                        ? <span className="icon-btn" aria-disabled="true" data-tip="Стоит в слоте — сначала уберите его на «Инференсе»" onClick={e => e.stopPropagation()}><Icon name="trash" size={13} /></span>
                                        : <span className="icon-btn" data-tip="Удалить видеопоток" onClick={e => { e.stopPropagation(); setToDelete(s); }}><Icon name="trash" size={13} /></span>}
                                </div>
                                <div className="meta">
                                    {lost ? <span className="bad">без конфигурации</span> : <span>{s.config_id}</span>}
                                    <span className="sep">·</span><span>{s.width}×{s.height}</span>
                                    <span className="sep">·</span><span>{tiles} {plural(tiles, 'тайл', 'тайла', 'тайлов')}</span>
                                </div>
                                <div className="row">
                                    {lost
                                        ? <span className="pill err"><span className="dot" />конфигурация удалена</span>
                                        : used
                                            ? <span className="pill ok"><span className="dot" />в {used} {plural(used, 'слоте', 'слотах', 'слотах')}</span>
                                            : <span className="pill"><span className="dot" />не используется</span>}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {toDelete && (
                <ConfirmModal
                    title="Удалить видеопоток"
                    message={`«${toDelete.name || toDelete.id}» будет удалён с устройства.`}
                    confirmText="Удалить"
                    danger
                    onConfirm={() => remove(toDelete)}
                    onCancel={() => setToDelete(null)}
                />
            )}
            {fromCamera && (
                <FromCameraModal
                    cameras={cameras}
                    configs={configs}
                    onClose={() => setFromCamera(false)}
                    onCreated={s => { setFromCamera(false); reload().then(() => open(s.id)); }}
                />
            )}
        </div>
    );
}

// Схема сетки для карточки: номера и камеры тайлов, пустые ячейки пунктиром
function Schema({ s }: { s: VideoStream }) {
    const k = s.width / 640;
    return (
        <svg viewBox={`0 0 ${s.width} ${s.height}`} style={{ aspectRatio: `${s.width} / ${s.height}`, ...(s.width >= s.height ? { width: '100%' } : { height: '100%' }) }}>
            <rect width={s.width} height={s.height} className="sch-bg" />
            {s.tiles.map((t, i) => {
                const c = tileCell(s, t);
                return (
                    <g key={i}>
                        <rect x={c.x + 4 * k} y={c.y + 4 * k} width={c.w - 8 * k} height={c.h - 8 * k} rx={6 * k} className="sch-cell" strokeWidth={2 * k} />
                        <text x={c.x + c.w / 2} y={c.y + c.h / 2} textAnchor="middle" className="sch-n" fontSize={30 * k} fontWeight={600}>{i + 1}</text>
                        <text x={c.x + c.w / 2} y={c.y + c.h / 2 + 34 * k} textAnchor="middle" className="sch-cam" fontSize={20 * k}>{t.camera}</text>
                    </g>
                );
            })}
            {freeCells(s).map(({ r, c }) => {
                const e = cellRect(s, r, c);
                return <rect key={`${r}:${c}`} x={e.x + 4 * k} y={e.y + 4 * k} width={e.w - 8 * k} height={e.h - 8 * k} rx={6 * k}
                    className="sch-free" strokeWidth={2 * k} strokeDasharray={`${10 * k} ${8 * k}`} />;
            })}
        </svg>
    );
}

function FromCameraModal({ cameras, configs, onClose, onCreated }: {
    cameras: EditorCamera[];
    configs: ConfigSummary[];
    onClose: () => void;
    onCreated: (s: VideoStream) => void;
}) {
    const toast = useToast();
    const [camera, setCamera] = useState(cameras[0]?.id ?? '');
    const [config, setConfig] = useState(configs[0]?.id ?? '');
    const [busy, setBusy] = useState(false);
    const id = `${config}_${camera}`;
    const cam = cameras.find(c => c.id === camera);

    const create = async () => {
        setBusy(true);
        try {
            const s = await neuralApi.saveStream({
                id, name: cam?.name ?? camera, config_id: config, rows: 1, cols: 1, row_fr: [], col_fr: [],
                tiles: [{ camera, row: 0, col: 0, row_span: 1, col_span: 1, crop: [0, 0, 1, 1], fit: 'letterbox' }],
            });
            toast('Видеопоток создан', s.name || s.id, 'ok');
            onCreated(s);
        } catch (e) {
            toast('Не создан', e instanceof Error ? e.message : String(e), 'err');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title="Видеопоток из камеры" onClose={onClose} footer={
            <>
                <button className="btn btn--ghost spacer" onClick={onClose}>Отмена</button>
                <button className="btn btn--acc" disabled={busy || !camera || !config} onClick={create}>Создать</button>
            </>
        }>
            <div className="vl-form">
                <div className="tf"><span className="tf-cap">Камера</span>
                    <Select value={camera} onChange={setCamera} options={cameras.map(c => ({ value: c.id, label: c.name, hint: `${c.neural.width}×${c.neural.height}` }))} />
                </div>
                <div className="tf"><span className="tf-cap">Конфигурация</span>
                    <Select value={config} onChange={setConfig} options={configs.map(c => ({ value: c.id, label: c.name || c.id, hint: c.id }))} />
                </div>
                <div className="tf"><span className="tf-cap">Идентификатор</span><input className="tf-in is-ro" value={id} readOnly /></div>
                <div className="hint">Один тайл на всё полотно, кадр целиком, вписать. Потом поток можно править в редакторе.</div>
            </div>
        </Modal>
    );
}
