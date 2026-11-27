// Режим сборки: true — логин требуется на все маршруты, включая / и /kiosk.
export const FULL_AUTH = import.meta.env.VITE_FULL_AUTH === 'true';

// Проверка exp без верификации подписи — гейт фронтовый, подпись проверять нечем.
export const isTokenExpired = (token: string | null): boolean => {
    if (!token) return true;
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (typeof payload.exp !== 'number') return true;
        return payload.exp * 1000 <= Date.now();
    } catch {
        return true;
    }
};

// Токен из localStorage, либо null если протух или повреждён.
export const readStoredToken = (): string | null => {
    const token = localStorage.getItem('token');
    return isTokenExpired(token) ? null : token;
};

export const clearStoredSession = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('role');
    localStorage.removeItem('username');
};

export interface AuthPolicy {
    entrance: 'lan' | 'remote';
    login_required: boolean;
}

// Вход, через который открыто приложение; до ответа /auth/policy и при его ошибке — ЛВС
let policy: AuthPolicy = { entrance: 'lan', login_required: false };
const POLICY_TIMEOUT_MS = 5_000;

export const authPolicy = (): AuthPolicy => policy;

export async function loadAuthPolicy(): Promise<AuthPolicy> {
    // Запрос политики прерывается по таймеру
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), POLICY_TIMEOUT_MS);
    try {
        const res = await fetch('/auth/policy', { signal: controller.signal });
        if (res.ok) {
            const body = await res.json();
            policy = { entrance: body?.entrance === 'remote' ? 'remote' : 'lan', login_required: body?.login_required === true };
        }
    } catch {
        // Бэкенд не ответил: остаётся вход ЛВС
    } finally {
        window.clearTimeout(timer);
    }
    return policy;
}

// Событие потери сессии: 401 на удалённом входе или при сохранённом токене
export const SESSION_LOST = 'rjd:session-lost';

export async function logout(): Promise<void> {
    try {
        await fetch('/auth/logout', { method: 'POST' });
    } catch {
        // Cookie сотрётся сама по сроку, токен убирается ниже
    }
    clearStoredSession();
}

// Ответы 401 и 403 всех запросов приложения, кроме самого входа
export function watchAuthResponses(onForbidden: () => void): void {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const response = await original(input, init);
        if (response.status !== 401 && response.status !== 403) return response;
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
        if (url.origin !== window.location.origin || url.pathname.startsWith('/auth/')) return response;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (response.status === 401 && (policy.entrance === 'remote' || localStorage.getItem('token'))) {
            window.dispatchEvent(new Event(SESSION_LOST));
        }
        if (response.status === 403 && method !== 'GET' && method !== 'HEAD') onForbidden();
        return response;
    };
}
