import { useRef, useState } from 'react';
import { neuralApi } from '../../api/client';
import type { ModelFile } from '../../api/types';
import { CustomSelect } from '../common/CustomSelect';

interface ModelUploadProps {
    models: ModelFile[];
    currentPath: string;
    editing: boolean;
    onPick: (path: string) => void;
    onUploaded: () => void;
}

/** Выбор модели из списка + загрузка нового .rknn (POST /neural/models). */
export function ModelUpload({ models, currentPath, editing, onPick, onUploaded }: ModelUploadProps) {
    const fileRef = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const options = models.map((m) => ({ value: m.path, label: `${m.filename} · ${kb(m.size)}` }));
    const currentName = currentPath.split('/').pop() || currentPath || '—';

    async function handleFile(file: File | undefined) {
        if (!file) return;
        if (!file.name.endsWith('.rknn')) {
            setErr('Разрешены только файлы .rknn');
            return;
        }
        setErr(null);
        setBusy(true);
        try {
            const saved = await neuralApi.uploadModel(file);
            onPick(saved.path);
            onUploaded();
        } catch (e) {
            setErr(e instanceof Error ? e.message : 'Ошибка загрузки');
        } finally {
            setBusy(false);
            if (fileRef.current) fileRef.current.value = '';
        }
    }

    return (
        <div className="field-group">
            <span className="field-label">Модель (.rknn)</span>
            {editing ? (
                <>
                    <CustomSelect options={options} value={currentPath || null} placeholder="— выбрать модель —" onChange={onPick} />
                    <button className="btn btn-load btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
                        {busy ? 'загрузка…' : '⭱ загрузить новую модель'}
                    </button>
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".rknn"
                        style={{ display: 'none' }}
                        onChange={(e) => handleFile(e.target.files?.[0])}
                    />
                    {err && <div className="error-box">{err}</div>}
                </>
            ) : (
                <input className="field-input" value={currentName} disabled readOnly />
            )}
        </div>
    );
}

function kb(bytes: number): string {
    if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
}