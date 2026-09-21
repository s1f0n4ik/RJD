import { Icon } from '../../../../app/Icons';
import { projState, useProjStore } from '../../state/proj-store';
import { CustomSelect } from '../common/CustomSelect';
import type { Correction } from '../../hooks/useCorrection';
import type { CalibrationCamera } from '../../api/ws-types';

// Правая панель сборки: пресет, места с камерой и коррекцией, подвал действий

interface ProjSettingsProps {
    onOpenList: () => void;
    onSelectPreset: (configKey: string) => void;
    onSelectPlace: (key: string) => void;
    // Возврат к разметке, пришедшей с конфигурацией
    onRestorePlace: (key: string) => void;
    // Камера, чей кадр сейчас в калибраторе
    camera: CalibrationCamera | null;
    // Поднять кадр камеры, привязка мест не меняется
    onShowCamera: (cam: CalibrationCamera) => void;
    onAssignCamera: (placeKey: string, cam: CalibrationCamera) => void;
    // null снимает выбор оператора: место возвращается к ключу пресета
    onSetCorrection: (placeKey: string, key: string | null) => void;
    correction: Correction;
    // Поток не идёт и не поднимается
    streamIdle: boolean;
    // Список камер грузит экран: он нужен и проходу по местам
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

type CorrSource = 'preset' | 'manual' | 'loaded';

const CORR_SOURCE_LABEL: Record<CorrSource, string> = {
    preset: 'из пресета',
    manual: 'вручную',
    loaded: 'загружена',
};

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
    onSelectPlace,
    onRestorePlace,
    camera,
    onShowCamera,
    onAssignCamera,
    onSetCorrection,
    correction,
    streamIdle,
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

    // Клик по месту: выбор для разметки и кадр привязанной камеры
    const handlePlaceClick = (key: string) => {
        onSelectPlace(key);
        const bound = sourceCams.find(c => c.id === projState.camId[key]);
        if (!bound) return;
        if (bound.id !== camera?.id || streamIdle) onShowCamera(bound);
    };

    const findConfig = (key: string | null) =>
        key ? correction.configs.find(c => (c.config_key ?? c.id) === key) : undefined;

    const cams = projState.activePreset?.cameras ?? [];

    const rows = cams.map(cam => {
        const isActive = projState.activeCam === cam.key;
        const count = isActive ? projState.points.length : projState.pointsByCam[cam.key]?.length ?? 0;
        const max = projState.maxPointsByCam[cam.key] ?? 0;
        const boundId = projState.camId[cam.key];
        const bound = sourceCams.find(c => c.id === boundId) ?? null;

        // Ключ места, без него у активного места действует загруженная в калибраторе
        const placeCorr = projState.calibKey[cam.key] ?? null;
        const corrKey = placeCorr ?? (isActive ? correction.loadedKey : null);
        const corrSource: CorrSource | null = placeCorr
            ? placeCorr === projState.presetCalibKey[cam.key] ? 'preset' : 'manual'
            : corrKey ? 'loaded' : null;
        const cfg = findConfig(corrKey);

        return {
            cam,
            isActive,
            count,
            full: max > 0 && count >= max,
            done: projState.doneSet.has(cam.key),
            bound,
            missing: Boolean(boundId) && !bound,
            unbound: !boundId,
            saved: projState.savedPointsByCam[cam.key]?.length ?? 0,
            corrKey,
            corrSource,
            corrLabel: cfg?.name || corrKey,
            // Сервер принимает коррекцию только под разрешение кадра
            corrBad: Boolean(cfg && bound && (cfg.width !== bound.width || cfg.height !== bound.height)),
            hasPresetCorr: Boolean(projState.presetCalibKey[cam.key]),
        };
    });

    const doneCount = rows.filter(r => r.done).length;

    const cameraOptions = (placeKey: string) =>
        sourceCams.map(c => ({
            value: c.id,
            label: c.displayName,
            note: `${c.width}×${c.height}`,
            // Камера уже стоит на другом месте
            muted: Object.entries(projState.camId).some(([k, id]) => k !== placeKey && id === c.id),
        }));

