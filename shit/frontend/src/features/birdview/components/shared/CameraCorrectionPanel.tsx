import { CustomSelect } from '../common/CustomSelect';
import type { SelectOption } from '../common/CustomSelect';
import type { Correction } from '../../hooks/useCorrection';
import type { StreamControl } from '../../hooks/useStreamControl';
import type { CalibrationCamera } from '../../api/ws-types';

/**
 * Выбор камеры, конфигурации коррекции и управление потоком.
 *
 * Камера и коррекция общие для всей страницы: калибратор один, кадр один.
 * Поэтому выбор здесь двигает то же состояние, что и панель на калибровке.
 *
 * Компоновка — приборная планка: три лампы состояния и ряд кнопок под ними.
 * Карточки panel-block здесь нет намеренно. Она родилась в сайдбаре на 300px,
 * а ящик проекции — 220px, и рамка с отступами отъедала бы 30px ширины.
 *
 * Камеры с разрешением, отличным от выбранной конфигурации, помечаются серым,
 * но остаются кликабельными: не подходит конфигурация, а не камера. Выбор
 * такой камеры снимает конфигурацию — сервер всё равно откажет в load.
 */

interface CameraCorrectionPanelProps {
    camera: CalibrationCamera | null;
    onSelectCamera: (cam: CalibrationCamera) => void;
    correction: Correction;
    stream: StreamControl;
    /** Основной WS не открыт — трогать поток бессмысленно. */
    disabled: boolean;
    /** Список камер грузит владелец: он нужен и клику по месту пресета. */
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
        // Своё имя, если оператор его задал: одна камера может нести несколько
        // конфигураций, и различать их по id камеры невозможно
        label: cfg.name || cfg.config_key || cfg.id,
        note: `${cfg.width ?? '—'}×${cfg.height ?? '—'}`,
        muted: camera ? cfg.width !== camera.width || cfg.height !== camera.height : false,
    }));

    const live = Boolean(stream.streamId);

    return (
        <section className="cc-panel">
            <div className="cc-strip">
                <div className="cc-lamps">
                    <span className={`cc-lamp${camera ? ' on' : ''}`}>
                        <i />CAM
                    </span>
                    <span className={`cc-lamp${correction.ready ? ' on' : ''}`}>
                        <i />CFG
                    </span>
                    <span
                        className={
                            'cc-lamp cc-lamp--rtc' +
                            (live ? ' on' : '') +
                            (stream.pending ? ' pending' : '')
                        }
                    >
                        <i />RTC
                    </span>
                </div>

                <div className="cc-actions">
                    {stream.pending ? (
                        <button className="btn cc-act" disabled>
                            Подключение...
                        </button>
                    ) : live ? (
                        <>
                            <button
                                className="btn cc-act"
                                disabled={disabled || !camera}
                                title="Поднять поток заново"
                                onClick={() => camera && stream.restart(camera)}
                            >
                                ↻ Заново
                            </button>
                            <button
                                className="btn cc-act cc-act--stop"
                                disabled={disabled}
                                title="Закрыть поток"
                                onClick={stream.close}
                            >
                                ■ Стоп
                            </button>
                        </>
                    ) : (
                        <button
                            className="btn cc-act"
                            disabled={disabled || !camera}
                            title="Запустить поток выбранной камеры"
                            onClick={() => camera && stream.open(camera)}
                        >
                            ▶ Запустить стрим
                        </button>
                    )}
                </div>
            </div>

            <CustomSelect
                options={cameraOptions}
                value={camera?.id ?? null}
                placeholder="Выберите камеру"
                emptyText={camerasError ? 'Ошибка загрузки' : 'Нет доступных камер'}
                onChange={id => {
                    const found = cameras.find(c => c.id === id);
                    if (found) onSelectCamera(found);
                }}
            />

            <CustomSelect
                options={configOptions}
                value={correction.selectedKey}
                placeholder="Без коррекции"
                emptyText="Список не получен"
                onOpen={correction.requestList}
                onChange={key => correction.select(key)}
            />

            {/* Пока коррекция на сервере не готова, переключать нечего —
                тумблер скрыт, а не задизейблен */}
            {correction.ready && (
                <label className="toggle-row">
                    <span className="toggle-label">Коррекция</span>
                    <input
                        className="toggle-input"
                        type="checkbox"
                        checked={correction.enabled}
                        disabled={disabled}
                        onChange={e => correction.setEnabled(e.target.checked)}
                    />
                    <span className="toggle-track">
                        <span className="toggle-thumb" />
                    </span>
                </label>
            )}
        </section>
    );
}
