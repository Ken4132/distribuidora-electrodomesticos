import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { collectionsApi, salesApi } from '../services/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Badge, EmptyState, Field, Modal, Spinner, Stat, Stats } from '../components/ui.jsx';
import { ReceiptModal } from '../components/ReceiptModal.jsx';
import { PaymentModal, puedeCobrar } from './SaleDetail.jsx';
import {
    ACCOUNT_STATUS_LABELS,
    BUCKET_BADGE,
    BUCKET_LABELS,
    formatDate,
    formatDateTime,
    INSTALLMENT_STATUS_LABELS,
    METHOD_LABELS,
    money,
    PAYMENT_MODE_LABELS,
    RESTRUCTURING_KIND_LABELS,
    todayIso,
} from '../utils/format.js';

/**
 * EXPEDIENTE DE UN CRÉDITO.
 *
 * Una sola llamada (`GET /collections/credits/:id`) trae crédito, cuotas
 * vivas, cuotas sustituidas, pagos, recibos y reestructuraciones. Nada se
 * recalcula aquí.
 */
export default function CreditDetail() {
    const { id } = useParams();
    const toast = useToast();
    const { user, can } = useAuth();
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [paying, setPaying] = useState(null);
    const [receiptFor, setReceiptFor] = useState(null);
    const [restructuring, setRestructuring] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await collectionsApi.credit(id);
            setData(res.data);
            setError('');
        } catch (e) {
            setError(e.message);
        }
    }, [id]);

    useEffect(() => {
        load();
    }, [load]);

    async function openPayment() {
        try {
            const res = await salesApi.get(data.credit.sale_id);
            setPaying(res.data);
        } catch (e) {
            toast.error(e.message);
        }
    }

    if (error) return <p className="alert alert--error">{error}</p>;
    if (!data) return <Spinner />;

    const c = data.credit;
    const conSaldo = Number(c.balance) > 0;
    const puedePagar = conSaldo && puedeCobrar({ ...c, id: c.sale_id }, user, can);

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <Link to="/cartera" className="link link--back">
                        ← Cartera
                    </Link>
                    <h1>
                        Crédito <span className="mono">{c.sale_number}</span>
                    </h1>
                    <p className="page__sub">
                        <Link className="link" to={`/clientes/${c.customer_id}`}>
                            {c.customer_name}
                        </Link>{' '}
                        · DPI {c.customer_dpi} · {c.customer_phone} ·{' '}
                        {PAYMENT_MODE_LABELS[c.payment_mode] ?? c.payment_mode} · {formatDate(c.sale_date)}
                        {c.branch_name ? ` · ${c.branch_name}` : ''}
                    </p>
                </div>
                <div className="page__actions">
                    {puedePagar && (
                        <button className="btn btn--primary" onClick={openPayment}>
                            Registrar pago
                        </button>
                    )}
                    {conSaldo && can('credits.restructure') && (
                        <button className="btn btn--ghost" onClick={() => setRestructuring(true)}>
                            Reestructurar
                        </button>
                    )}
                    <Link className="btn btn--ghost" to={`/ventas/${c.sale_id}`}>
                        Ver venta
                    </Link>
                </div>
            </div>

            <Stats>
                <Stat
                    label="Total del crédito"
                    value={money(c.total)}
                    meta={`${c.installments_paid}/${c.installments_count} cuotas pagadas`}
                />
                <Stat label="Pagado" value={money(c.paid_amount)} meta="Aplicado a cuotas" tone="ok" />
                <Stat
                    label="Saldo pendiente"
                    value={money(c.balance)}
                    meta={ACCOUNT_STATUS_LABELS[c.account_status]}
                    tone={conSaldo ? 'accent' : 'ok'}
                />
                <Stat
                    label="Atraso"
                    value={Number(c.days_overdue) > 0 ? `${c.days_overdue} días` : 'Al día'}
                    meta={
                        Number(c.overdue_balance) > 0
                            ? `${BUCKET_LABELS[c.overdue_bucket] ?? ''} · vencido ${money(c.overdue_balance)}`
                            : BUCKET_LABELS[c.overdue_bucket] ?? ''
                    }
                    tone={Number(c.days_overdue) > 90 ? 'danger' : Number(c.days_overdue) > 0 ? 'warn' : 'ok'}
                />
            </Stats>

            <section className="panel">
                <h2 className="panel__title">Cuotas</h2>
                {data.installments.length === 0 ? (
                    <p className="muted">Este crédito no tiene cuotas vivas.</p>
                ) : (
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th className="center">No.</th>
                                    <th>Vence</th>
                                    <th className="center">Atraso</th>
                                    <th className="right">Monto</th>
                                    <th className="right">Pagado</th>
                                    <th className="right">Saldo</th>
                                    <th>Estado</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.installments.map((i) => (
                                    <tr key={i.installment_id} className={i.status === 'vencida' ? 'row--error' : ''}>
                                        <td className="center mono">{i.installment_number}</td>
                                        <td>{formatDate(i.due_date)}</td>
                                        <td className="center">
                                            {Number(i.days_overdue) > 0 && Number(i.balance) > 0
                                                ? `${i.days_overdue} d`
                                                : '—'}
                                        </td>
                                        <td className="right">{money(i.amount)}</td>
                                        <td className="right">{money(i.paid_amount)}</td>
                                        <td className="right strong">{money(i.balance)}</td>
                                        <td>
                                            <Badge status={i.status}>
                                                {INSTALLMENT_STATUS_LABELS[i.status] ?? i.status}
                                            </Badge>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            {data.superseded_installments?.length > 0 && (
                <section className="panel">
                    <h2 className="panel__title">Cuotas sustituidas por una reestructuración</h2>
                    <p className="muted small">
                        No se borraron: conservan sus pagos y quedan como historial. Ya no son deuda viva.
                    </p>
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th className="center">No.</th>
                                    <th>Vencía</th>
                                    <th className="right">Monto</th>
                                    <th className="right">Pagado</th>
                                    <th className="right">Quedaba</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.superseded_installments.map((i) => (
                                    <tr key={i.installment_id} className="muted">
                                        <td className="center mono">{i.installment_number}</td>
                                        <td>{formatDate(i.due_date)}</td>
                                        <td className="right">{money(i.amount)}</td>
                                        <td className="right">{money(i.paid_amount)}</td>
                                        <td className="right">{money(i.balance)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            <section className="panel">
                <h2 className="panel__title">Historial de pagos</h2>
                {data.payments.length === 0 ? (
                    <EmptyState title="Todavía no hay pagos" hint="Los pagos registrados aparecerán aquí." />
                ) : (
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Fecha</th>
                                    <th className="right">Monto</th>
                                    <th>Método</th>
                                    <th>Referencia</th>
                                    <th>Cuotas</th>
                                    <th>Registró</th>
                                    <th>Estado</th>
                                    <th className="right">Recibo</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.payments.map((p) => (
                                    <tr key={p.id} className={p.status === 'anulado' ? 'muted' : ''}>
                                        <td>{formatDate(p.payment_date)}</td>
                                        <td className="right strong">{money(p.amount)}</td>
                                        <td>{METHOD_LABELS[p.method] ?? p.method}</td>
                                        <td className="muted">{p.reference || '—'}</td>
                                        <td className="mono small">
                                            {(p.allocations ?? [])
                                                .map((a) => `${a.installment_number}: ${money(a.amount)}`)
                                                .join(' · ') || '—'}
                                        </td>
                                        <td>{p.created_by || '—'}</td>
                                        <td>
                                            {p.status === 'anulado' ? (
                                                <Badge status="anulada">Anulado</Badge>
                                            ) : (
                                                <Badge status="pagada">Aplicado</Badge>
                                            )}
                                        </td>
                                        <td className="right">
                                            <button
                                                className="btn btn--sm btn--ghost"
                                                onClick={() => setReceiptFor(p.id)}
                                            >
                                                Ver recibo
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            {data.receipts?.length > 0 && (
                <section className="panel">
                    <h2 className="panel__title">Recibos emitidos</h2>
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Recibo</th>
                                    <th>Emitido</th>
                                    <th className="right">Monto</th>
                                    <th className="right">Saldo anterior</th>
                                    <th className="right">Saldo nuevo</th>
                                    <th>Estado del pago</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.receipts.map((r) => (
                                    <tr key={r.id}>
                                        <td>
                                            <button
                                                className="link mono"
                                                onClick={() => setReceiptFor(r.payment_id)}
                                            >
                                                {r.receipt_number}
                                            </button>
                                        </td>
                                        <td>{formatDateTime(r.issued_at)}</td>
                                        <td className="right">{money(r.amount)}</td>
                                        <td className="right">{money(r.balance_before)}</td>
                                        <td className="right">{money(r.balance_after)}</td>
                                        <td>
                                            <Badge status={r.payment_status === 'anulado' ? 'anulada' : 'pagada'}>
                                                {r.payment_status === 'anulado' ? 'Anulado' : 'Aplicado'}
                                            </Badge>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            {data.restructurings?.length > 0 && (
                <section className="panel">
                    <h2 className="panel__title">Reestructuraciones</h2>
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Fecha</th>
                                    <th>Tipo</th>
                                    <th className="right">Total anterior</th>
                                    <th className="right">Pagado</th>
                                    <th className="right">Total nuevo</th>
                                    <th className="right">Saldo nuevo</th>
                                    <th className="center">Cuotas</th>
                                    <th>Autorizó</th>
                                    <th>Motivo</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.restructurings.map((r) => (
                                    <tr key={r.id}>
                                        <td>{formatDateTime(r.approved_at)}</td>
                                        <td>{RESTRUCTURING_KIND_LABELS[r.kind] ?? r.kind}</td>
                                        <td className="right">{money(r.previous_total)}</td>
                                        <td className="right">{money(r.previous_paid)}</td>
                                        <td className="right">{money(r.new_total)}</td>
                                        <td className="right strong">{money(r.new_balance)}</td>
                                        <td className="center">{r.new_installments}</td>
                                        <td>{r.approved_by_username || '—'}</td>
                                        <td className="muted small">{r.reason}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            {paying && (
                <PaymentModal
                    sale={paying}
                    onClose={() => setPaying(null)}
                    onSaved={() => {
                        setPaying(null);
                        load();
                    }}
                />
            )}
            {receiptFor && <ReceiptModal paymentId={receiptFor} onClose={() => setReceiptFor(null)} />}
            {restructuring && (
                <RestructureModal
                    credit={c}
                    onClose={() => setRestructuring(false)}
                    onSaved={() => {
                        setRestructuring(false);
                        load();
                    }}
                />
            )}
        </div>
    );
}

/**
 * REESTRUCTURACIÓN / REGULARIZACIÓN.
 *
 * El frontend no decide cuál de las dos corresponde ni valida los plazos: eso
 * lo resuelve el backend y devuelve el error explicado si no procede.
 */
function RestructureModal({ credit, onClose, onSaved }) {
    const toast = useToast();
    const [newTotal, setNewTotal] = useState(Number(credit.total).toFixed(2));
    const [installments, setInstallments] = useState(6);
    const [firstDue, setFirstDue] = useState(todayIso());
    const [reason, setReason] = useState('');
    const [errors, setErrors] = useState({});
    const [busy, setBusy] = useState(false);

    const pagado = Number(credit.paid_amount);
    const nuevoSaldo = Number(newTotal) - pagado;

    async function submit(e) {
        e.preventDefault();
        setBusy(true);
        setErrors({});
        try {
            const res = await collectionsApi.restructure(credit.sale_id, {
                new_total: Number(newTotal),
                new_installments: Number(installments),
                first_due_date: firstDue,
                reason,
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
        <Modal open title={`Reestructurar ${credit.sale_number}`} onClose={onClose}>
            <form onSubmit={submit}>
                <p className="alert alert--warn">
                    No se crea una deuda nueva: es el mismo crédito con otras condiciones. Los pagos anteriores se
                    conservan y las cuotas actuales quedan como historial.
                </p>
                <p className="muted">
                    Total actual <strong>{money(credit.total)}</strong> · Pagado <strong>{money(pagado)}</strong> ·
                    Saldo <strong>{money(credit.balance)}</strong>
                </p>

                <Field label="Nuevo total del crédito (Q)" required error={errors.new_total}>
                    <input
                        className="input"
                        type="number"
                        step="0.01"
                        min="0"
                        autoFocus
                        value={newTotal}
                        onChange={(e) => setNewTotal(e.target.value)}
                    />
                </Field>

                <p className={`muted ${nuevoSaldo <= 0 ? 'text-danger' : ''}`}>
                    Nuevo saldo = nuevo total − pagado = <strong>{money(Math.max(nuevoSaldo, 0))}</strong>
                </p>

                <Field label="Cuotas mensuales" required error={errors.new_installments}>
                    <input
                        className="input"
                        type="number"
                        min="1"
                        max="120"
                        value={installments}
                        onChange={(e) => setInstallments(e.target.value)}
                    />
                </Field>

                <Field label="Primera cuota vence" required error={errors.first_due_date}>
                    <input className="input" type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
                </Field>

                <Field label="Motivo" required error={errors.reason} hint="Queda en la bitácora y en el historial">
                    <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>

                <div className="form-actions">
                    <button type="button" className="btn btn--ghost" onClick={onClose}>
                        Cancelar
                    </button>
                    <button className="btn btn--primary" disabled={busy || reason.trim().length < 10 || nuevoSaldo <= 0}>
                        {busy ? 'Aplicando…' : 'Reestructurar'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
