import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { collectionsApi, customersApi, paymentsApi, salesApi } from '../services/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Badge, Spinner, Stat, Stats } from '../components/ui.jsx';
import { ReceiptModal } from '../components/ReceiptModal.jsx';
import {
    ACCOUNT_STATUS_LABELS,
    BUCKET_BADGE,
    BUCKET_LABELS,
    formatDate,
    METHOD_LABELS,
    money,
    PAYMENT_MODE_LABELS,
} from '../utils/format.js';

export default function CustomerDetail() {
    const { id } = useParams();
    const { can } = useAuth();
    const [customer, setCustomer] = useState(null);
    const [sales, setSales] = useState([]);
    const [credits, setCredits] = useState(null);
    const [payments, setPayments] = useState(null);
    const [receiptFor, setReceiptFor] = useState(null);
    const [error, setError] = useState('');

    const verCartera = can('receivables.view', 'receivables.view.own');
    const verPagos = can('payments.view');

    useEffect(() => {
        Promise.all([customersApi.get(id), salesApi.list({ customerId: id, pageSize: 50 })])
            .then(([c, s]) => {
                setCustomer(c.data);
                setSales(s.data);
            })
            .catch((e) => setError(e.message));
    }, [id]);

    // Créditos vivos del cliente, con su atraso y su tramo de mora.
    useEffect(() => {
        if (!verCartera) return;
        collectionsApi
            .ofCustomer(id)
            .then((r) => setCredits(r.data))
            .catch(() => setCredits(null));
    }, [id, verCartera]);

    // Historial de pagos del cliente, con acceso a cada recibo.
    useEffect(() => {
        if (!verPagos) return;
        paymentsApi
            .list({ customerId: id, pageSize: 50 })
            .then((r) => setPayments(r.data ?? []))
            .catch(() => setPayments([]));
    }, [id, verPagos]);

    if (error) return <p className="alert alert--error">{error}</p>;
    if (!customer) return <Spinner />;

    const acc = customer.account ?? {};

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <Link to="/clientes" className="link link--back">
                        ← Clientes
                    </Link>
                    <h1>{customer.full_name}</h1>
                    <p className="page__sub">
                        DPI {customer.dpi} · {customer.phone}
                        {customer.phone_alt ? ` / ${customer.phone_alt}` : ''}
                    </p>
                </div>
                <Link to={`/ventas/nueva?cliente=${customer.id}`} className="btn btn--primary">
                    Nueva venta
                </Link>
            </div>

            <Stats>
                <Stat label="Total vendido" value={money(acc.total_sold)} meta={`${acc.sales_count ?? 0} venta(s)`} />
                <Stat label="Total pagado" value={money(acc.total_paid)} tone="ok" />
                <Stat
                    label="Saldo pendiente"
                    value={money(acc.total_balance)}
                    meta={
                        Number(acc.overdue_installments) > 0
                            ? `${acc.overdue_installments} cuota(s) vencida(s)`
                            : 'Sin cuotas vencidas'
                    }
                    tone={
                        Number(acc.overdue_installments) > 0
                            ? 'danger'
                            : Number(acc.total_balance) > 0
                              ? 'accent'
                              : 'ok'
                    }
                />
                <Stat
                    label="Próximo vencimiento"
                    value={acc.next_due_date ? formatDate(acc.next_due_date) : '—'}
                />
            </Stats>

            <section className="panel">
                <h2 className="panel__title">Datos de contacto</h2>
                <dl className="datalist">
                    <div>
                        <dt>Dirección</dt>
                        <dd>{customer.address}</dd>
                    </div>
                    <div>
                        <dt>Referencia</dt>
                        <dd>{customer.address_ref || '—'}</dd>
                    </div>
                    <div>
                        <dt>Correo</dt>
                        <dd>{customer.email || '—'}</dd>
                    </div>
                    <div>
                        <dt>Registrado</dt>
                        <dd>{formatDate(customer.created_at)}</dd>
                    </div>
                    <div>
                        <dt>Observaciones</dt>
                        <dd>{customer.notes || '—'}</dd>
                    </div>
                </dl>
            </section>

            {credits && (
                <section className="panel">
                    <h2 className="panel__title">Créditos del cliente</h2>
                    {credits.credits.length === 0 ? (
                        <p className="muted">Este cliente no tiene créditos con saldo.</p>
                    ) : (
                        <>
                            <p className="muted small">
                                {credits.totals.creditos} crédito(s) · saldo {money(credits.totals.saldo)} · vencido{' '}
                                {money(credits.totals.saldo_vencido)} · {credits.totals.cuotas_vencidas} cuota(s)
                                vencida(s)
                                {Number(credits.totals.dias_atraso_max) > 0
                                    ? ` · atraso máximo ${credits.totals.dias_atraso_max} días`
                                    : ''}
                            </p>
                            <div className="table-wrap">
                                <table className="table">
                                    <thead>
                                        <tr>
                                            <th>Crédito</th>
                                            <th>Fecha</th>
                                            <th className="right">Total</th>
                                            <th className="right">Saldo</th>
                                            <th className="center">Cuotas</th>
                                            <th>Próx. vence</th>
                                            <th className="center">Atraso</th>
                                            <th>Mora</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {credits.credits.map((s) => (
                                            <tr
                                                key={s.sale_id}
                                                className={Number(s.days_overdue) > 0 ? 'row--error' : ''}
                                            >
                                                <td>
                                                    <Link className="link mono" to={`/cartera/creditos/${s.sale_id}`}>
                                                        {s.sale_number}
                                                    </Link>
                                                </td>
                                                <td>{formatDate(s.sale_date)}</td>
                                                <td className="right">{money(s.total)}</td>
                                                <td className="right strong">{money(s.balance)}</td>
                                                <td className="center">
                                                    {s.installments_paid}/{s.installments_count}
                                                </td>
                                                <td>{s.next_due_date ? formatDate(s.next_due_date) : '—'}</td>
                                                <td className="center">
                                                    {Number(s.days_overdue) > 0 ? `${s.days_overdue} d` : '—'}
                                                </td>
                                                <td>
                                                    <Badge status={BUCKET_BADGE[s.overdue_bucket] ?? 'pendiente'}>
                                                        {BUCKET_LABELS[s.overdue_bucket] ?? s.overdue_bucket}
                                                    </Badge>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    )}
                </section>
            )}

            {verPagos && (
                <section className="panel">
                    <h2 className="panel__title">Historial de pagos</h2>
                    {payments === null ? (
                        <Spinner />
                    ) : payments.length === 0 ? (
                        <p className="muted">Este cliente todavía no tiene pagos registrados.</p>
                    ) : (
                        <div className="table-wrap">
                            <table className="table">
                                <thead>
                                    <tr>
                                        <th>Fecha</th>
                                        <th>Crédito</th>
                                        <th className="right">Monto</th>
                                        <th>Método</th>
                                        <th>Referencia</th>
                                        <th className="right">Recibo</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {payments.map((p) => (
                                        <tr key={p.id}>
                                            <td>{formatDate(p.payment_date)}</td>
                                            <td>
                                                <Link className="link mono" to={`/ventas/${p.sale_id}`}>
                                                    {p.sale_number}
                                                </Link>
                                            </td>
                                            <td className="right strong">{money(p.amount)}</td>
                                            <td>{METHOD_LABELS[p.method] ?? p.method}</td>
                                            <td className="muted">{p.reference || '—'}</td>
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
            )}

            {receiptFor && <ReceiptModal paymentId={receiptFor} onClose={() => setReceiptFor(null)} />}

            <section className="panel">
                <h2 className="panel__title">Historial de ventas</h2>
                {sales.length === 0 ? (
                    <p className="muted">Este cliente todavía no tiene ventas registradas.</p>
                ) : (
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>No.</th>
                                    <th>Fecha</th>
                                    <th>Modalidad</th>
                                    <th className="right">Total</th>
                                    <th className="right">Pagado</th>
                                    <th className="right">Saldo</th>
                                    <th>Estado</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sales.map((s) => (
                                    <tr key={s.id}>
                                        <td>
                                            <Link className="link mono" to={`/ventas/${s.id}`}>
                                                {s.sale_number}
                                            </Link>
                                        </td>
                                        <td>{formatDate(s.sale_date)}</td>
                                        <td>{PAYMENT_MODE_LABELS[s.payment_mode]}</td>
                                        <td className="right">{money(s.total)}</td>
                                        <td className="right">{money(s.paid_amount)}</td>
                                        <td className="right strong">{money(s.balance)}</td>
                                        <td>
                                            <Badge status={s.account_status}>
                                                {ACCOUNT_STATUS_LABELS[s.account_status]}
                                            </Badge>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    );
}
