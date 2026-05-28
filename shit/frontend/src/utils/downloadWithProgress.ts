/**
 * Скачивает файл с прогрессом и сохраняет в выбранное пользователем место.
 * Использует File System Access API там, где доступен (Chrome/Edge),
 * иначе fallback на blob + <a download>.
 */
export async function downloadWithProgress(
    url: string,
    suggestedName: string,
    mimeType: string,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal,
): Promise<void> {
    // @ts-ignore
    const canPickFile = typeof window.showSaveFilePicker === 'function';

    let writable: any = null;

    if (canPickFile) {
        try {
            // @ts-ignore
            const handle = await window.showSaveFilePicker({ suggestedName });
            writable = await handle.createWritable();
        } catch (e: any) {
            if (e.name === 'AbortError') throw new Error('Загрузка отменена');
        }
    }

    const res = await fetch(url, { signal });   // ← signal в fetch
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = parseInt(res.headers.get('content-length') ?? '0', 10);
    let received = 0;
    const reader = res.body!.getReader();

    try {
        if (writable) {
            while (true) {
                if (signal?.aborted) throw new Error('Загрузка отменена');
                const { done, value } = await reader.read();
                if (done) break;
                received += value.length;
                await writable.write(value);
                if (total) onProgress(received / total);
            }
            await writable.close();
        } else {
            const chunks: Uint8Array[] = [];
            while (true) {
                if (signal?.aborted) throw new Error('Загрузка отменена');
                const { done, value } = await reader.read();
                if (done) break;
                received += value.length;
                chunks.push(value);
                if (total) onProgress(received / total);
            }
            const blob = new Blob(chunks as BlobPart[], { type: mimeType });
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = suggestedName;
            document.body.appendChild(a);
            a.click();
            URL.revokeObjectURL(objectUrl);
            a.remove();
        }
        onProgress(1);
    } catch (e) {
        // При отмене — пытаемся прибрать частично записанный файл
        if (writable) {
            try { await writable.abort(); } catch {}
        }
        throw e;
    }
}