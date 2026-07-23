import { useEffect, useState } from 'react';
import { PresetPreview } from './PresetPreview';
import type { PresetPreviewData } from './PresetPreview';

/**
 * Загрузка сохранённого пресета в конфигуратор для правки.
 *
 * Пресеты лежат в своём файле и принадлежат конфигуратору. Экспорты сборки —
 * другая сущность в другом файле, здесь их нет.
 */

export interface PresetSummary {
    key: string;
    name?: string;
    canvas?: { width?: number; height?: number };
    cameras?: number;
}

interface LoadPresetModalProps {
    /** На поле уже что-то есть — загрузка сотрёт это. */
    dirty: boolean;
    onLoad: (key: string) => void;
    onClose: () => void;
}

export function LoadPresetModal({ dirty, onLoad, onClose }: LoadPresetModalProps) {
    const [presets, setPresets] = useState<PresetSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);

    // Схема выбранного пресета. Тянется отдельно от списка: в списке лежат
    // только сводные поля, а геометрия — в самой записи
    const [preview, setPreview] = useState<PresetPreviewData | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);

    useEffect(() => {
        if (!selected) {
            setPreview(null);
            return;
        }

        let alive = true;
        setPreviewLoading(true);
        setPreview(null);

        fetch(`/linker/preset?key=${encodeURIComponent(selected)}`, {
            headers: { Accept: 'application/json' },
        })
            .then(async res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then(json => {
                if (alive) setPreview(json.data ?? json);
            })
            .catch(() => {
                if (alive) setPreview(null);
            })
            .finally(() => {
                if (alive) setPreviewLoading(false);
            });

        return () => {
            alive = false;
        };
    }, [selected]);

    useEffect(() => {
        let alive = true;
        fetch('/linker/presets', { headers: { Accept: 'application/json' } })
            .then(async res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then(json => {
                if (!alive) return;
                setPresets(json.data?.presets ?? json.presets ?? []);
            })
            .catch((e: unknown) => {
                if (!alive) return;
                setError(e instanceof Error ? e.message : String(e));
                setPresets([]);
            });
        return () => {
            alive = false;
        };
    }, []);

    const submit = () => {
        if (!selected) return;
        // Загрузка заменяет поле целиком: ключи камер двух пресетов совпали бы,
        // и разобрать потом, что откуда, было бы нельзя
        if (dirty && !confirming) {
            setConfirming(true);
            return;
        }
        onLoad(selected);
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal-window modal-window--wide" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">Загрузка конфигурации</span>
                    <button className="toast-close" onClick={onClose}>✕</button>
                </div>

                <div className="modal-config-body">
                    <div className="config-list">
                        {presets === null ? (
                            <div className="custom-select-loading">Загрузка...</div>
                        ) : error ? (
                            <div className="custom-select-empty">Не удалось получить список: {error}</div>
                        ) : presets.length === 0 ? (
                            <div className="custom-select-empty">Сохранённых конфигураций нет</div>
                        ) : (
                            presets.map(p => (
                                <div
                                    key={p.key}
                                    className={`config-list-item${selected === p.key ? ' selected' : ''}`}
                                    onClick={() => {
                                        setSelected(p.key);
                                        setConfirming(false);
                                    }}
                                >
                                    <span className="config-item-name">{p.name || p.key}</span>
                                    <span className="config-item-sub">
                                        {p.key} · {p.canvas?.width ?? '—'}×{p.canvas?.height ?? '—'}
                                        {p.cameras != null && ` · ${p.cameras} камер`}
                                    </span>
                                </div>
                            ))
                        )}
                    </div>

                    <div className="config-detail">
                        <div className="preset-preview-wrap">
                            <PresetPreview preset={preview} loading={previewLoading} />
                        </div>

                        <div className="preset-preview-foot">
                            <p className="modal-hint">
                                Имена зон и шаг сетки восстанавливаются, если конфигурация
                                сохранена этой версией. У более старых имена будут созданы заново.
                            </p>
                            {confirming && (
                                <p className="modal-text modal-text--warn">
                                    На поле уже есть камеры и разметка. Загрузка заменит их целиком.
                                </p>
                            )}
                        </div>
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
                    <button
                        className={`btn ${confirming ? 'btn-danger' : 'btn-primary'}`}
                        disabled={!selected}
                        onClick={submit}
                    >
                        {confirming ? 'Заменить' : 'Загрузить'}
                    </button>
                </div>
            </div>
        </div>
    );
}
