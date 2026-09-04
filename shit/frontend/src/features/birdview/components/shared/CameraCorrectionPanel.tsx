import { Switch } from '../../../../app/Modal';
import { CustomSelect } from '../common/CustomSelect';
import type { SelectOption } from '../common/CustomSelect';
import type { Correction } from '../../hooks/useCorrection';
import type { StreamControl } from '../../hooks/useStreamControl';
import type { CalibrationCamera } from '../../api/ws-types';

// Блок «Камера и коррекция» правой панели: лампы, камера, конфигурация, поток
// Камера и коррекция общие для всей страницы — калибратор один, кадр один

interface CameraCorrectionPanelProps {
    camera: CalibrationCamera | null;
    onSelectCamera: (cam: CalibrationCamera) => void;
    correction: Correction;
    stream: StreamControl;
    // Основной WS не открыт — поток не трогаем
    disabled: boolean;
    // Список камер грузит владелец: он нужен и клику по месту пресета
    cameras: CalibrationCamera[];
    camerasError: boolean;
}

export function CameraCorrectionPanel({
    camera,
    onSelectCamera,
    correction,
    stream,
    disabled,
    cameras,
    camerasError,
}: CameraCorrectionPanelProps) {
    const size = correction.selectedSize();

    const cameraOptions: SelectOption[] = cameras.map(c => ({
        value: c.id,
        label: c.displayName,
        note: `${c.width}×${c.height}`,
        muted: size ? c.width !== size.width || c.height !== size.height : false,
    }));

    const configOptions: SelectOption[] = correction.configs.map(cfg => ({
        value: cfg.config_key ?? cfg.id,
        // Своё имя, если оператор его задал: у одной камеры бывает несколько конфигураций
        label: cfg.name || cfg.config_key || cfg.id,
        note: `${cfg.width ?? '—'}×${cfg.height ?? '—'}`,
        muted: camera ? cfg.width !== camera.width || cfg.height !== camera.height : false,
    }));

    const live = Boolean(stream.streamId);

    return (
        <>
            <div className="blk-h"><h3>Камера и коррекция</h3></div>
            <div className="blk-b pad">
                <div className="lamps">
                    <span className="lamp">
                        <span className={`dot${camera ? ' ok' : camerasError ? ' err' : ''}`} />CAM
                    </span>
                    <span className="lamp">
                        <span className={`dot${correction.ready ? ' ok' : ''}`} />CFG
                    </span>
                    <span className={`lamp${stream.pending ? ' wait' : ''}`}>
                        <span className={`dot${live ? ' ok' : ''}`} />RTC
                    </span>
                </div>

                <div className="tf">
                    <span className="tf-cap">Камера</span>
                    <CustomSelect
                        options={cameraOptions}
                        value={camera?.id ?? null}
                        placeholder="Не выбрана"
                        emptyText={camerasError ? 'Ошибка загрузки' : 'Нет доступных камер'}
                        onChange={id => {
                            const found = cameras.find(c => c.id === id);
                            if (found) onSelectCamera(found);
                        }}
                    />
                </div>

                <div className="tf">
                    <span className="tf-cap">Конфигурация коррекции</span>
                    <CustomSelect
                        options={configOptions}
                        value={correction.selectedKey}
                        placeholder="Без коррекции"
                        emptyText="Список не получен"
                        onOpen={correction.requestList}
                        onChange={key => correction.select(key)}
                    />
                </div>

                <div className="cc-row">
                    {/* Пока коррекция на сервере не готова, тумблер скрыт */}
                    {correction.ready && (
                        <>
                            <Switch on={correction.enabled} disabled={disabled} onToggle={correction.setEnabled}>
                                Коррекция
                            </Switch>
                            <span className="tbar-sep" />
                        </>
                    )}
                    {stream.pending ? (
                        <button className="btn btn--sm btn--ghost" disabled>Подключение…</button>
                    ) : live ? (
                        <>
                            <button
                                className="btn btn--sm btn--ghost"
                                disabled={disabled || !camera}
                                title="Поднять поток заново"
                                onClick={() => camera && stream.restart(camera)}
                            >
                                Заново
                            </button>
                            <button
                                className="btn btn--sm btn--ghost"
                                disabled={disabled}
                                title="Закрыть поток"
                                onClick={stream.close}
                            >
                                Стоп
                            </button>
                        </>
                    ) : (
                        <button
                            className="btn btn--sm btn--ghost"
                            disabled={disabled || !camera}
                            onClick={() => camera && stream.open(camera)}
                        >
                            Запустить поток
                        </button>
                    )}
                </div>
            </div>
        </>
    );
}
