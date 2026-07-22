import { useEffect, useState } from 'react';
import { fetchCameraNames } from '../../api/cameras';

/** Модалка загрузки конфигураций калибровки. Порт config.js и loadConfigModal. */

export interface ConfigSummary {
    id: string;
    config_key?: string;
    width?: number;
    height?: number;
}

const CONFIG_FIELDS: Array<{ key: string; label: string }> = [
    { key: 'id', label: 'Идентификатор' },
    { key: 'width', label: 'Ширина' },
    { key: 'height', label: 'Высота' },
    { key: 'is_pattern', label: 'Паттерн задан' },
    { key: 'pattern_size', label: 'Размер ячейки (мм)' },
    { key: 'pattern_width', label: 'Ширина паттерна' },
    { key: 'pattern_height', label: 'Высота паттерна' },
    { key: 'is_calibration', label: 'Калибровка проведена' },
    { key: 'rms', label: 'RMS' },
    { key: 'alpha', label: 'Alpha' },
    { key: 'zoom', label: 'Приближение' },
    { key: 'shift_x', label: 'Смещение X' },
    { key: 'shift_y', label: 'Смещение Y' },
    { key: 'dist_coeffs', label: 'Коэффициенты искажений' },
    { key: 'is_undistortion', label: 'Коррекция применена' },
];

interface ConfigModalProps {
    configs: ConfigSummary[];
    /** null — деталь ещё грузится. */
    detail: Record<string, any> | null;
    selectedId: string | null;
    onSelect: (configKey: string) => void;
    onLoad: () => void;
    onClose: () => void;
}

export function ConfigModal({
    configs,
    detail,
    selectedId,
    onSelect,
    onLoad,
    onClose,
}: ConfigModalProps) {
    const [names, setNames] = useState<Record<string, string>>({});

    useEffect(() => {
        let alive = true;
        fetchCameraNames().then(map => {
            if (alive) setNames(map);
        });
        return () => {
            alive = false;
        };
    }, []);

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal-window modal-window--wide" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">Конфигурации калибровки</span>
                    <button className="toast-close" onClick={onClose}>✕</button>
                </div>

                <div className="modal-config-body">
                    <div className="config-list">
                        {configs.length === 0 ? (
                            <div className="custom-select-empty">Нет конфигураций</div>
                        ) : (
                            configs.map(cfg => {
                                const key = cfg.config_key ?? cfg.id;
                                return (
                                    <div
                                        key={key}
                                        className={`config-list-item${selectedId === key ? ' selected' : ''}`}
                                        onClick={() => onSelect(key)}
                                    >
                                        <span className="config-item-name">{names[cfg.id] ?? cfg.id}</span>
                                        <span className="config-item-sub">
                                            {cfg.id} · {cfg.width ?? '—'}×{cfg.height ?? '—'}
                                        </span>
                                    </div>
                                );
                            })
                        )}
                    </div>

                    {selectedId && (
                        <div className="config-detail">
                            <div className="config-table-wrap">
                                {detail === null ? (
                                    <div className="custom-select-loading">Загрузка...</div>
                                ) : (
                                    <table className="config-table">
                                        <tbody>
                                            {CONFIG_FIELDS.filter(f => f.key in detail).map(({ key, label }) => {
                                                const { text, cls } = formatField(key, detail[key]);
                                                return (
                                                    <tr key={key}>
                                                        <td>{label}</td>
                                                        <td className={cls}>{text}</td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <div className="modal-footer">
                    <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
                    <button className="btn btn-primary" onClick={onLoad} disabled={!selectedId}>
                        Загрузить
                    </button>
                </div>
            </div>
        </div>
    );
}

function formatField(key: string, val: unknown): { text: string; cls: string } {
    if (val == null) return { text: '—', cls: '' };

    if (['is_pattern', 'is_calibration', 'is_undistortion'].includes(key)) {
        return val ? { text: 'Да', cls: 'cv-ok' } : { text: 'Нет', cls: 'cv-err' };
    }

    if (key === 'rms') {
        const n = parseFloat(String(val));
        return {
            text: `${n.toFixed(3)} px`,
            cls: n < 0.5 ? 'cv-ok' : n < 1.5 ? 'cv-warn' : 'cv-err',
        };
    }

    if (key === 'dist_coeffs') {
        const isMat = typeof val === 'object' && val !== null && 'rows' in (val as object);
        return {
            text: isMat ? `${(val as any).rows}×${(val as any).cols} mat` : 'Получена',
            cls: 'cv-ok',
        };
    }

    if (['alpha', 'zoom', 'shift_x', 'shift_y'].includes(key)) {
        return { text: parseFloat(String(val)).toFixed(3), cls: '' };
    }

    return { text: String(val), cls: '' };
}
