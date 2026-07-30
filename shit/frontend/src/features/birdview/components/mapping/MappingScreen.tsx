import { useCallback, useEffect, useState } from 'react';
import { linkerApi } from '../../api/linker';
import type { LinkerCamera } from '../../api/linker';
import { DEFAULT_CORRECTION_FPS, fetchCalibrationLinks, saveCalibrationLinks } from '../../api/links';
import type { CalibrationConfigInfo, CalibrationLinks } from '../../api/links';
import { useToast } from '../common/Toast';

/**
 * Экран «Сопоставление»: birdview-камера ↔ конфигурация калибровки.
 *
 * По сопоставлению плеер камеры показывает значок коррекции, а камера на
 * устройстве поднимает поток с выправленной картинкой. Разрешение здесь не
 * фильтруется: конфигурация могла быть снята с той же оптики в другом режиме,
 * жёсткая проверка происходит на устройстве в момент включения коррекции.
 */
export function MappingScreen({ active }: { active: boolean }) {
    const showToast = useToast();

    const [cameras, setCameras] = useState<LinkerCamera[]>([]);
    const [configs, setConfigs] = useState<CalibrationConfigInfo[]>([]);
    const [links, setLinks] = useState<CalibrationLinks>({});
    const [savedLinks, setSavedLinks] = useState<CalibrationLinks>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const [cams, data] = await Promise.all([linkerApi.getCameras(), fetchCalibrationLinks()]);
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
            showToast('Сопоставления сохранены', 'Коррекция доступна в плеерах камер', 'ok');
        } catch (e) {
            showToast('Не удалось сохранить', e instanceof Error ? e.message : String(e), 'err');
        } finally {
            setSaving(false);
        }
    };

    const configLabel = (c: CalibrationConfigInfo) =>
        `${c.name ?? c.config_key} · ${c.width}×${c.height}`;

    return (
        <main className={`main-layout mapping-layout ${active ? '' : 'hidden'}`}>
            <div className="mapping-panel panel-block">
                <div className="mapping-head">
                    <h2 className="mapping-title">Сопоставление камер и калибровок</h2>
                    <p className="mapping-hint">
                        Камера с назначенной конфигурацией получает в плеере значок коррекции
                        дисторсии. Разрешение конфигурации проверяется при включении.
                    </p>
                </div>

                {loading ? (
                    <div className="mapping-empty">Загрузка…</div>
                ) : cameras.length === 0 ? (
                    <div className="mapping-empty">Камер birdview нет</div>
                ) : (
                    <div className="mapping-rows">
                        {cameras.map(cam => (
                            <div key={cam.id} className="mapping-row">
                                <div className="mapping-camera">
                                    <span className="mapping-camera-name">{cam.display_name}</span>
                                    <span className="mapping-camera-id">{cam.id}</span>
                                </div>
                                <select
                                    className="field-input"
                                    value={links[cam.id]?.config ?? ''}
                                    onChange={e => {
                                        const key = e.target.value;
                                        setLinks(prev => {
                                            const next = { ...prev };
                                            if (key) {
                                                next[cam.id] = {
                                                    config: key,
                                                    fps: prev[cam.id]?.fps ?? DEFAULT_CORRECTION_FPS,
                                                };
                                            } else {
                                                delete next[cam.id];
                                            }
                                            return next;
                                        });
                                    }}
                                >
                                    <option value="">Без коррекции</option>
                                    {configs.map(c => (
                                        <option key={c.config_key} value={c.config_key}>
                                            {configLabel(c)}
                                        </option>
                                    ))}
                                </select>
                                <label className="mapping-fps">
                                    <span className="mapping-fps-label">FPS</span>
                                    <input
                                        type="number"
                                        className="field-input"
                                        min={1}
                                        max={60}
                                        disabled={!links[cam.id]}
                                        value={links[cam.id]?.fps ?? DEFAULT_CORRECTION_FPS}
                                        onChange={e => {
                                            const raw = Number(e.target.value);
                                            setLinks(prev => {
                                                const link = prev[cam.id];
                                                if (!link) return prev;
                                                return { ...prev, [cam.id]: { ...link, fps: raw } };
                                            });
                                        }}
                                        onBlur={() => {
                                            // Зажим на blur, а не на каждое нажатие — иначе «25» не набрать
                                            setLinks(prev => {
                                                const link = prev[cam.id];
                                                if (!link) return prev;
                                                const fps = Number.isFinite(link.fps)
                                                    ? Math.min(60, Math.max(1, Math.round(link.fps)))
                                                    : DEFAULT_CORRECTION_FPS;
                                                return { ...prev, [cam.id]: { ...link, fps } };
                                            });
                                        }}
                                    />
                                </label>
                            </div>
                        ))}
                    </div>
                )}

                <div className="mapping-actions">
                    <button className="btn btn-ghost" onClick={() => void reload()} disabled={loading || saving}>
                        Обновить
                    </button>
                    <button
                        className="btn btn-primary"
                        onClick={() => void handleSave()}
                        disabled={loading || saving || !dirty}
                    >
                        {saving ? 'Сохранение…' : 'Сохранить'}
                    </button>
                </div>
            </div>
        </main>
    );
}
