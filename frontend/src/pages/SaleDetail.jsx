import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { paymentsApi, salesApi } from '../services/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Badge, Field, Modal, Spinner } from '../components/ui.jsx';
import { AllocationsTable, ReceiptModal } from '../components/ReceiptModal.jsx';
import {
    ACCOUNT_STATUS_LABELS,
    formatDate,
    formatDateTime,
    INSTALLMENT_STATUS_LABELS,
    METHOD_LABELS,
    money,
    PAYMENT_MODE_LABELS,
    METHODS_REQUIRING_REFERENCE,
    newRequestKey,
    todayIso,
} from '../utils/format.js';

/**
 * ¿Este usuario puede cobrar ESTA venta? (regla U6)
 *
 * Con `payments.create` puede cobrar cualquiera. Con `payments.create.own`
 * solo los créditos que él mismo registró. Ocultar el botón es comodidad:
 * el servidor vuelve a comprobarlo dentro de la transacción.
 */
export function puedeCobrar(sale, user, can) {
    if (can('payments.create')) return true;
    if (!can('payments.create.own')) return false;
    const esSuya = sale?.created_by != null && Number(sale.created_by) === Number(user?.id);
    const esCredito = ['credito_4', 'credito_8', 'credito'].includes(sale?.payment_mode);
    return esSuya && esCredito;
}

