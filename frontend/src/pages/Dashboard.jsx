import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collectionsApi, dashboardApi, paymentsApi } from '../services/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { BUCKET_BADGE, BUCKET_LABELS, formatDate, METHOD_LABELS, money } from '../utils/format.js';
import { Badge, Spinner } from '../components/ui.jsx';

/**
 * RESUMEN OPERATIVO.
 *
 * Cada bloque se pide solo si el usuario tiene el permiso que lo protege, para
 * no llenar la pantalla de errores 403. Todas las cifras vienen del backend.
 */
export default function Dashboard() {
    const { can } = useAuth();
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [collections, setCollections] = useState(null);
    const [payments, setPayments] = useState(null);

    const verCartera = can('receivables.view', 'receivables.view.own');
    const verPagos = can('payments.view');

    useEffect(() => {
        dashboardApi
            .get()
            .then((r) => setData(r.data))
            .catch((e) => setError(e.message));
    }, []);

    useEffect(() => {
        if (!verCartera) return;
        collectionsApi
            .summary()
            .then((r) => setCollections(r.data))
            .catch(() => setCollections(null));
    }, [verCartera]);

    useEffect(() => {
        if (!verPagos) return;
        paymentsApi
            .list({ page: 1, pageSize: 8 })
            .then((r) => setPayments(r.data ?? []))
            .catch(() => setPayments([]));
    }, [verPagos]);

    if (error) return <p className="alert alert--error">{error}</p>;
    if (!data) return <Spinner />;

    const t = collections?.totales ?? {};
    const vencidos = (collections?.buckets ?? []).filter((b) => b.bucket !== 'AL_DIA');
    const creditosVencidos = vencidos.reduce((a, b) => a + Number(b.creditos), 0);

    const cards = [
        {
            label: 'Clientes activos',
            value: data.customers.active,
            extra: `${data.customers.total} en total`,
            to: '/clientes',
        },
        {
            label: 'Créditos con saldo',
            value: collections ? t.creditos : '—',
            extra: collections ? `${creditosVencidos} con atraso` : 'Sin acceso a cartera',
            to: '/cartera',
            alert: creditosVencidos > 0,
        },
        {
            label: 'Saldo de cartera',
            value: collections ? money(t.saldo) : money(data.receivables.total_balance),
            extra: 'Total por cobrar',
            to: '/cartera',
        },
        {
            label: 'Monto vencido',
            value: collections ? money(t.saldo_vencido) : '—',
            extra: `${data.receivables.overdue_sales} crédito(s) vencido(s)`,
            to: '/cartera',
            alert: Number(t.saldo_vencido) > 0 || data.receivables.overdue_sales > 0,
        },
        {
            label: 'Ventas de hoy',
            value: data.sales.today_count,
            extra: money(data.sales.today_amount),
            to: '/ventas',
        },
        {
            label: 'Productos',
            value: data.products.active,
            extra: `${data.products.low_stock} con stock bajo`,
            to: '/productos',
            alert: data.products.low_stock > 0,
        },
    ];

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Resumen operativo</h1>
                    <p className="page__sub">{formatDate(data.today)}</p>
                </div>
                {can('sales.create') && (
                    <Link to="/ventas/nueva" className="btn btn--primary">
                        Registrar venta
                    </Link>
                )}
            </div>

            <div className="cards">
                {cards.map((c) => (
                    <Link key={c.label} to={c.to} className={`card ${c.alert ? 'card--alert' : ''}`}>
                        <span className="card__label">{c.label}</span>
                        <strong className="card__value">{c.value}</strong>
                        <span className="card__extra">{c.extra}</span>
                    </Link>
                ))}
            </div>

            {collections && (
                <section className="panel">
                    <h2 className="panel__title">Morosidad por tramo</h2>
                    <div className="cards">
                        {(collections.buckets ?? []).map((b) => (
                            <Link
                                key={b.bucket}
                                to={`/cartera?tramo=${b.bucket}`}
                                className={`card ${b.bucket !== 'AL_DIA' && Number(b.creditos) > 0 ? 'card--alert' : ''}`}
                            >
                                <span className="card__label">{BUCKET_LABELS[b.bucket] ?? b.bucket}</span>
                                <strong className="card__value">{b.creditos}</strong>
                                <span className="card__extra">
                                    {money(b.saldo)}
                                    {Number(b.saldo_vencido) > 0 ? ` · vencido ${money(b.saldo_vencido)}` : ''}
                                </span>
                            </Link>
                        ))}
                    </div>
                </section>
            )}

            {verPagos && (
                <section className="panel">
                    <h2 className="panel__title">Pagos recientes</h2>
                    {payments === null ? (
                        <Spinner />
                    ) : payments.length === 0 ? (
                        <p className="muted">Todavía no hay pagos registrados.</p>
                    ) : (
                        <div className="table-wrap">
                            <table className="table">
                                <thead>
                                    <tr>
                                        <th>Fecha</th>
                                        <th>Cliente</th>
                                        <th>Crédito</th>
                                        <th className="right">Monto</th>
                                        <th>Método</th>
                                        <th>Registró</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {payments.map((p) => (
                                        <tr key={p.id}>
                                            <td>{formatDate(p.payment_date)}</td>
                                            <td>
                                                <Link className="link" to={`/clientes/${p.customer_id}`}>
                                                    {p.customer_name}
                                                </Link>
                                            </td>
                                            <td>
                                                <Link className="link mono" to={`/cartera/creditos/${p.sale_id}`}>
                                                    {p.sale_number}
                                                </Link>
                                            </td>
                                            <td className="right strong">{money(p.amount)}</td>
                                            <td>{METHOD_LABELS[p.method] ?? p.method}</td>
                                            <td className="muted">{p.created_by || '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>
            )}
        </div>
    );
}