    const configOptions = (bound: CalibrationCamera | null) =>
        correction.configs.map(cfg => ({
            value: cfg.config_key ?? cfg.id,
            label: cfg.name || cfg.config_key || cfg.id,
            note: `${cfg.width ?? '—'}×${cfg.height ?? '—'}`,
            muted: bound ? cfg.width !== bound.width || cfg.height !== bound.height : false,
        }));

    return (
        <aside className="mod-side">
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
                <h3>Места</h3>
                {cams.length > 0 && (
                    <span className={`pill spacer${doneCount === cams.length ? ' ok' : ''}`}>
                        <span className="dot" />собрано {doneCount} из {cams.length}
                    </span>
                )}
            </div>
            <div className="blk-b">
                {cams.length === 0 ? (
                    <div className="empty"><b>Пресет не выбран</b></div>
                ) : (
                    rows.map(r => (
                        <div key={r.cam.key} className={`pl${r.isActive ? ' is-sel' : ''}`}>
                            <div
                                className="pl-h"
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
                                    <span
                                        className={`st${r.missing || r.unbound ? ' er' : r.done ? '' : r.full ? ' ac' : ' mu'}`}
                                    >
                                        {r.unbound
                                            ? 'нет камеры'
                                            : r.missing
                                              ? 'нет потока'
                                              : r.done
                                                ? 'собрано'
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

                            {!r.isActive && r.bound && (
                                <div className="pl-sum">
                                    <span className="cam">{r.bound.displayName}</span>
                                    {r.corrKey && r.corrSource && (
                                        <span className={`corr is-${r.corrSource}${r.corrBad ? ' is-bad' : ''}`}>
                                            <span className="k">{r.corrLabel}</span>
                                        </span>
                                    )}
                                </div>
                            )}

                            {r.isActive && (
                                <div className="pl-b">
                                    <div className="tf">
                                        <span className="tf-cap">Камера</span>
                                        <CustomSelect
                                            options={cameraOptions(r.cam.key)}
                                            value={r.bound?.id ?? null}
                                            placeholder="Не назначена"
                                            emptyText={sourceCamsError ? 'Ошибка загрузки' : 'Нет доступных камер'}
                                            disabled={applying}
                                            onChange={id => {
                                                const found = sourceCams.find(c => c.id === id);
                                                if (found) onAssignCamera(r.cam.key, found);
                                            }}
                                        />
                                    </div>

                                    <div className={`tf${r.bound ? '' : ' is-off'}${r.corrBad ? ' is-bad' : ''}`}>
                                        <span className="tf-cap">
                                            Коррекция
                                            {r.corrSource && (
                                                <span className={`corr-src is-${r.corrSource}`}>
                                                    {CORR_SOURCE_LABEL[r.corrSource]}
                                                </span>
                                            )}
                                        </span>
                                        <div className="tf-line">
                                            <CustomSelect
                                                options={configOptions(r.bound)}
                                                value={r.corrKey}
                                                placeholder="Без коррекции"
                                                emptyText="Список не получен"
                                                disabled={applying}
                                                onOpen={correction.requestList}
                                                onChange={key => onSetCorrection(r.cam.key, key)}
                                            />
                                            {r.corrSource === 'manual' && (
                                                <button
                                                    className="icon-btn"
                                                    data-tip={r.hasPresetCorr ? 'Вернуть из пресета' : 'Снять выбор'}
                                                    disabled={applying}
                                                    onClick={() => onSetCorrection(r.cam.key, null)}
                                                >
                                                    <Icon name="reset" size={13} />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>

            <div className="sv-foot">
                {/* Один проход по всем местам: готовые пропускаются, правка точек снимает готовность */}
                {applying ? (
                    <button className="btn btn--err btn--wide" onClick={onStopApply}>
                        <span className="seps">
                            <span>Остановить</span>
                            <span>{applyStep ? `${applyStep.done} из ${applyStep.total}` : '…'}</span>
                        </span>
                    </button>
                ) : (
                    <button
                        className="btn btn--acc btn--wide"
                        disabled={applyCount === 0}
                        onClick={onApply}
                    >
                        <span className="seps">
                            <span>Применить warp</span>
                            {applyCount > 0 ? <span>{applyCount}</span> : null}
                        </span>
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