export default function SaleDetail() {
    const { id } = useParams();
    const toast = useToast();
    const { user, can } = useAuth();
    const [sale, setSale] = useState(null);
    const [error, setError] = useState('');
    const [payOpen, setPayOpen] = useState(false);
    const [cancelOpen, setCancelOpen] = useState(false);
    const [voiding, setVoiding] = useState(null);
    const [receiptFor, setReceiptFor] = useState(null);

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
                    {hasBalance && puedeCobrar(sale, user, can) && (
                        <button className="btn btn--primary" onClick={() => setPayOpen(true)}>
                            Registrar pago
                        </button>
                    )}
                    {can('sales.cancel') && sale.status === 'activa' && (
                        <button className="btn btn--ghost" onClick={() => setCancelOpen(true)}>
                            Anular venta
                        </button>
                    )}
                </div>
            </div>

            {sale.cancellation && (
                <div className="alert alert--error">
                    <strong>Venta anulada</strong> el {formatDateTime(sale.cancellation.cancelled_at)} por{' '}
                    {sale.cancellation.cancelled_by_username ?? '—'}. Motivo: {sale.cancellation.reason}
                    <div className="small">
                        {Number(sale.cancellation.payments_voided_count) > 0
                            ? `Pagos revertidos: ${sale.cancellation.payments_voided_count} por ${money(sale.cancellation.payments_voided_amount)}.`
                            : 'No tenía pagos aplicados.'}
                        {Number(sale.cancellation.down_payment_reverted) > 0
                            ? ` Enganche revertido: ${money(sale.cancellation.down_payment_reverted)}.`
                            : ''}{' '}
                        Stock restituido:{' '}
                        {(sale.cancellation.stock_restored ?? []).reduce((a, r) => a + Number(r.quantity ?? 0), 0)} unidad(es).
                        Nada se borró: cuotas, pagos y líneas se conservan en el historial.
                    </div>
                </div>
            )}

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
                                    <th />
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
                                            {p.status === 'anulado' && ` · ANULADO${p.void_reason ? `: ${p.void_reason}` : ''}`}
                                        </td>
                                        <td className="right">
                                            <button
                                                className="btn btn--ghost btn--sm"
                                                onClick={() => setReceiptFor(p.id)}
                                            >
                                                Recibo
                                            </button>
                                            {can('payments.void') && p.status === 'aplicado' && (
                                                <button className="btn btn--ghost btn--sm" onClick={() => setVoiding(p)}>
                                                    Anular
                                                </button>
                                            )}
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
            {receiptFor && <ReceiptModal paymentId={receiptFor} onClose={() => setReceiptFor(null)} />}
            {voiding && (
                <VoidPaymentModal
                    payment={voiding}
                    onClose={() => setVoiding(null)}
                    onSaved={() => {
                        setVoiding(null);
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
    // Métodos OPERATIVOS: los trae el backend. No se arman aquí, porque la
    // lista cambió en el bloque 4.1 y `cheque`/`otro` ya no se admiten.
    const [methods, setMethods] = useState(['efectivo']);
    // Resultado del cobro: saldo anterior/nuevo y reparto FIFO tal como los
    // devolvió el servidor.
    const [result, setResult] = useState(null);
    const [receiptFor, setReceiptFor] = useState(null);
    // Una clave por intento: si el usuario da doble clic o reintenta, el
    // backend devuelve el pago que ya registró en lugar de cobrar otra vez.
    const [requestKey, setRequestKey] = useState(newRequestKey);

    useEffect(() => {
        paymentsApi
            .methods()
            .then((r) => {
                const list = r.data ?? [];
                if (list.length) {
                    setMethods(list);
                    setMethod((m) => (list.includes(m) ? m : list[0]));
                }
            })
            .catch(() => {
                /* si falla, se queda el efectivo, que siempre existe */
            });
    }, []);

    const balance = Number(sale.balance);
    const value = Number(amount) || 0;
    const referenceRequired = METHODS_REQUIRING_REFERENCE.includes(method);
    const missingReference = referenceRequired && !reference.trim();
    const invalid = value <= 0 || value > balance || missingReference;

    async function submit(e) {
        e.preventDefault();
        setBusy(true);
        setErrors({});
        try {
            const res = await paymentsApi.create(
                {
                    sale_id: sale.id,
                    amount: value,
                    payment_date: date,
                    method,
                    reference: reference || '',
                    notes: notes || '',
                },
                requestKey
            );
            toast.success(res.message);
            setResult(res.data);
        } catch (err) {
            // Una clave usada con datos distintos ya no sirve: se renueva para
            // que el siguiente intento no choque con el anterior.
            setRequestKey(newRequestKey());
            setErrors(err.fieldErrors);
            toast.error(err.fullMessage);
        } finally {
            setBusy(false);
        }
    }

    function finish() {
        setResult(null);
        onSaved();
    }

    // ------------------------------------------------ CONFIRMACIÓN DEL COBRO
    if (result) {
        const pago = result.payment ?? {};
        const ultimo = result.payments?.at(-1);
        return (
            <>
                <Modal open title={`Pago registrado — ${result.sale?.sale_number ?? sale.sale_number}`} onClose={finish} wide>
                    <p className="muted">
                        Cliente: <strong>{result.sale?.customer_name ?? sale.customer_name}</strong>
                        {pago.receipt_number ? (
                            <>
                                {' '}· Recibo <strong className="mono">{pago.receipt_number}</strong>
                            </>
                        ) : null}
                    </p>

                    <div className="figures">
                        <div className="figure">
                            <span className="figure__label">Saldo anterior</span>
                            <span className="figure__value">{money(pago.balance_before)}</span>
                        </div>
                        <span className="figures__op" aria-hidden="true">
                            −
                        </span>
                        <div className="figure figure--main">
                            <span className="figure__label">Pagado</span>
                            <span className="figure__value">{money(pago.amount)}</span>
                        </div>
                        <span className="figures__op" aria-hidden="true">
                            =
                        </span>
                        <div className="figure figure--result">
                            <span className="figure__label">Saldo nuevo</span>
                            <span className="figure__value">{money(result.sale?.balance ?? pago.balance_after)}</span>
                        </div>
                    </div>

                    <h3 className="panel__title">Cuotas afectadas</h3>
                    <p className="muted small">
                        El reparto lo decidió el servidor: la cuota más antigua primero, sin saltar ninguna.
                    </p>
                    <AllocationsTable allocations={ultimo?.allocations ?? []} />

                    <div className="form-actions">
                        {pago.id && (
                            <button type="button" className="btn btn--ghost" onClick={() => setReceiptFor(pago.id)}>
                                Ver recibo
                            </button>
                        )}
                        <button type="button" className="btn btn--primary" onClick={finish}>
                            Listo
                        </button>
                    </div>
                </Modal>
                {receiptFor && <ReceiptModal paymentId={receiptFor} onClose={() => setReceiptFor(null)} />}
            </>
        );
    }

    // ------------------------------------------------------------ FORMULARIO
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

                <Field label="Método de pago" required error={errors.method}>
                    <select className="input input--select" value={method} onChange={(e) => setMethod(e.target.value)}>
                        {methods.map((k) => (
                            <option key={k} value={k}>
                                {METHOD_LABELS[k] ?? k}
                            </option>
                        ))}
                    </select>
                </Field>

                <Field
                    label={`Referencia${referenceRequired ? '' : ' (opcional)'}`}
                    required={referenceRequired}
                    error={errors.reference}
                    hint={
                        referenceRequired
                            ? 'Obligatoria con este método: número de boleta o transacción'
                            : 'Número de boleta o transacción'
                    }
                >
                    <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
                </Field>

                <Field label="Observaciones" error={errors.notes}>
                    <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>

                {value > balance && (
                    <p className="alert alert--error">El monto no puede superar el saldo pendiente.</p>
                )}
                {missingReference && (
                    <p className="alert alert--warn">
                        Un pago por {METHOD_LABELS[method] ?? method} necesita el correlativo o número de comprobante.
                    </p>
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

function VoidPaymentModal({ payment, onClose, onSaved }) {
    const toast = useToast();
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);

    async function submit(e) {
        e.preventDefault();
        setBusy(true);
        try {
            await paymentsApi.void(payment.id, reason);
            toast.success('Pago anulado');
            onSaved();
        } catch (err) {
            toast.error(err.fullMessage);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal open title={`Anular pago de ${money(payment.amount)}`} onClose={onClose}>
            <form onSubmit={submit}>
                <p className="alert alert--warn">
                    El pago queda registrado como ANULADO (no se borra) y deja de contar para las cuotas y el saldo.
                </p>
                <Field label="Motivo de la anulación" required>
                    <textarea className="input" rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <div className="form-actions">
                    <button type="button" className="btn btn--ghost" onClick={onClose}>
                        Cancelar
                    </button>
                    <button className="btn btn--danger" disabled={busy || reason.trim().length < 3}>
                        {busy ? 'Anulando…' : 'Anular pago'}
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
                    El stock vuelve a la sucursal de la que salió cada producto. Nada se borra: la venta queda anulada y
                    conserva sus cuotas, pagos y líneas. Si la venta tiene pagos aplicados, hay que anularlos antes
                    (Administración). Si viene de una solicitud de crédito, la solicitud pasará a <strong>Venta
                    anulada</strong>.
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
