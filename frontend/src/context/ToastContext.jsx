import { createContext, useCallback, useContext, useMemo, useState } from 'react';

const ToastContext = createContext(null);
let nextId = 1;

export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);

    const remove = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

    const push = useCallback(
        (message, type = 'info') => {
            const id = nextId++;
            setToasts((t) => [...t, { id, message, type }]);
            setTimeout(() => remove(id), type === 'error' ? 7000 : 4000);
        },
        [remove]
    );

    const value = useMemo(
        () => ({
            success: (m) => push(m, 'success'),
            error: (m) => push(m, 'error'),
            info: (m) => push(m, 'info'),
        }),
        [push]
    );

    return (
        <ToastContext.Provider value={value}>
            {children}
            <div className="toast-stack" role="status" aria-live="polite">
                {toasts.map((t) => (
                    <div key={t.id} className={`toast toast--${t.type}`} onClick={() => remove(t.id)}>
                        {t.message}
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error('useToast debe usarse dentro de <ToastProvider>');
    return ctx;
}
