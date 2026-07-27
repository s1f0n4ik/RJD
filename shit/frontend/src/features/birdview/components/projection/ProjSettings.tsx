import { projState, useProjStore } from '../../state/proj-store';
import { CustomSelect } from '../common/CustomSelect';
import { CameraCorrectionPanel } from '../shared/CameraCorrectionPanel';
import type { Correction } from '../../hooks/useCorrection';
import type { StreamControl } from '../../hooks/useStreamControl';
import type { CalibrationCamera } from '../../api/ws-types';

/** Выдвижная панель настроек проекции: пресет и список камер. Порт proj-settings.js и cam-list.js. */

interface ProjSettingsProps {
    open: boolean;
    onToggle: () => void;
    onOpenList: () => void;
    onSelectPreset: (configKey: string) => void;
    onSelectCamera: (key: string) => void;
    /** Общий с калибровкой выбор камеры, коррекции и поток. */
    camera: CalibrationCamera | null;
    onSelectSourceCamera: (cam: CalibrationCamera) => void;
    correction: Correction;
    stream: StreamControl;
    wsReady: boolean;
    /** Список камер грузит экран: он нужен и «Применить все» в футере. */
    sourceCams: CalibrationCamera[];
    sourceCamsError: boolean;
}

export function ProjSettings({
    open,
    onToggle,
    onOpenList,
    onSelectPreset,
    onSelectCamera,
    camera,
    onSelectSourceCamera,
    correction,
    stream,
    wsReady,
    sourceCams,
    sourceCamsError,
}: ProjSettingsProps) {
    useProjStore();

    /**
     * Клик по месту: выбор для разметки, а при сохранённой в пресете привязке —
     * ещё и переключение физической камеры той же логикой, что селект планки.
     * Уже активная или недоступная камера переключения не вызывает.
     */
    const handlePlaceClick = (key: string) => {
        onSelectCamera(key);
        const boundId = projState.camId[key];
        if (!boundId || boundId === camera?.id) return;
        const found = sourceCams.find(c => c.id === boundId);
        if (found) onSelectSourceCamera(found);
    };

    const cams = projState.activePreset?.cameras ?? [];

    return (
        <>
            <div className={`proj-settings-drawer${open ? ' open' : ''}`}>
                <div className="proj-settings-inner">
                    <CameraCorrectionPanel
                        camera={camera}
                        onSelectCamera={onSelectSourceCamera}
                        correction={correction}
                        stream={stream}
                        disabled={!wsReady}
                        cameras={sourceCams}
                        camerasError={sourceCamsError}
                    />

                    <div className="proj-settings-title">Настройки проекции</div>

                    <div>
                        <div className="proj-s-label">Вид конфигурации</div>
                        <CustomSelect
                            options={projState.presets.map(p => ({
                                value: p.config_key,
                                label: p.name ?? p.config_key,
                            }))}
                            value={projState.activePreset?.config_key ?? null}
                            placeholder="Не выбрано"
                            emptyText="Список не получен"
                            onOpen={onOpenList}
                            onChange={onSelectPreset}
                        />
                    </div>

                    <div>
                        <div className="proj-s-label">Камера</div>
                        <div className="proj-cam-list">
                            {cams.length === 0 ? (
                                <div className="proj-cam-empty">Выберите конфигурацию</div>
                            ) : (
                                cams.map(cam => {
                                    const isActive = projState.activeCam === cam.key;
                                    const isDone = projState.doneSet.has(cam.key);
                                    const count = isActive
                                        ? projState.points.length
                                        : projState.pointsByCam[cam.key]?.length ?? 0;
                                    const camId = projState.camId[cam.key];
                                    const calibKey = projState.calibKey[cam.key];

                                    return (
                                        <div
                                            key={cam.key}
                                            className={`proj-cam-item${isActive ? ' active' : ''}`}
                                            onClick={() => handlePlaceClick(cam.key)}
                                        >
                                            <div className="proj-cam-radio" />
                                            <span className="proj-cam-name">
                                                {cam.name || cam.key}
                                                {camId && (
                                                    <span className="proj-cam-id">
                                                        [{camId}{calibKey ? `, ${calibKey}` : ''}]
                                                    </span>
                                                )}
                                            </span>
                                            <span className="proj-cam-count">
                                                {count}/{cam.max_points ?? 0}
                                            </span>
                                            <div className={`proj-cam-done${isDone ? ' done' : ''}`} />
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <button className={`proj-settings-tab${open ? ' open' : ''}`} onClick={onToggle}>
                <span className="proj-tab-icon">⊞</span>
                <span className="proj-tab-label">Настройки</span>
            </button>
        </>
    );
}
