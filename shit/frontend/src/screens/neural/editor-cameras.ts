import { neuralApi } from '../../features/neural/api/client';

// Камеры для редактора видеопотока: поток нейронки и потоки просмотра

export interface EditorStream {
    key: string;
    width: number;
    height: number;
}

export interface EditorCamera {
    id: string;
    name: string;
    /** Поток с назначением neural — его кадр идёт в сборщик полотна */
    neural: EditorStream & { viewable: boolean };
    views: EditorStream[];
}

/** Что показывать в кадре камеры: same — пропорция совпадает с нейронкой, self — это сам поток нейронки */
export interface ViewChoice {
    stream: EditorStream;
    same: boolean;
    self: boolean;
}

export async function loadEditorCameras(): Promise<EditorCamera[]> {
    const res = await neuralApi.listCameras();
    const out: EditorCamera[] = [];
    for (const [id, cam] of Object.entries(res.cameras ?? {})) {
        const entries = Object.entries(cam.streams ?? {});
        const neural = entries.find(([, s]) => s.purposes?.includes('neural'));
        if (!neural) continue;
        const [nKey, n] = neural;
        out.push({
            id,
            name: cam.display_name || id,
            neural: { key: nKey, width: n.width ?? 0, height: n.height ?? 0, viewable: !!n.purposes?.includes('view') },
            views: entries
                .filter(([, s]) => s.purposes?.includes('view'))
                .map(([key, s]) => ({ key, width: s.width ?? 0, height: s.height ?? 0 })),
        });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

// Поток просмотра: сперва сам поток нейронки, затем просмотр той же пропорции ближайшего разрешения, иначе первый просмотр
export function viewFor(cam: EditorCamera): ViewChoice | null {
    const n = cam.neural;
    if (n.viewable) return { stream: n, same: true, self: true };
    if (!cam.views.length) return null;
    const ar = n.width && n.height ? n.width / n.height : 0;
    const same = cam.views
        .filter(v => ar && v.width && v.height && Math.abs(v.width / v.height - ar) < 0.01)
        .sort((a, b) => Math.abs(a.width - n.width) - Math.abs(b.width - n.width));
    if (same.length) return { stream: same[0], same: true, self: false };
    return { stream: cam.views[0], same: false, self: false };
}

export function ratio(w: number, h: number): string {
    if (!w || !h) return '?';
    const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
    const d = g(w, h);
    return `${w / d}:${h / d}`;
}
