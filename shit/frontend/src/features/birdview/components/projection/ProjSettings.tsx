import { Icon } from '../../../../app/Icons';
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
    // Возврат к разметке, пришедшей с конфигурацией
    onRestorePlace: (key: string) => void;
    // Общий с калибровкой выбор камеры, коррекции и поток
    camera: CalibrationCamera | null;
    onSelectSourceCamera: (cam: CalibrationCamera) => void;
    correction: Correction;
    stream: StreamControl;
    wsReady: boolean;
    // Список камер грузит экран: он нужен и проходу «Применить все»
    sourceCams: CalibrationCamera[];
    sourceCamsError: boolean;
    // Проход по местам: идёт ли, какое место в работе и сколько пройдено
    applying: boolean;
    applyKey: string | null;
    applyStep: { done: number; total: number } | null;
    // Сколько мест уйдёт в проход при нажатии
    applyCount: number;
    lutReady: boolean;
    onApply: () => void;
    onStopApply: () => void;
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
    onRestorePlace,
    camera,
    onSelectSourceCamera,
    correction,
    stream,
    wsReady,
    sourceCams,
    sourceCamsError,
    applying,
    applyKey,
    applyStep,
    applyCount,
    lutReady,
    onApply,
    onStopApply,
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
            unbound: !boundId,
            saved: projState.savedPointsByCam[cam.key]?.length ?? 0,
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
                        <div
                            key={r.cam.key}
                            className={`crow${r.isActive ? ' is-sel' : ''}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => handlePlaceClick(r.cam.key)}
                            onKeyDown={e => {
                                if (e.key !== 'Enter' && e.key !== ' ') return;
                                e.preventDefault();
                                handlePlaceClick(r.cam.key);
                            }}
                        >
                            <span
                                className={`dot${r.done ? ' ok' : r.missing || r.unbound ? ' err' : r.full ? ' acc' : ''}`}
                            />
                            <span className="nm">{r.cam.name || r.cam.key}</span>
                            <span className="key">{r.cam.key}</span>
                            {applyKey === r.cam.key ? (
                                <span className="st"><span className="spin" />применяю</span>
                            ) : (
                                <span className={`st${r.missing || r.unbound ? ' er' : r.count === 0 ? ' mu' : ''}`}>
                                    {r.unbound
                                        ? 'нет камеры'
                                        : r.missing
                                          ? 'нет потока'
                                          : r.count === 0
                                            ? 'нет разметки'
                                            : pointsLabel(r.count)}
                                </span>
                            )}
                            {r.saved > 0 && (
                                <button
                                    className="icon-btn ib-row"
                                    data-tip="Восстановить загруженную разметку"
                                    onClick={e => {
                                        e.stopPropagation();
                                        onRestorePlace(r.cam.key);
                                    }}
                                >
                                    <Icon name="down" size={13} />
                                </button>
                            )}
                        </div>
                    ))
                )}
            </div>

            <div className="sv-foot">
                {/* Один проход по всем местам: готовые пропускаются, правка точек снимает готовность */}
                {applying ? (
                    <button className="btn btn--err btn--wide" onClick={onStopApply}>
                        Остановить · {applyStep ? `${applyStep.done} из ${applyStep.total}` : '…'}
                    </button>
                ) : (
                    <button
                        className="btn btn--acc btn--wide"
                        disabled={applyCount === 0}
                        onClick={onApply}
                    >
                        Применить warp{applyCount > 0 ? ` · ${applyCount}` : ''}
                    </button>
                )}
                <div className="row">
                    <button className="btn btn--save btn--wide" disabled={!lutReady || applying} onClick={onOpenLut}>
                        Рассчитать LUT
                    </button>
                </div>
            </div>
        </aside>
    );
}
