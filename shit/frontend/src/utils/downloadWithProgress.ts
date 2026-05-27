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
): Promise<void> {
    // Современный путь: spawn save-as диалог ДО начала скачивания
    // @ts-ignore — showSaveFilePicker не во всех типах
    const canPickFile = typeof window.showSaveFilePicker === 'function';

    let writable: FileSystemWritableFileStream | null = null;
    let fallbackChunks: Uint8Array[] | null = null;

    if (canPickFile) {
        try {
            // @ts-ignore
            const handle = await window.showSaveFilePicker({
                suggestedName,
                types: [{
                    description: mimeType,
                    accept: { [mimeType]: [extensionFor(suggestedName)] },
                }],
            });
            writable = await handle.createWritable();
        } catch (e: any) {
            if (e.name === 'AbortError') {
                // Пользователь отменил выбор файла
                throw new Error('Скачивание отменено');
            }
            // Если API упал по другой причине — fallback
            writable = null;
        }
    }

    if (!writable) {
        fallbackChunks = [];
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('No response body');

    const totalStr = res.headers.get('content-length');
    const total = totalStr ? parseInt(totalStr, 10) : 0;
    let received = 0;

    const reader = res.body.getReader();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            if (writable) {
                await writable.write(value);
            } else if (fallbackChunks) {
                fallbackChunks.push(value);
            }
            if (total > 0) onProgress(received / total);
        }

        if (writable) {
            await writable.close();
        } else if (fallbackChunks) {
            // Fallback: собираем Blob и скачиваем через <a download>
            const blob = new Blob(fallbackChunks as BlobPart[], { type: mimeType });
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = suggestedName;
            document.body.appendChild(a);
            a.click();
            URL.revokeObjectURL(objectUrl);
            document.body.removeChild(a);
        }

        onProgress(1);
    } catch (e) {
        if (writable) {
            try { await writable.abort(); } catch {}
        }
        throw e;
    }
}

function extensionFor(filename: string): string {
    const dot = filename.lastIndexOf('.');
    return dot >= 0 ? filename.substring(dot) : '.bin';
}