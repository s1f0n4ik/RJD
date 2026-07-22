import type { LinkerExport } from '../../api/linker';

/** Список конфигураций stitching. Порт renderExportsList. */

interface ExportsListProps {
    exports: LinkerExport[];
    selectedId: string | null;
    loading: boolean;
    onSelect: (exp: LinkerExport) => void;
}

export function ExportsList({ exports, selectedId, loading, onSelect }: ExportsListProps) {
    if (loading) {
        return <div className="custom-select-loading">Загрузка...</div>;
    }

    if (!exports.length) {
        return <div className="custom-select-empty">Нет конфигураций</div>;
    }

    return (
        <div className="linker-list">
            {exports.map(exp => (
                <div
                    key={exp.id}
                    className={`linker-list-item${selectedId === exp.id ? ' selected' : ''}`}
                    onClick={() => onSelect(exp)}
                >
                    <div className="linker-list-main">
                        <span className="linker-list-name">{exp.name ?? exp.id}</span>
                        <span className="linker-list-id">{exp.id}</span>
                    </div>
                </div>
            ))}
        </div>
    );
}
