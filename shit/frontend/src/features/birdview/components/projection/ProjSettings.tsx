import { projState, useProjStore } from '../../state/proj-store';
import { CustomSelect } from '../common/CustomSelect';
import { CameraCorrectionPanel } from '../shared/CameraCorrectionPanel';
import type { Correction } from '../../hooks/useCorrection';
import type { StreamControl } from '../../hooks/useStreamControl';
import type { CalibrationCamera } from '../../api/ws-types';

// Правая панель сборки: камера и коррекция, пресет, камеры пресета, подвал действий

interface ProjSettingsProps {
    onOpenList: () => void;
    onSelectPreset: (configKey: string) => void;
    onSelectCamera: (key: string) => void;
    // Общий с калибровкой выбор камеры, коррекции и поток
    camera: CalibrationCamera | null;
    onSelectSourceCamera: (cam: CalibrationCamera) => void;
    correction: Correction;
    stream: StreamControl;
    wsReady: boolean;
    // Список камер грузит экран: он нужен и проходу «Применить все»
    sourceCams: CalibrationCamera[];
    sourceCamsError: boolean;
    // Прогресс прохода по всем камерам; null — проход не идёт
    busy: string | null;
    applyAllCount: number;
    lutReady: boolean;
    onToggleApply: () => void;
    onApplyAll: () => void;
    onOpenLut: () => void;
}

// Склонение «точка» по числу
function pointsLabel(n: number): string {
    const m10 = n % 10;
    const m100 = n % 100;
    const word =
        m10 === 1 && m100 !== 11
            ? 'точка'
            : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)
              ? 'точки'
              : 'точек';
    return `${n} ${word}`;
}

export function ProjSettings({
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
    busy,
    applyAllCount,
    lutReady,
    onToggleApply,
    onApplyAll,
    onOpenLut,
}: ProjSettingsProps) {
    useProjStore();

    // Клик по месту: выбор для разметки, при сохранённой привязке — ещё и переключение физической камеры
    const handlePlaceClick = (key: string) => {
        onSelectCamera(key);
        const boundId = projState.camId[key];
        if (!boundId || boundId === camera?.id) return;
        const found = sourceCams.find(c => c.id === boundId);
        if (found) onSelectSourceCamera(found);
    };

    const cams = projState.activePreset?.cameras ?? [];

    const rows = cams.map(cam => {
        const isActive = projState.activeCam === cam.key;
        const count = isActive ? projState.points.length : projState.pointsByCam[cam.key]?.length ?? 0;
        const max = projState.maxPointsByCam[cam.key] ?? 0;
        const boundId = projState.camId[cam.key];
        const missing = Boolean(boundId) && !sourceCams.some(c => c.id === boundId);
        return {
            cam,
            isActive,
            count,
            full: max > 0 && count >= max,
            done: projState.doneSet.has(cam.key),
            missing,
        };
    });

    const marked = rows.filter(r => r.full).length;

    return (
        <aside className="mod-side">
            <CameraCorrectionPanel
                camera={camera}
                onSelectCamera={onSelectSourceCamera}
                correction={correction}
                stream={stream}
                disabled={!wsReady}
                cameras={sourceCams}
                camerasError={sourceCamsError}
            />

            <div className="blk-h"><h3>Пресет</h3></div>
            <div className="blk-b pad">
                <div className="tf">
                    <span className="tf-cap">Пресет конфигуратора</span>
                    <CustomSelect
                        options={projState.presets.map(p => ({
                            value: p.config_key,
                            label: p.name ?? p.config_key,
                        }))}
                        value={projState.activePreset?.config_key ?? null}
                        placeholder="Не выбран"
                        emptyText="Список не получен"
                        onOpen={onOpenList}
                        onChange={onSelectPreset}
                    />
                </div>
            </div>

            <div className="blk-h">
                <h3>Камеры</h3>
                {cams.length > 0 && (
                    <span className={`pill spacer${marked === cams.length ? ' ok' : ''}`}>
                        <span className="dot" />размечено {marked} из {cams.length}
                    </span>
                )}
            </div>
            <div className="blk-b">
                {cams.length === 0 ? (
                    <div className="empty"><b>Пресет не выбран</b></div>
                ) : (
                    rows.map(r => (
                        <button
                            key={r.cam.key}
                            className={`crow${r.isActive ? ' is-sel' : ''}`}
                            onClick={() => handlePlaceClick(r.cam.key)}
                        >
                            <span
                                className={`dot${r.done ? ' ok' : r.missing ? ' err' : r.full ? ' acc' : ''}`}
                            />
                            <span className="nm">{r.cam.name || r.cam.key}</span>
                            <span className="key">{r.cam.key}</span>
                            <span className={`st${r.missing ? ' er' : r.count === 0 ? ' mu' : ''}`}>
                                {r.missing ? 'нет потока' : r.count === 0 ? 'нет разметки' : pointsLabel(r.count)}
                            </span>
                        </button>
                    ))
                )}
            </div>

            <div className="sv-foot">
                <button className="btn btn--acc btn--wide" disabled={busy !== null} onClick={onToggleApply}>
                    {projState.applied ? 'Вернуть редактирование' : 'Применить warp'}
                </button>
                <div className="row">
                    {/* Проход по всем местам с точками и привязками из пресета */}
                    <button className="btn" disabled={busy !== null || applyAllCount === 0} onClick={onApplyAll}>
                        {busy ? `Применяю ${busy}` : 'Применить все камеры'}
                    </button>
                    <button className="btn btn--save" disabled={!lutReady || busy !== null} onClick={onOpenLut}>
                        Рассчитать LUT
                    </button>
                </div>
            </div>
        </aside>
    );
}
