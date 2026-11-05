import type { RuntimeItem, RuntimeProblem, RuntimeSnapshot } from './library-api';

export type Tone = '' | 'ok' | 'warn' | 'err';

export const ITEM_KINDS: Record<string, string> = { camera: 'Камера', slot: 'Слот техзрения', surround: 'Система 360', device: 'Устройство' };

// Причина по коду мастера; для ошибки слота берётся текст платы
export function reasonText(item: { kind: string; code: string | null; detail: string }): string {
    switch (item.code) {
        case 'offline':
            return 'Устройство не в сети';
        case 'unreachable':
            return 'Устройство не отвечает';
        case 'held':
            return 'Модули удерживаются после загрузки';
        case 'revision':
            return 'Плата применяет конфигурацию';
        case 'missing':
            return 'Нет на плате';
        case 'unreadable':
            return 'Не удалось прочитать состояние';
        case 'slot_error':
            return item.detail || 'Ошибка слота';
        case 'not_running':
            return item.kind === 'surround' ? 'Выход 360 не запущен' : item.kind === 'slot' ? 'Слот не запущен' : 'Поток не запущен';
        default:
            return item.detail;
    }
}

export const problemTitle = (problem: Pick<RuntimeProblem | RuntimeItem, 'kind' | 'id' | 'stream'>, nameOf: (kind: string, id: string) => string) =>
    `${nameOf(problem.kind, problem.id)}${problem.stream ? ` · ${problem.stream.replace('stream_', 'поток ')}` : ''}`;

// Вердикт мастера для карточки «Применение»: тон, заголовок, пояснение
export function runtimeHealth(
    snapshot: RuntimeSnapshot | null,
    nameOf: (kind: string, id: string) => string,
): [Tone, string, string] {
    if (!snapshot) return ['', 'Проверка применения', 'Состояние запуска ещё не получено'];
    const { state, problems } = snapshot.summary;
    const lead = (limit: number) => {
        const shown = problems.slice(0, limit).map((item) => `${problemTitle(item, nameOf)}: ${reasonText(item)}`);
        return shown.join('; ') + (problems.length > limit ? ` и ещё ${problems.length - limit}` : '');
    };
    switch (state) {
        case 'ok':
            return ['ok', 'Применён', 'Камеры, слоты и 360 запущены'];
        case 'starting':
            return ['warn', 'Запускается', lead(2)];
        case 'issues':
            return ['warn', 'Модули запущены не все', lead(2)];
        case 'unknown':
            return ['warn', 'Нет состояния модулей', lead(1)];
        case 'empty':
            return ['', 'Нет устройств', 'У профиля нет привязанных устройств'];
        default:
            return ['', 'Идёт загрузка профиля', 'Рабочие модули остановлены на время загрузки'];
    }
}
