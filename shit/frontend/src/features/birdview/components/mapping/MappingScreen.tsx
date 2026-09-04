import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { Select } from '../../../../app/Select';
import { fetchCalibrationCameras } from '../../api/cameras';
import type { CalibrationCamera } from '../../api/ws-types';
import { DEFAULT_CORRECTION_FPS, fetchCalibrationLinks, saveCalibrationLinks } from '../../api/links';
import type { CalibrationConfigInfo, CalibrationLinks } from '../../api/links';
import { useToast } from '../common/Toast';
import '../../../../screens/surround/mapping.css';

// Совпадение разрешения камеры и конфигурации: на устройстве это условие включения коррекции
type Match = 'ok' | 'mismatch' | 'none';

function matchOf(cam: CalibrationCamera, cfg: CalibrationConfigInfo | undefined): Match {
    if (!cfg) return 'none';
    return cfg.width === cam.width && cfg.height === cam.height ? 'ok' : 'mismatch';
}

/** Экран «Сопоставление»: камера 360 ↔ конфигурация коррекции и частота коррекционного потока. */
export function MappingScreen({ active }: { active: boolean }) {
    const showToast = useToast();

    const [cameras, setCameras] = useState<CalibrationCamera[]>([]);
    const [configs, setConfigs] = useState<CalibrationConfigInfo[]>([]);
    const [links, setLinks] = useState<CalibrationLinks>({});
    const [savedLinks, setSavedLinks] = useState<CalibrationLinks>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const [cams, data] = await Promise.all([fetchCalibrationCameras(), fetchCalibrationLinks()]);
            setCameras(cams);
            setConfigs(data.configs);
            setLinks(data.links);
            setSavedLinks(data.links);
        } catch (e) {
            showToast('Сопоставления не загружены', e instanceof Error ? e.message : String(e), 'err');
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    useEffect(() => {
        if (active) void reload();
    }, [active, reload]);

    const dirty = JSON.stringify(links) !== JSON.stringify(savedLinks);

    const handleSave = async () => {
        setSaving(true);
        try {
            await saveCalibrationLinks(links);
            setSavedLinks(links);
            showToast('Сопоставления сохранены', '', 'ok');
        } catch (e) {
            showToast('Не удалось сохранить', e instanceof Error ? e.message : String(e), 'err');
        } finally {
            setSaving(false);
        }
    };

    const configByKey = (key: string | undefined) => configs.find(c => c.config_key === key);
    const usedBy = (key: string) => Object.values(links).filter(l => l.config === key).length;

    const withCorrection = cameras.filter(c => links[c.id]).length;
    const mismatched = cameras.filter(c => matchOf(c, configByKey(links[c.id]?.config)) === 'mismatch').length;

    const options = [
        { value: '', label: 'Без коррекции' },
        ...configs.map(c => ({ value: c.config_key, label: c.name ?? c.config_key, hint: `${c.width}×${c.height}` })),
    ];

    const setConfig = (cameraId: string, key: string) =>
        setLinks(prev => {
            const next = { ...prev };
            if (key) next[cameraId] = { config: key, fps: prev[cameraId]?.fps ?? DEFAULT_CORRECTION_FPS };
            else delete next[cameraId];
            return next;
        });

    const setFps = (cameraId: string, raw: number) =>
        setLinks(prev => {
            const link = prev[cameraId];
            return link ? { ...prev, [cameraId]: { ...link, fps: raw } } : prev;
        });

    // Зажим на blur, а не на каждое нажатие — иначе «25» не набрать
    const clampFps = (cameraId: string) =>
        setLinks(prev => {
            const link = prev[cameraId];
            if (!link) return prev;
            const fps = Number.isFinite(link.fps) ? Math.min(60, Math.max(1, Math.round(link.fps))) : DEFAULT_CORRECTION_FPS;
            return { ...prev, [cameraId]: { ...link, fps } };
        });

    return (
        <div className={`sv sv-map${active ? '' : ' is-hidden'}`}>
            <div className="sv-main">
                <div className="toolbar">
                    <span className="pill"><span className="dot acc" />камер 360 · {cameras.length}</span>
                    <span className={`pill${withCorrection ? ' ok' : ''}`}><span className="dot" />с коррекцией · {withCorrection}</span>
                    {mismatched > 0 && (
                        <span className="pill warn"><span className="dot" />разрешение не совпадает · {mismatched}</span>
                    )}
                    <div className="pills">
                        <button className="btn btn--sm" onClick={() => void reload()} disabled={loading || saving}>
                            <Icon name="refresh" className="ico" />Обновить
                        </button>
                    </div>
                </div>

                <div className="tab-wrap map-wrap">
                    {loading ? (
                        <div className="empty"><span className="spin" /></div>
                    ) : cameras.length === 0 ? (
                        <div className="empty"><Icon name="empty" className="ico" /><b>Камер с назначением 360 нет</b></div>
                    ) : (
                        <table className="tab map-tab">
                            <thead>
                                <tr>
                                    <th>Камера 360</th>
                                    <th className="r">Разрешение</th>
                                    <th>Конфигурация коррекции</th>
                                    <th className="r">Частота, к/с</th>
                                    <th>Совпадение</th>
                                </tr>
                            </thead>
                            <tbody>
                                {cameras.map(cam => {
                                    const link = links[cam.id];
                                    const cfg = configByKey(link?.config);
                                    const match = matchOf(cam, cfg);
                                    return (
                                        <tr key={cam.id}>
                                            <td className="cam"><b>{cam.displayName}</b><span>{cam.id}</span></td>
                                            <td className="r">{cam.width && cam.height ? `${cam.width}×${cam.height}` : '—'}</td>
                                            <td>
                                                <div className="tf">
                                                    <Select value={link?.config ?? ''} options={options} onChange={key => setConfig(cam.id, key)} />
                                                </div>
                                            </td>
                                            <td className="r">
                                                <input
                                                    type="number"
                                                    className="tf-in fps"
                                                    min={1}
                                                    max={60}
                                                    disabled={!link}
                                                    value={link?.fps ?? DEFAULT_CORRECTION_FPS}
                                                    onChange={e => setFps(cam.id, Number(e.target.value))}
                                                    onBlur={() => clampFps(cam.id)}
                                                    onWheel={e => e.currentTarget.blur()}
                                                />
                                            </td>
                                            <td>
                                                {match === 'ok' && <span className="tag is-ok">{cfg!.width}×{cfg!.height}</span>}
                                                {match === 'mismatch' && <span className="tag is-warn">{cfg!.width}×{cfg!.height} ≠ {cam.width}×{cam.height}</span>}
                                                {match === 'none' && <span className="tag">—</span>}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>

                <div className="sv-statusbar">
                    {dirty && <span className="tag is-warn">есть несохранённые правки</span>}
                    <span className="spacer" />
                    <button className="btn btn--sm btn--ghost" onClick={() => setLinks(savedLinks)} disabled={!dirty || saving}>
                        Сбросить
                    </button>
                    <button className="btn btn--sm btn--acc" onClick={() => void handleSave()} disabled={loading || saving || !dirty}>
                        {saving ? 'Сохранение…' : 'Сохранить сопоставления'}
                    </button>
                </div>
            </div>

            <aside className="mod-side">
                <div className="blk-h"><h3>Библиотека калибровок</h3><span className="eyebrow spacer">{configs.length}</span></div>
                <div className="lib">
                    {configs.length === 0 && <div className="cfg-empty">Конфигураций нет</div>}
                    {configs.map(c => {
                        const n = usedBy(c.config_key);
                        return (
                            <div key={c.config_key} className={`libc${n ? ' is-used' : ''}`}>
                                <span className="k">{c.config_key}</span>
                                <div className="m">
                                    <span className={`tag${n ? ' is-acc' : ''}`}>{n ? `${n} ${plural(n, 'камера', 'камеры', 'камер')}` : 'не используется'}</span>
                                    <span className="tag">{c.id}</span>
                                    <span className="tag">{c.width}×{c.height}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </aside>
        </div>
    );
}

function plural(n: number, one: string, few: string, many: string): string {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
}
