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

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
            const res = await fetch('/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            if (!res.ok) throw new Error('Неверный логин или пароль');
            const data = await res.json();
            onLogin(data.access_token ?? data.token, data.role, username);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Не удалось войти');
        } finally {
            setBusy(false);
        }
    };

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

                {error && (
                    <div className="banner is-err" style={{ marginTop: 14 }}>
                        <Icon name="warn" size={15} />
                        {error}
                    </div>
                )}

                <p className="hint" style={{ marginTop: 14 }}>
                    Наблюдателю доступны просмотр, архив и журнал. Камеры, устройства и модули требуют прав
                    администратора.
                </p>
            </form>
        </div>
    );
}
