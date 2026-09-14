import { useRef, useState } from 'react';
import { Modal } from '../../app/Modal';
import { neuralApi } from '../../features/neural/api/client';
import type { ConfigSummary, ImportMode, NeuralConfig } from '../../features/neural/api/types';

interface ImportModalProps {
    existing: ConfigSummary[];
    onClose: () => void;
    onImported: (count: number) => void;
}

interface Entry {
    id: string;
    classes: number;
    replaces: boolean;
}

// Импорт файла конфигураций: {id: config}; merge дополняет набор, replace заменяет его целиком
export function ImportModal({ existing, onClose, onImported }: ImportModalProps) {
    const fileRef = useRef<HTMLInputElement>(null);
    const [mode, setMode] = useState<ImportMode>('merge');
    const [data, setData] = useState<Record<string, NeuralConfig> | null>(null);
    const [fileName, setFileName] = useState('');
    const [err, setErr] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [over, setOver] = useState(false);

    const readFile = async (file: File | undefined) => {
        if (!file) return;
        setErr(null);
        try {
            const parsed = JSON.parse(await file.text()) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Ожидается объект { id: конфигурация }');
            for (const [id, cfg] of Object.entries(parsed as Record<string, unknown>)) {
                const c = cfg as Partial<NeuralConfig>;
                if (!c || typeof c !== 'object' || !c.model_path || !c.classes) throw new Error(`«${id}»: нет model_path или classes`);
            }
            setData(parsed as Record<string, NeuralConfig>);
            setFileName(file.name);
        } catch (e) {
            setData(null);
            setErr(e instanceof Error ? e.message : 'Файл не разобрался');
        } finally {
            if (fileRef.current) fileRef.current.value = '';
        }
    };

    const entries: Entry[] = data
        ? Object.entries(data).map(([id, cfg]) => ({ id, classes: Object.keys(cfg.classes ?? {}).length, replaces: existing.some(c => c.id === id) }))
        : [];

    const run = async () => {
        if (!data) return;
        setBusy(true);
        setErr(null);
        try {
            await neuralApi.importConfigurations(data, mode);
            onImported(entries.length);
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    };

    return (
        <Modal
            title="Импорт конфигураций"
            onClose={onClose}
            footer={
                <>
                    <button className="btn btn--ghost spacer" onClick={onClose}>Отмена</button>
                    <button className="btn btn--acc" disabled={!data || busy} onClick={run}>
                        {busy ? 'Импорт…' : entries.length ? `Импортировать ${entries.length}` : 'Импортировать'}
                    </button>
                </>
            }
        >
            <div className="modal-b" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div
                    className={`drop${over ? ' is-over' : ''}`}
                    style={{ minHeight: 96, display: 'grid', placeItems: 'center', textAlign: 'center', color: 'var(--fg-3)', fontSize: 12.5, cursor: 'pointer' }}
                    onClick={() => fileRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); setOver(true); }}
                    onDragLeave={() => setOver(false)}
                    onDrop={e => { e.preventDefault(); setOver(false); readFile(e.dataTransfer.files?.[0]); }}
                >
                    {fileName || 'Файл конфигураций .json'}
                </div>
                <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={e => readFile(e.target.files?.[0])} />

                {entries.length > 0 && (
                    <div>
                        {entries.map(en => (
                            <div className="imp-row" key={en.id}>
                                <span className="nm">{data?.[en.id]?.name || en.id}</span>
                                <span className="key">{en.id} · {en.classes} кл.</span>
                                <span className={`tag ${en.replaces ? 'is-warn' : 'is-ok'}`}>{en.replaces ? 'заменит существующую' : 'новая'}</span>
                            </div>
                        ))}
                    </div>
                )}

                <div className="tf">
                    <span className="tf-cap">Режим</span>
                    <div className="seg">
                        <button className={mode === 'merge' ? 'is-on' : ''} style={{ flex: 1 }} onClick={() => setMode('merge')}>Дополнить</button>
                        <button className={mode === 'replace' ? 'is-on' : ''} style={{ flex: 1 }} onClick={() => setMode('replace')}>Заменить все</button>
                    </div>
                </div>

                {err && <span className="hint is-err">{err}</span>}
            </div>
        </Modal>
    );
}
