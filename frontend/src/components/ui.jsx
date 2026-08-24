import { useEffect, useRef } from 'react';

/** Campo de formulario con etiqueta, error inline y ayuda. */
export function Field({ label, error, hint, required, children, className = '' }) {
    return (
        <label className={`field ${error ? 'field--error' : ''} ${className}`}>
            <span className="field__label">
                {label}
                {required && <span className="field__req"> *</span>}
            </span>
            {children}
            {error && <span className="field__error">{error}</span>}
            {!error && hint && <span className="field__hint">{hint}</span>}
        </label>
    );
}

export function Modal({ open, title, onClose, children, wide = false }) {
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => e.key === 'Escape' && onClose();
        window.addEventListener('keydown', onKey);
        document.body.style.overflow = 'hidden';
        return () => {
            window.removeEventListener('keydown', onKey);
            document.body.style.overflow = '';
        };
    }, [open, onClose]);

    if (!open) return null;
    return (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className={`modal ${wide ? 'modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
                <header className="modal__head">
                    <h2>{title}</h2>
                    <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Cerrar">
                        ✕
                    </button>
                </header>
                <div className="modal__body">{children}</div>
            </div>
        </div>
    );
}

export function Badge({ status, children }) {
    return <span className={`badge badge--${status}`}>{children}</span>;
}

export function Spinner({ label = 'Cargando…' }) {
    return (
        <div className="spinner">
            <div className="spinner__dot" />
            <span>{label}</span>
        </div>
    );
}

export function EmptyState({ title, hint, action }) {
    return (
        <div className="empty">
            <p className="empty__title">{title}</p>
            {hint && <p className="empty__hint">{hint}</p>}
            {action}
        </div>
    );
}

export function Pagination({ pagination, onChange }) {
    if (!pagination || pagination.totalPages <= 1) return null;
    const { page, totalPages, total } = pagination;
    return (
        <div className="pagination">
            <span>
                {total} registro{total === 1 ? '' : 's'} · página {page} de {totalPages}
            </span>
            <div className="pagination__buttons">
                <button className="btn btn--ghost" disabled={page <= 1} onClick={() => onChange(page - 1)}>
                    ← Anterior
                </button>
                <button className="btn btn--ghost" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
                    Siguiente →
                </button>
            </div>
        </div>
    );
}

/** Buscador que toma el foco al montar: la operación diaria empieza buscando. */
export function SearchInput({ value, onChange, placeholder, autoFocus = true }) {
    const ref = useRef(null);
    useEffect(() => {
        if (autoFocus) ref.current?.focus();
    }, [autoFocus]);

    return (
        <div className="search">
            <input
                ref={ref}
                type="search"
                className="input"
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
            />
        </div>
    );
}
