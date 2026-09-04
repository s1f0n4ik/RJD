import { Modal } from '../../../../app/Modal';
import { Icon } from '../../../../app/Icons';

// Модалка загрузки конфигураций калибровки: список слева, поля справа

export interface ConfigSummary {
    id: string;
    config_key?: string;
    // Своё имя конфигурации, у старых записей отсутствует
    name?: string;
    width?: number;
    height?: number;
}

const CONFIG_FIELDS: Array<{ key: string; label: string }> = [
    { key: 'id', label: 'Камера' },
    { key: 'width', label: 'Ширина' },
    { key: 'height', label: 'Высота' },
    { key: 'is_pattern', label: 'Шаблон задан' },
    { key: 'pattern_size', label: 'Клетка, мм' },
    { key: 'pattern_width', label: 'Столбцов' },
    { key: 'pattern_height', label: 'Строк' },
    { key: 'is_calibration', label: 'Калибровка' },
    { key: 'rms', label: 'RMS' },
    { key: 'alpha', label: 'Альфа' },
    { key: 'zoom', label: 'Приближение' },
    { key: 'shift_x', label: 'Смещение X' },
    { key: 'shift_y', label: 'Смещение Y' },
    { key: 'dist_coeffs', label: 'Коэффициенты' },
    { key: 'is_undistortion', label: 'Коррекция' },
];

interface ConfigModalProps {
    configs: ConfigSummary[];
    // null — деталь ещё грузится
    detail: Record<string, any> | null;
    selectedId: string | null;
    // Конфигурация, загруженная на сервере сейчас
    loadedKey: string | null;
    onSelect: (configKey: string) => void;
    onLoad: () => void;
    onClose: () => void;
}

export function ConfigModal({ configs, detail, selectedId, loadedKey, onSelect, onLoad, onClose }: ConfigModalProps) {
    return (
        <Modal
            title="Конфигурации коррекции"
            onClose={onClose}
            size="mid"
            head={<span className="eyebrow">{configs.length}</span>}
            footer={
                <>
                    <button className="btn btn--ghost" style={{ color: 'var(--err)' }} disabled>
                        Удалить
                    </button>
                    <button className="btn btn--ghost spacer" onClick={onClose}>
                        Отмена
                    </button>
                    <button className="btn btn--acc" onClick={onLoad} disabled={!selectedId}>
                        Загрузить
                    </button>
                </>
            }
        >
            <div className="modal-b cfg-body">
                <div className="cfg-list">
                    {configs.length === 0 ? (
                        <div className="empty">
                            <Icon name="empty" className="ico" />
                            <b>Нет конфигураций</b>
                        </div>
                    ) : (
                        configs.map(cfg => {
                            const key = cfg.config_key ?? cfg.id;
                            const loaded = loadedKey === key;
                            return (
                                <button
                                    key={key}
                                    className={`cfg-row${selectedId === key ? ' is-sel' : ''}`}
                                    onClick={() => onSelect(key)}
                                >
                                    <span className={`dot${loaded ? ' ok' : ''}`} />
                                    <div className="t">
                                        <b title={cfg.name || undefined}>{key}</b>
                                        <span>{`${cfg.id} · ${cfg.width ?? '—'}×${cfg.height ?? '—'}`}</span>
                                    </div>
                                    {loaded && <span className="tag is-ok">загружена</span>}
                                </button>
                            );
                        })
                    )}
                </div>

                <div className="cfg-detail">
                    {!selectedId ? (
                        <div className="empty">
                            <Icon name="empty" className="ico" />
                            <b>Не выбрано</b>
                        </div>
                    ) : detail === null ? (
                        <div className="empty">
                            <span className="spin" />
                        </div>
                    ) : (
                        <>
                            <div className="kv">
                                <span className="k">Ключ</span>
                                <span className="v num">{selectedId}</span>
                            </div>
                            {CONFIG_FIELDS.filter(f => f.key in detail).map(({ key, label }) => {
                                const { text, cls, num } = formatField(key, detail[key]);
                                return (
                                    <div key={key} className="kv">
                                        <span className="k">{label}</span>
                                        <span className={`v${num ? ' num' : ''}${cls ? ` ${cls}` : ''}`}>{text}</span>
                                    </div>
                                );
                            })}
                        </>
                    )}
                </div>
            </div>
        </Modal>
    );
}

function formatField(key: string, val: unknown): { text: string; cls: string; num: boolean } {
    if (val == null) return { text: '—', cls: '', num: false };

    if (['is_pattern', 'is_calibration', 'is_undistortion'].includes(key)) {
        return val ? { text: 'есть', cls: 'ok', num: false } : { text: 'нет', cls: 'err', num: false };
    }

    if (key === 'rms') {
        const n = parseFloat(String(val));
        return {
            text: `${n.toFixed(3)} px`,
            cls: n < 0.5 ? 'ok' : n < 1.5 ? 'warn' : 'err',
            num: true,
        };
    }

    if (key === 'dist_coeffs') {
        const isMat = typeof val === 'object' && val !== null && 'rows' in (val as object);
        return {
            text: isMat ? `${(val as any).rows}×${(val as any).cols}` : 'есть',
            cls: 'ok',
            num: isMat,
        };
    }

    if (['alpha', 'zoom', 'shift_x', 'shift_y'].includes(key)) {
        return { text: parseFloat(String(val)).toFixed(3), cls: '', num: true };
    }

    return { text: String(val), cls: '', num: typeof val === 'number' };
}
