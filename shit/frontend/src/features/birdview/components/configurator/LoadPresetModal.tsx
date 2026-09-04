import { useEffect, useState } from 'react';
import { Icon } from '../../../../app/Icons';
import { Modal } from '../../../../app/Modal';
import { useToast } from '../common/Toast';
import { PresetPreview } from './PresetPreview';
import type { PresetPreviewData } from './PresetPreview';
import { linkerPath } from '../../api/linker';

// Загрузка сохранённого пресета в конфигуратор. Пресеты лежат в своём файле и
// принадлежат конфигуратору; экспорты сборки — другая сущность

export interface PresetSummary {
    key: string;
    name?: string;
    canvas?: { width?: number; height?: number };
    cameras?: number;
}

interface LoadPresetModalProps {
    // На поле уже что-то есть — загрузка сотрёт это
    dirty: boolean;
    onLoad: (key: string) => void;
    onClose: () => void;
}

export function LoadPresetModal({ dirty, onLoad, onClose }: LoadPresetModalProps) {
    const showToast = useToast();
    const [presets, setPresets] = useState<PresetSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);

    // Схема выбранного пресета тянется отдельно: в списке только сводные поля
    const [preview, setPreview] = useState<PresetPreviewData | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);

    // Удаление в два клика: первый взводит кнопку строки, второй удаляет
    const [armed, setArmed] = useState<string | null>(null);
    const [deleteBusy, setDeleteBusy] = useState(false);

    const handleDelete = async (key: string) => {
        if (armed !== key) {
            setArmed(key);
            return;
        }

        setDeleteBusy(true);
        try {
            const res = await fetch(linkerPath(`/linker/preset?key=${encodeURIComponent(key)}`), {
                method: 'DELETE',
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                let reason = text;
                try {
                    const parsed = JSON.parse(text);
                    reason = parsed.error ?? text;
                } catch { /* ответ не json */ }
                throw new Error(reason || `HTTP ${res.status}`);
            }
            setPresets(prev => (prev ? prev.filter(p => p.key !== key) : prev));
            if (selected === key) setSelected(null);
        } catch (e: unknown) {
            showToast('Не удалось удалить', e instanceof Error ? e.message : String(e), 'err');
        } finally {
            setDeleteBusy(false);
            setArmed(null);
        }
    };

    useEffect(() => {
        if (!selected) {
            setPreview(null);
            return;
        }

        let alive = true;
        setPreviewLoading(true);
        setPreview(null);

        fetch(linkerPath(`/linker/preset?key=${encodeURIComponent(selected)}`), {
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
        fetch(linkerPath('/linker/presets'), { headers: { Accept: 'application/json' } })
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
        // Загрузка заменяет поле целиком: второе нажатие подтверждает замену
        if (dirty && !confirming) {
            setConfirming(true);
            return;
        }
        onLoad(selected);
    };

    return (
        <Modal
            title="Загрузка конфигурации"
            size="mid"
            onClose={onClose}
            head={presets && presets.length > 0 ? <span className="eyebrow">{presets.length}</span> : undefined}
            footer={
                <>
                    <button className="btn btn--ghost spacer" onClick={onClose}>Отмена</button>
                    <button
                        className={`btn ${confirming ? 'btn--err' : 'btn--acc'}`}
                        disabled={!selected}
                        onClick={submit}
                    >
                        {confirming ? 'Заменить' : 'Загрузить'}
                    </button>
                </>
            }
        >
            <div className="modal-b conf-load">
                <div className="conf-load-list">
                    {presets === null ? (
                        <div className="empty"><span className="spin" /></div>
                    ) : error ? (
                        <div className="empty">
                            <Icon name="warn" />
                            <b>Список не получен</b>
                            <p className="num">{error}</p>
                        </div>
                    ) : presets.length === 0 ? (
                        <div className="empty">
                            <Icon name="empty" />
                            <b>Сохранённых конфигураций нет</b>
                        </div>
                    ) : (
                        presets.map(p => (
                            <div
                                key={p.key}
                                className={`cfg-row${selected === p.key ? ' is-sel' : ''}`}
                                onClick={() => {
                                    setSelected(p.key);
                                    setConfirming(false);
                                    setArmed(null);
                                }}
                            >
                                <div className="t">
                                    <b>{p.name || p.key}</b>
                                    <span>
                                        {p.key} · {p.canvas?.width ?? '—'}×{p.canvas?.height ?? '—'}
                                        {p.cameras != null && ` · ${p.cameras} камер`}
                                    </span>
                                </div>
                                <button
                                    className={`icon-btn${armed === p.key ? ' is-arm' : ''}`}
                                    data-tip={armed === p.key ? 'Ещё раз — удалить' : 'Удалить'}
                                    disabled={deleteBusy}
                                    onClick={e => {
                                        e.stopPropagation();
                                        handleDelete(p.key);
                                    }}
                                >
                                    <Icon name="trash" size={13} className="" />
                                </button>
                            </div>
                        ))
                    )}
                </div>

                <div className="conf-load-preview">
                    <PresetPreview preset={preview} loading={previewLoading} />
                </div>
            </div>
        </Modal>
    );
}
