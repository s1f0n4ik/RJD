import { useState } from 'react';
import { Icon, IconSprite } from '../../app/Icons';
import './login.css';

interface LoginScreenProps {
    onLogin: (token: string, role: string, username: string) => void;
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const login = async (path: string, body: object | null, failText: string) => {
        setBusy(true);
        setError('');
        try {
            const res = await fetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined,
            });
            if (!res.ok) throw new Error(failText);
            const data = await res.json();
            onLogin(data.access_token ?? data.token, data.role, data.username ?? username);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Не удалось войти');
        } finally {
            setBusy(false);
        }
    };

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        void login('/auth/login', { username, password }, 'Неверный логин или пароль');
    };

    // Наблюдателю пароль знать не нужно: бэкенд выдаёт его токен по кнопке
    const loginAsViewer = () => void login('/auth/viewer', null, 'Вход наблюдателя недоступен');

    return (
        <div className="login-wrap">
            <IconSprite />
            <form className="login" onSubmit={submit}>
                <div className="mark">
                    <Icon name="eye" size={30} />
                    <div>
                        <b>Система видеоаналитики</b>
                        <span>ВНИИЖТ</span>
                    </div>
                </div>

                <label htmlFor="login-user">Пользователь</label>
                <input
                    id="login-user"
                    className="inp"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    autoFocus
                    autoComplete="username"
                />

                <label htmlFor="login-pass">Пароль</label>
                <input
                    id="login-pass"
                    className="inp"
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    autoComplete="current-password"
                />

                <button className="btn btn--acc btn--wide" type="submit" disabled={busy || !username || !password}>
                    {busy ? 'Проверяем…' : 'Войти'}
                </button>

                <button className="btn btn--acc-dim btn--wide" type="button" disabled={busy} onClick={loginAsViewer} style={{ marginTop: 8 }}>
                    <Icon name="eye" size={14} />Войти как наблюдатель
                </button>

                {error && (
                    <div className="banner is-err" style={{ marginTop: 14 }}>
                        <Icon name="warn" size={15} />
                        {error}
                    </div>
                )}
            </form>
        </div>
    );
}
