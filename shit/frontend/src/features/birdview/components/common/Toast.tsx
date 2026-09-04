import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/** Уведомления раздела 360 на общем .toast оболочки */

export type ToastType = 'ok' | 'err' | 'info';

interface ToastState {
    title: string;
    desc: string;
    type: ToastType;
}

type ShowToast = (title: string, desc: string, type?: ToastType) => void;

const ToastContext = createContext<ShowToast>(() => {});

const TOAST_MS: Record<ToastType, number> = { ok: 4500, info: 6000, err: 9000 };
const DOT: Record<ToastType, string> = { ok: 'ok', err: 'err', info: 'acc' };

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toast, setToast] = useState<ToastState | null>(null);
    const timerRef = useRef<number | null>(null);

    const show = useCallback<ShowToast>((title, desc, type = 'info') => {
        setToast({ title, desc, type });
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setToast(null), TOAST_MS[type]);
    }, []);

    useEffect(() => () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
    }, []);

    return (
        <ToastContext.Provider value={show}>
            {children}
            {toast && (
                <div className="toast" onClick={() => setToast(null)}>
                    <span className={`dot ${DOT[toast.type]}`} />
                    <div>
                        <b>{toast.title}</b>
                        {toast.desc && <div className="toast-desc">{toast.desc}</div>}
                    </div>
                </div>
            )}
        </ToastContext.Provider>
    );
}

export function useToast(): ShowToast {
    return useContext(ToastContext);
}
