import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { customersApi, productsApi, salesApi } from '../services/api.js';
import { useDebounce } from '../hooks/useDebounce.js';
import { useToast } from '../context/ToastContext.jsx';
import { Field } from '../components/ui.jsx';
import { usePaymentModes, unitPriceFor } from '../hooks/usePaymentModes.js';
import { formatDate, money, todayIso } from '../utils/format.js';

/** Descripción de la modalidad construida con las reglas que envía el backend. */
function modeHint(m) {
    const cuotas = m.installments === 1 ? '1 pago' : `${m.installments} cuotas mensuales`;
    return `Costo +${m.markup_percent}% · ${cuotas}`;
}

export default function NewSale() {
    const toast = useToast();
    const navigate = useNavigate();
    const [params] = useSearchParams();

    const { modes } = usePaymentModes();
    const [customer, setCustomer] = useState(null);
    const [mode, setMode] = useState('contado');
    const [saleDate, setSaleDate] = useState(todayIso());
    const [lines, setLines] = useState([]); // { product, quantity }
    const [notes, setNotes] = useState('');
    const [quote, setQuote] = useState(null);
    const [quoteError, setQuoteError] = useState('');
    const [saving, setSaving] = useState(false);

    // Cliente preseleccionado al llegar desde la ficha del cliente
    useEffect(() => {
        const id = params.get('cliente');
        if (!id) return;
        customersApi
            .get(id)
            .then((r) => setCustomer(r.data))
            .catch(() => {});
    }, [params]);

    const currentMode = modes.find((m) => m.key === mode) ?? null;

    const items = useMemo(
        () => lines.map((l) => ({ product_id: l.product.id, quantity: l.quantity })),
        [lines]
    );

    // Cálculo en vivo: el total lo confirma el backend, no el navegador.
    useEffect(() => {
        if (items.length === 0) {
            setQuote(null);
            setQuoteError('');
            return undefined;
        }
        let cancelled = false;
        salesApi
            .quote({ payment_mode: mode, sale_date: saleDate, items })
            .then((r) => {
                if (!cancelled) {
                    setQuote(r.data);
                    setQuoteError('');
                }
            })
            .catch((e) => {
                if (!cancelled) {
                    setQuote(null);
                    setQuoteError(e.fullMessage);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [items, mode, saleDate]);

    function addProduct(product) {
        setLines((prev) => {
            const existing = prev.find((l) => l.product.id === product.id);
            if (existing) {
                return prev.map((l) =>
                    l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l
                );
            }
            return [...prev, { product, quantity: 1 }];
        });
    }

    function setQuantity(productId, quantity) {
        setLines((prev) =>
            prev.map((l) => (l.product.id === productId ? { ...l, quantity: Math.max(1, quantity || 1) } : l))
        );
    }

    const removeLine = (productId) => setLines((prev) => prev.filter((l) => l.product.id !== productId));

    const stockProblem = lines.find((l) => l.quantity > l.product.stock);
    const canSave = customer && lines.length > 0 && !stockProblem && quote && !saving;

    async function save() {
        if (!canSave) return;
        setSaving(true);
        try {
            const res = await salesApi.create({
                customer_id: customer.id,
                payment_mode: mode,
                sale_date: saleDate,
                items,
                notes: notes || '',
            });
            toast.success(res.message);
            navigate(`/ventas/${res.data.id}`);
        } catch (err) {
            toast.error(err.fullMessage);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Nueva venta</h1>
                    <p className="page__sub">Selecciona el cliente, agrega productos y elige la modalidad de pago</p>
                </div>
            </div>

            <div className="sale-layout">
                <div className="sale-main">
                    <section className="panel">
                        <h2 className="panel__title">1. Cliente</h2>
                        {customer ? (
                            <div className="picked">
                                <div>
                                    <strong>{customer.full_name}</strong>
                                    <span className="muted">
                                        {' '}
                                        · DPI {customer.dpi} · {customer.phone}
                                    </span>
                                    <div className="muted small">{customer.address}</div>
                                </div>
                                <button className="btn btn--ghost btn--sm" onClick={() => setCustomer(null)}>
                                    Cambiar
                                </button>
                            </div>
                        ) : (
                            <CustomerPicker onPick={setCustomer} />
                        )}
                    </section>

                    <section className="panel">
                        <h2 className="panel__title">2. Productos</h2>
                        <ProductPicker onPick={addProduct} mode={currentMode} />

                        {lines.length > 0 && (
                            <div className="table-wrap sale-items">
                                <table className="table">
                                    <thead>
                                        <tr>
                                            <th>Producto</th>
                                            <th className="right">Precio unitario</th>
                                            <th className="center">Cantidad</th>
                                            <th className="right">Subtotal</th>
                                            <th />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {lines.map((l) => {
                                            const unit = unitPriceFor(l.product, currentMode);
                                            const insufficient = l.quantity > l.product.stock;
                                            return (
                                                <tr key={l.product.id} className={insufficient ? 'row--error' : ''}>
                                                    <td>
                                                        <span className="mono">{l.product.code}</span> {l.product.name}
                                                        <div className={`small ${insufficient ? 'text-danger' : 'muted'}`}>
                                                            Stock disponible: {l.product.stock}
                                                            {insufficient && ' — cantidad mayor al stock'}
                                                        </div>
                                                    </td>
                                                    <td className="right">{money(unit)}</td>
                                                    <td className="center">
                                                        <input
                                                            className="input input--qty"
                                                            type="number"
                                                            min="1"
                                                            max={l.product.stock}
                                                            value={l.quantity}
                                                            onChange={(e) =>
                                                                setQuantity(l.product.id, Number(e.target.value))
                                                            }
                                                        />
                                                    </td>
                                                    <td className="right strong">{money(unit * l.quantity)}</td>
                                                    <td className="right">
                                                        <button
                                                            className="btn btn--ghost btn--sm"
                                                            onClick={() => removeLine(l.product.id)}
                                                        >
                                                            Quitar
                                                        </button>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>

                    <section className="panel">
                        <h2 className="panel__title">3. Modalidad de pago</h2>
                        <div className="modes">
                            {modes.map((m) => (
                                <button
                                    key={m.key}
                                    type="button"
                                    className={`mode ${mode === m.key ? 'mode--active' : ''}`}
                                    onClick={() => setMode(m.key)}
                                >
                                    <strong>{m.label}</strong>
                                    <span>{modeHint(m)}</span>
                                </button>
                            ))}
                        </div>

                        <div className="form-grid">
                            <Field label="Fecha de la venta" className="span-1">
                                <input
                                    className="input"
                                    type="date"
                                    value={saleDate}
                                    onChange={(e) => setSaleDate(e.target.value)}
                                />
                            </Field>
                            <Field label="Observaciones" className="span-2">
                                <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
                            </Field>
                        </div>
                    </section>
                </div>

                <aside className="sale-side">
                    <div className="summary">
                        <h2 className="panel__title">Resumen</h2>

                        {quoteError && <p className="alert alert--error">{quoteError}</p>}

                        {!quote ? (
                            <p className="muted">Agrega productos para ver el cálculo.</p>
                        ) : (
                            <>
                                <div className="summary__row">
                                    <span>Subtotal</span>
                                    <strong>{money(quote.subtotal)}</strong>
                                </div>
                                <div className="summary__row summary__row--total">
                                    <span>Total</span>
                                    <strong>{money(quote.total)}</strong>
                                </div>
                                <div className="summary__row">
                                    <span>Modalidad</span>
                                    <strong>{quote.payment_mode_label}</strong>
                                </div>

                                <h3 className="summary__sub">
                                    {quote.installments_count === 1
                                        ? 'Pago único'
                                        : `${quote.installments_count} cuotas de ${money(quote.installments[0].amount)}`}
                                </h3>
                                <ul className="installments">
                                    {quote.installments.map((i) => (
                                        <li key={i.number}>
                                            <span>Cuota {i.number}</span>
                                            <span className="muted">{formatDate(i.due_date)}</span>
                                            <strong>{money(i.amount)}</strong>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}

                        {!customer && <p className="hint-block">Falta seleccionar el cliente.</p>}
                        {lines.length === 0 && <p className="hint-block">Falta agregar al menos un producto.</p>}
                        {stockProblem && (
                            <p className="alert alert--error">
                                «{stockProblem.product.name}» no tiene stock suficiente.
                            </p>
                        )}

                        <button className="btn btn--primary btn--block" disabled={!canSave} onClick={save}>
                            {saving ? 'Registrando…' : 'Registrar venta'}
                        </button>
                    </div>
                </aside>
            </div>
        </div>
    );
}

function CustomerPicker({ onPick }) {
    const [term, setTerm] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const debounced = useDebounce(term, 250);
    const inputRef = useRef(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        if (debounced.trim().length < 2) {
            setResults([]);
            return;
        }
        setLoading(true);
        customersApi
            .list({ search: debounced, status: 'active', pageSize: 8 })
            .then((r) => setResults(r.data))
            .catch(() => setResults([]))
            .finally(() => setLoading(false));
    }, [debounced]);

    return (
        <div className="picker">
            <input
                ref={inputRef}
                className="input"
                placeholder="Escribe nombre, DPI o teléfono del cliente…"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
            />
            {loading && <p className="muted small">Buscando…</p>}
            {results.length > 0 && (
                <ul className="picker__list">
                    {results.map((c) => (
                        <li key={c.id}>
                            <button type="button" onClick={() => onPick(c)}>
                                <strong>{c.full_name}</strong>
                                <span className="muted">
                                    DPI {c.dpi} · {c.phone}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {!loading && debounced.trim().length >= 2 && results.length === 0 && (
                <p className="muted small">Sin coincidencias. Registra al cliente desde el módulo Clientes.</p>
            )}
        </div>
    );
}

function ProductPicker({ onPick, mode }) {
    const [term, setTerm] = useState('');
    const [results, setResults] = useState([]);
    const debounced = useDebounce(term, 250);

    const search = useCallback(() => {
        if (debounced.trim().length < 2) {
            setResults([]);
            return;
        }
        productsApi
            .list({ search: debounced, status: 'active', pageSize: 8 })
            .then((r) => setResults(r.data))
            .catch(() => setResults([]));
    }, [debounced]);

    useEffect(() => {
        search();
    }, [search]);

    return (
        <div className="picker">
            <input
                className="input"
                placeholder="Escribe código o nombre del producto…"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
            />
            {results.length > 0 && (
                <ul className="picker__list">
                    {results.map((p) => (
                        <li key={p.id}>
                            <button
                                type="button"
                                disabled={p.stock <= 0}
                                onClick={() => {
                                    onPick(p);
                                    setTerm('');
                                    setResults([]);
                                }}
                            >
                                <strong>
                                    <span className="mono">{p.code}</span> {p.name}
                                </strong>
                                <span className="muted">
                                    {money(unitPriceFor(p, currentMode))} · stock {p.stock}
                                    {p.stock <= 0 ? ' (sin existencias)' : ''}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
