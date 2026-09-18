import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { BUCKET_LABELS, BUCKET_TONE, money } from '../utils/format.js';

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

/**
 * FRANJA DE INDICADORES.
 *
 * Una sola pieza dividida en celdas, no una fila de tarjetas flotantes: la
 * cifra importa, el contenedor no. `tone` tiñe solo el filo izquierdo y el
 * número, y se usa con criterio —`danger` únicamente cuando de verdad hay
 * algo que atender.
 */
export function Stats({ children }) {
    return <div className="stats">{children}</div>;
}

export function Stat({ label, value, meta, tone, to }) {
    const className = `stat ${tone ? `stat--${tone}` : ''}`;
    const body = (
        <>
            <span className="stat__label">{label}</span>
            <strong className="stat__value">{value}</strong>
            {meta && <span className="stat__meta">{meta}</span>}
        </>
    );
    if (!to) return <div className={className}>{body}</div>;
    return (
        <Link className={className} to={to}>
            {body}
        </Link>
    );
}

/**
 * DISTRIBUCIÓN DE MOROSIDAD.
 *
 * Una barra apilada más una leyenda con las cifras. Se lee la proporción de
 * un vistazo y el detalle sin cambiar de pantalla; cinco tarjetas sueltas no
 * dejan comparar nada.
 *
 * `buckets` es lo que devuelve el backend en `/collections/summary`. Aquí no
 * se calcula nada salvo el ancho relativo de cada segmento.
 */
export function AgingBar({ buckets = [], active = '', onPick }) {
    const total = buckets.reduce((acc, b) => acc + Number(b.creditos || 0), 0);

    return (
        <div className="aging">
            <div className="aging__bar" role="img" aria-label="Distribución de la cartera por tramo de mora">
                {total > 0 &&
                    buckets
                        .filter((b) => Number(b.creditos) > 0)
                        .map((b) => (
                            <span
                                key={b.bucket}
                                className={`aging__seg aging__seg--${BUCKET_TONE[b.bucket] ?? 'mora1'}`}
                                style={{ width: `${(Number(b.creditos) / total) * 100}%` }}
                                title={`${BUCKET_LABELS[b.bucket] ?? b.bucket}: ${b.creditos}`}
                            />
                        ))}
            </div>
            <div className="aging__legend">
                {buckets.map((b) => {
                    const tone = BUCKET_TONE[b.bucket] ?? 'mora1';
                    const content = (
                        <>
                            <span className={`aging__dot aging__seg--${tone}`} />
                            <span>
                                <span className="aging__name">{BUCKET_LABELS[b.bucket] ?? b.bucket}</span>
                                <span className="aging__num">{b.creditos}</span>
                                <span className="aging__amount">{money(b.saldo)}</span>
                            </span>
                        </>
                    );
                    if (!onPick) {
                        return (
                            <div key={b.bucket} className="aging__item">
                                {content}
                            </div>
                        );
                    }
                    return (
                        <button
                            key={b.bucket}
                            type="button"
                            className={`aging__item ${active === b.bucket ? 'aging__item--active' : ''}`}
                            onClick={() => onPick(active === b.bucket ? '' : b.bucket)}
                        >
                            {content}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
