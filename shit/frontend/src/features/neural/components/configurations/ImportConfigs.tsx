import { useRef, useState } from 'react';
import { neuralApi } from '../../api/client';
import type { ImportMode, NeuralConfig } from '../../api/types';

interface ImportConfigsProps {
  onImported: () => void;
}

/** Импорт конфигураций JSON-файлом → POST /neural/configurations. */
export function ImportConfigs({ onImported }: ImportConfigsProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text) as Record<string, NeuralConfig>;
      if (typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Ожидается объект { id: конфигурация }');
      }
      await neuralApi.importConfigurations(data, mode);
      setMsg(`Импортировано: ${Object.keys(data).length} конфигурац.`);
      onImported();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка импорта');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-icon">⭳</span>
        <span className="panel-title">Импорт конфигураций</span>
      </div>
      <div className="btn-row">
        <button
          className={`btn btn-sm ${mode === 'merge' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setMode('merge')}
        >
          merge
        </button>
        <button
          className={`btn btn-sm ${mode === 'replace' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setMode('replace')}
        >
          replace all
        </button>
      </div>
      <button className="btn btn-accent" disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? 'импорт…' : '⭱ выбрать JSON-файл'}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      {msg && <div className="hint" style={{ color: 'var(--ok)' }}>{msg}</div>}
      {err && <div className="error-box">{err}</div>}
    </div>
  );
}
