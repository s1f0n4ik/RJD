import { confState } from '../../state/conf-store';

// Проверка ключей камер. Ключ камеры — это place_key: под ним линкер хранит
// привязку камеры в своём state.json, а post_exports переносит по нему
// src_points, camera_id и calibration из прежней записи пресета.

const KEY_RE = /^[A-Za-z0-9_-]+$/;

export type KeyStatus = 'ok' | 'warn' | 'error';

export interface KeyProblem {
    text: string;
    // Ошибка теряет данные при сохранении, предупреждение — нет
    status: Exclude<KeyStatus, 'ok'>;
}

export interface KeyReport {
    problems: KeyProblem[];
    // Статус по id камеры, для подсветки поля в списке
    status: Map<string, KeyStatus>;
    // Есть хотя бы одна ошибка: сохранять нельзя
    blocked: boolean;
}

export function checkCameraKeys(): KeyReport {
    const problems: KeyProblem[] = [];
    const status = new Map<string, KeyStatus>();
    const byKey = new Map<string, string[]>();

    confState.cameras.forEach(cam => {
        status.set(cam.id, 'ok');
        const key = cam.key.trim();
        if (!key) return;
        byKey.set(key, [...(byKey.get(key) ?? []), cam.name]);
    });

    confState.cameras.forEach(cam => {
        if (cam.key.trim()) return;
        status.set(cam.id, 'error');
        problems.push({ text: `Камера «${cam.name}» — ключ не задан`, status: 'error' });
    });

    byKey.forEach((names, key) => {
        if (names.length < 2) return;
        confState.cameras.forEach(cam => {
            if (cam.key.trim() === key) status.set(cam.id, 'error');
        });
        problems.push({
            text: `Ключ ${key} занят сразу несколькими камерами: ${names.join(', ')}`,
            status: 'error',
        });
    });

    // Кириллица и пробелы уезжают в place_key и в state.json как есть. Записи с
    // такими ключами существуют, а переименование стоило бы им src_points,
    // поэтому это предупреждение, а не запрет.
    confState.cameras.forEach(cam => {
        const key = cam.key.trim();
        if (!key || KEY_RE.test(key)) return;
        if (status.get(cam.id) === 'ok') status.set(cam.id, 'warn');
        problems.push({
            text: `Камера «${cam.name}» — в ключе ${key} есть символы вне латиницы, цифр, _ и -`,
            status: 'warn',
        });
    });

    return {
        problems,
        status,
        blocked: problems.some(p => p.status === 'error'),
    };
}
