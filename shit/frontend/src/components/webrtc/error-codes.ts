/**
 * Коды ошибок сигналинга и их описания.
 *
 * Код — четырёхзначное число, тип читается по первой цифре:
 *   1xxx — транспорт и сигналинг (брокер пар камера ↔ клиент)
 *   2xxx — сессия WebRTC (создание, offer/answer, ICE)
 *   3xxx — поток камеры (RTSP, GStreamer)
 *   4xxx — надстройки: коррекция 360, орбита, нейронка
 *   5xxx — конфигурация и данные (нет такого потока, нет назначения view)
 *
 * Описания живут здесь, а не на устройстве: устройство шлёт код и служебный
 * `description` для логов, интерфейс показывает человеческий текст. Пришёл
 * незнакомый код (устройство новее фронта) — показываем номер и служебный
 * текст, чтобы сведения не пропали.
 *
 * Пока media-center шлёт строковые коды в поле `error_code`; они сведены к тем
 * же номерам таблицей LEGACY_CODES и уедут вместе с ней, когда устройство
 * перейдёт на числа.
 */

export type ErrorKind = 'transport' | 'session' | 'stream' | 'module' | 'config' | 'unknown';

export interface ErrorInfo {
    /** null — код не пришёл, текст взят из служебного описания */
    code: number | null;
    kind: ErrorKind;
    text: string;
    /** Служебное описание от устройства: показывается мелким, если код незнаком */
    detail?: string;
}

const MESSAGES: Record<number, string> = {
    // 1xxx — транспорт и сигналинг
    1001: 'Камера не подключена к сигналингу',
    1002: 'Сигналинг не смог передать запрос камере',
    1003: 'Камера отключилась от сигналинга',
    1004: 'Сессию вытеснило новое подключение камеры',

    // 2xxx — сессия WebRTC
    2001: 'Сессия с этим клиентом уже открыта',
    2002: 'Сессии с этим клиентом нет',
    2003: 'Поток камеры ещё поднимается',
    2004: 'Ветка WebRTC на камере не поднялась',
    2005: 'Отказ при согласовании соединения',
    2006: 'Внутренняя ошибка сессии на камере',
    2007: 'Сессия закрыта перезапуском потока',
    2008: 'Камера закрыла сессию',

    // 3xxx — поток камеры
    3001: 'Камера не отвечает (таймаут RTSP)',
    3002: 'Поток не найден на камере',
    3003: 'Нет доступа к камере: неверный логин или пароль',
    3004: 'Соединение с камерой прервано',
    3005: 'Ошибка медиапотока',
    3006: 'Поток завершён камерой',

    // 4xxx — надстройки
    4001: 'Камера не сопоставлена с конфигурацией калибровки',
    4002: 'Пайплайн коррекции не собрался',
    4003: 'Коррекция готовится',
    4004: 'Вывод 360 не запущен',
    4005: 'Камера отклонила режим вращения',

    // 5xxx — конфигурация и данные
    5001: 'У камеры нет потока для просмотра',
    5002: 'Запрошенного потока у камеры нет',
    5003: 'У выбранного потока нет назначения «просмотр»',
    5004: 'Камера не поняла тип сообщения',
    5005: 'Сообщение не разобралось на камере',
};

// Строковые коды нынешних сборок media-center — те же ситуации, что 3xxx
const LEGACY_CODES: Record<string, number> = {
    'RTSP_TIMEOUT': 3001,
    'RTSP_NOT_FOUND': 3002,
    'RTSP_UNAUTHORIZED': 3003,
    'RTSP_DISCONNECTED': 3004,
    'GST_ERROR': 3005,
    'EOS': 3006,
};

// Коды ожидания: не отказ, а «ещё не готово». Интерфейс не должен пугать ими
const TRANSIENT_CODES = new Set([2003, 4003]);

export function isTransient(code: number | null): boolean {
    return code !== null && TRANSIENT_CODES.has(code);
}

export function kindOf(code: number | null): ErrorKind {
    if (code === null) return 'unknown';
    switch (Math.floor(code / 1000)) {
        case 1: return 'transport';
        case 2: return 'session';
        case 3: return 'stream';
        case 4: return 'module';
        case 5: return 'config';
        default: return 'unknown';
    }
}

/**
 * Разбирает сообщение устройства в то, что можно показать.
 * Понимает оба формата: числовой `code` и строковый `error_code`.
 */
export function describeError(raw: Record<string, unknown>): ErrorInfo {
    const code = resolveCode(raw);
    const detail = typeof raw.description === 'string' && raw.description ? raw.description : undefined;

    if (code !== null && MESSAGES[code]) {
        return { code, kind: kindOf(code), text: MESSAGES[code], detail };
    }

    if (code !== null) {
        return { code, kind: kindOf(code), text: `Ошибка ${code}`, detail };
    }

    return { code: null, kind: 'unknown', text: detail ?? 'Неизвестная ошибка' };
}

function resolveCode(raw: Record<string, unknown>): number | null {
    if (typeof raw.code === 'number' && Number.isFinite(raw.code)) return raw.code;
    // Число строкой встречается у прокси и у старых сборок
    if (typeof raw.code === 'string' && /^\d{4}$/.test(raw.code)) return Number(raw.code);
    if (typeof raw.error_code === 'string') return LEGACY_CODES[raw.error_code] ?? null;
    return null;
}
