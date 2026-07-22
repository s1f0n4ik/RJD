import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/** Уведомления birdview. Порт toast из utility.js на React. */

export type ToastType = 'ok' | 'err' | 'info';

interface ToastState {
    title: string;
    desc: string;
    type: ToastType;
    /** Меняется на каждый показ — перезапускает анимацию полосы прогресса. */
    seq: number;
}

type ShowToast = (title: string, desc: string, type?: ToastType) => void;

const ToastContext = createContext<ShowToast>(() => {});

const ICONS: Record<ToastType, string> = { ok: '✓', err: '✕', info: '◈' };
const TOAST_MS = 30_000;

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toast, setToast] = useState<ToastState | null>(null);
    const [visible, setVisible] = useState(false);
    const timerRef = useRef<number | null>(null);
    const seqRef = useRef(0);

    const show = useCallback<ShowToast>((title, desc, type = 'info') => {
        seqRef.current += 1;
        setToast({ title, desc, type, seq: seqRef.current });
        setVisible(true);

        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setVisible(false), TOAST_MS);
    }, []);

    useEffect(() => () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
    }, []);

    return (
        <ToastContext.Provider value={show}>
            {children}
            {toast && (
                <div
                    key={toast.seq}
                    className={`toast ${toast.type} ${visible ? 'visible' : ''}`}
                >
                    <span className="toast-icon">{ICONS[toast.type]}</span>
                    <div className="toast-body">
                        <div className="toast-title">{toast.title}</div>
                        <div className="toast-desc">{toast.desc}</div>
                    </div>
                    <button className="toast-close" onClick={() => setVisible(false)}>✕</button>
                    <div className="toast-progress running" />
                </div>
            )}
        </ToastContext.Provider>
    );
}

export function useToast(): ShowToast {
    return useContext(ToastContext);
}
