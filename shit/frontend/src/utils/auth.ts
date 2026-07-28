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
