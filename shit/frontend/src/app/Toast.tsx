import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// Уведомления оболочки: один тост на всё приложение
export type ToastType = 'ok' | 'err' | 'info';

interface ToastState {
    id: number;
    title: string;
    desc: string;
    type: ToastType;
    out: boolean;
}

type ShowToast = (title: string, desc?: string, type?: ToastType) => void;

const ToastContext = createContext<ShowToast>(() => {});

const TOAST_MS: Record<ToastType, number> = { ok: 4500, info: 6000, err: 9000 };
// Длительность ухода, как у анимации .toast.is-out
const OUT_MS = 150;
const DOT: Record<ToastType, string> = { ok: 'ok', err: 'err', info: 'acc' };

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toast, setToast] = useState<ToastState | null>(null);
    const timerRef = useRef<number | null>(null);
    const seqRef = useRef(0);

    const clear = () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
    };

    const dismiss = useCallback(() => {
        clear();
        setToast(t => t && { ...t, out: true });
        timerRef.current = window.setTimeout(() => setToast(null), OUT_MS);
    }, []);

    const show = useCallback<ShowToast>((title, desc = '', type = 'info') => {
        clear();
        seqRef.current += 1;
        setToast({ id: seqRef.current, title, desc, type, out: false });
        timerRef.current = window.setTimeout(dismiss, TOAST_MS[type]);
    }, [dismiss]);

    useEffect(() => clear, []);

    return (
        <ToastContext.Provider value={show}>
            {children}
            {toast && (
                <div key={toast.id} className={`toast${toast.out ? ' is-out' : ''}`} onClick={dismiss}>
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
