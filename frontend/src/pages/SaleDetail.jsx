import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { paymentsApi, salesApi } from '../services/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Badge, Field, Modal, Spinner } from '../components/ui.jsx';
import {
    ACCOUNT_STATUS_LABELS,
    formatDate,
    formatDateTime,
    INSTALLMENT_STATUS_LABELS,
    METHOD_LABELS,
    money,
    PAYMENT_MODE_LABELS,
    todayIso,
} from '../utils/format.js';

export default function SaleDetail() {
    const { id } = useParams();
    const toast = useToast();
    const { user } = useAuth();
    const [sale, setSale] = useState(null);
    const [error, setError] = useState('');
    const [payOpen, setPayOpen] = useState(false);
    const [cancelOpen, setCancelOpen] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await salesApi.get(id);
            setSale(res.data);
        } catch (e) {
            setError(e.message);
        }
    }, [id]);

    useEffect(() => {
        load();
    }, [load]);

    if (error) return <p className="alert alert--error">{error}</p>;
    if (!sale) return <Spinner />;

    const hasBalance = Number(sale.balance) > 0 && sale.status === 'activa';

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <Link to="/ventas" className="link link--back">
                        ← Ventas
                    </Link>
                    <h1>
                        Venta {sale.sale_number} <Badge status={sale.account_status}>{ACCOUNT_STATUS_LABELS[sale.account_status]}</Badge>
                    </h1>
                    <p className="page__sub">
                        {formatDate(sale.sale_date)} · {PAYMENT_MODE_LABELS[sale.payment_mode]} ·{' '}
                        <Link className="link" to={`/clientes/${sale.customer_id}`}>
                            {sale.customer_name}
                        </Link>{' '}
                        (DPI {sale.customer_dpi})
                    </p>
                </div>
                <div className="row-actions">
                    {hasBalance && (
                        <button className="btn btn--primary" onClick={() => setPayOpen(true)}>
                            Registrar pago
                        </button>
                    )}
                    {user?.role === 'admin' && sale.status === 'activa' && Number(sale.paid_amount) === 0 && (
                        <button className="btn btn--ghost" onClick={() => setCancelOpen(true)}>
                            Anular venta
                        </button>
                    )}
                </div>
            </div>

            <div className="cards">
                <div className="card card--static">
                    <span className="card__label">Total</span>
                    <strong className="card__value">{money(sale.total)}</strong>
                </div>
                <div className="card card--static">
                    <span className="card__label">Pagado</span>
                    <strong className="card__value">{money(sale.paid_amount)}</strong>
                </div>
                <div className={`card card--static ${hasBalance ? 'card--alert' : ''}`}>
                    <span className="card__label">Saldo pendiente</span>
                    <strong className="card__value">{money(sale.balance)}</strong>
                </div>
                <div className="card card--static">
                    <span className="card__label">Cuotas</span>
                    <strong className="card__value">
                        {sale.installments_paid}/{sale.installments_count}
                    </strong>
                    <span className="card__extra">
                        {sale.next_due_date ? `Próxima: ${formatDate(sale.next_due_date)}` : 'Sin pendientes'}
                    </span>
                </div>
            </div>

            <section className="panel">
                <h2 className="panel__title">Productos</h2>
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Código</th>
                                <th>Producto</th>
                                <th className="center">Cantidad</th>
                                <th className="right">Precio unitario</th>
                                <th className="right">Subtotal</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sale.items.map((i) => (
                                <tr key={i.id}>
                                    <td className="mono">{i.product_code}</td>
                                    <td>{i.product_name}</td>
                                    <td className="center">{i.quantity}</td>
                                    <td className="right">{money(i.unit_price)}</td>
                                    <td className="right strong">{money(i.line_total)}</td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr>
                                <td colSpan={4} className="right">
                                    Total
                                </td>
                                <td className="right strong">{money(sale.total)}</td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            </section>

            <section className="panel">
                <h2 className="panel__title">Plan de pagos</h2>
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th className="center">Cuota</th>
                                <th>Vence</th>
                                <th className="right">Monto</th>
                                <th className="right">Pagado</th>
                                <th className="right">Saldo</th>
                                <th>Estado</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sale.installments.map((i) => (
                                <tr key={i.id}>
                                    <td className="center">{i.number}</td>
                                    <td>{formatDate(i.due_date)}</td>
                                    <td className="right">{money(i.amount)}</td>
                                    <td className="right">{money(i.paid_amount)}</td>
                                    <td className="right strong">{money(i.balance)}</td>
                                    <td>
                                        <Badge status={i.status}>{INSTALLMENT_STATUS_LABELS[i.status]}</Badge>
                                        {i.status === 'vencida' && (
                                            <span className="text-danger small"> · {i.days_overdue} día(s)</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="panel">
                <h2 className="panel__title">Historial de pagos</h2>
                {sale.payments.length === 0 ? (
                    <p className="muted">Todavía no hay pagos registrados para esta venta.</p>
                ) : (
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Fecha</th>
                                    <th className="right">Monto</th>
                                    <th>Método</th>
                                    <th>Referencia</th>
                                    <th>Aplicado a</th>
                                    <th>Registrado</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sale.payments.map((p) => (
                                    <tr key={p.id} className={p.status === 'anulado' ? 'row--muted' : ''}>
                                        <td>{formatDate(p.payment_date)}</td>
                                        <td className="right strong">{money(p.amount)}</td>
                                        <td>{METHOD_LABELS[p.method] ?? p.method}</td>
                                        <td className="muted">{p.reference || '—'}</td>
                                        <td className="small">
                                            {p.allocations.length === 0
                                                ? '—'
                                                : p.allocations
                                                      .map((a) => `Cuota ${a.installment_number}: ${money(a.amount)}`)
                                                      .join(' · ')}
                                        </td>
                                        <td className="muted small">
                                            {formatDateTime(p.created_at)}
                                            {p.created_by ? ` · ${p.created_by}` : ''}
                                            {p.status === 'anulado' && ' · ANULADO'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            {payOpen && (
                <PaymentModal
                    sale={sale}
                    onClose={() => setPayOpen(false)}
                    onSaved={() => {
                        setPayOpen(false);
                        load();
                    }}
                />
            )}
            {cancelOpen && (
                <CancelModal
                    sale={sale}
                    onClose={() => setCancelOpen(false)}
                    onSaved={() => {
                        setCancelOpen(false);
                        load();
                    }}
                />
            )}
        </div>
    );
}

export function PaymentModal({ sale, onClose, onSaved }) {
    const toast = useToast();
    const nextInstallment = sale.installments?.find((i) => Number(i.balance) > 0);
    const [amount, setAmount] = useState(nextInstallment ? Number(nextInstallment.balance).toFixed(2) : '');
    const [method, setMethod] = useState('efectivo');
    const [date, setDate] = useState(todayIso());
    const [reference, setReference] = useState('');
    const [notes, setNotes] = useState('');
    const [errors, setErrors] = useState({});
    const [busy, setBusy] = useState(false);

    const balance = Number(sale.balance);
    const value = Number(amount) || 0;
    const invalid = value <= 0 || value > balance;

    async function submit(e) {
        e.preventDefault();
        setBusy(true);
        setErrors({});
        try {
            const res = await paymentsApi.create({
                sale_id: sale.id,
                amount: value,
                payment_date: date,
                method,
                reference: reference || '',
                notes: notes || '',
            });
            toast.success(res.message);
            onSaved();
        } catch (err) {
            setErrors(err.fieldErrors);
            toast.error(err.fullMessage);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal open title={`Registrar pago — ${sale.sale_number}`} onClose={onClose}>
            <form onSubmit={submit}>
                <p className="muted">
                    Cliente: <strong>{sale.customer_name}</strong> · Saldo pendiente:{' '}
                    <strong>{money(balance)}</strong>
                </p>

                {nextInstallment && (
                    <p className="muted small">
                        Próxima cuota: n.º {nextInstallment.number}, vence {formatDate(nextInstallment.due_date)}, saldo{' '}
                        {money(nextInstallment.balance)}
                    </p>
                )}

                <Field label="Monto (Q)" required error={errors.amount}>
                    <input
                        className="input"
                        type="number"
                        step="0.01"
                        min="0.01"
                        max={balance}
                        autoFocus
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                    />
                </Field>

                <div className="quick-amounts">
                    {nextInstallment && (
                        <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => setAmount(Number(nextInstallment.balance).toFixed(2))}
                        >
                            Cuota completa ({money(nextInstallment.balance)})
                        </button>
                    )}
                    <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setAmount(balance.toFixed(2))}
                    >
                        Saldar todo ({money(balance)})
                    </button>
                </div>

                <Field label="Fecha del pago" required error={errors.payment_date}>
                    <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>

                <Field label="Método de pago" required>
                    <select className="input input--select" value={method} onChange={(e) => setMethod(e.target.value)}>
                        {Object.entries(METHOD_LABELS).map(([k, label]) => (
                            <option key={k} value={k}>
                                {label}
                            </option>
                        ))}
                    </select>
                </Field>

                <Field label="Referencia" error={errors.reference} hint="Número de boleta o transacción">
                    <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
                </Field>

                <Field label="Observaciones" error={errors.notes}>
                    <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>

                {value > balance && (
                    <p className="alert alert--error">El monto no puede superar el saldo pendiente.</p>
                )}

                <div className="form-actions">
                    <button type="button" className="btn btn--ghost" onClick={onClose}>
                        Cancelar
                    </button>
                    <button className="btn btn--primary" disabled={busy || invalid}>
                        {busy ? 'Registrando…' : 'Registrar pago'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

function CancelModal({ sale, onClose, onSaved }) {
    const toast = useToast();
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);

    async function submit(e) {
        e.preventDefault();
        setBusy(true);
        try {
            await salesApi.cancel(sale.id, reason);
            toast.success('Venta anulada y stock restituido');
            onSaved();
        } catch (err) {
            toast.error(err.fullMessage);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal open title={`Anular venta ${sale.sale_number}`} onClose={onClose}>
            <form onSubmit={submit}>
                <p className="alert alert--warn">
                    Se devolverá al inventario el stock de los productos de esta venta. La operación queda registrada.
                </p>
                <Field label="Motivo de la anulación" required>
                    <textarea
                        className="input"
                        rows={3}
                        autoFocus
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                    />
                </Field>
                <div className="form-actions">
                    <button type="button" className="btn btn--ghost" onClick={onClose}>
                        Cancelar
                    </button>
                    <button className="btn btn--danger" disabled={busy || reason.trim().length < 3}>
                        {busy ? 'Anulando…' : 'Anular venta'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
