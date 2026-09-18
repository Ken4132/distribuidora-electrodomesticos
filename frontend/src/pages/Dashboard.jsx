import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collectionsApi, dashboardApi, paymentsApi } from '../services/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { formatDate, METHOD_LABELS, money } from '../utils/format.js';
import { AgingBar, Spinner, Stat, Stats } from '../components/ui.jsx';

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

            {/* Primero el dinero: cartera y mora. Es lo que se mira al abrir. */}
            <Stats>
                <Stat
                    label="Saldo de cartera"
                    value={collections ? money(t.saldo) : money(data.receivables.total_balance)}
                    meta="Total por cobrar"
                    tone="accent"
                    to="/cartera"
                />
                <Stat
                    label="Monto vencido"
                    value={collections ? money(t.saldo_vencido) : '—'}
                    meta={`${data.receivables.overdue_sales} crédito(s) con cuota vencida`}
                    tone={Number(t.saldo_vencido) > 0 ? 'danger' : undefined}
                    to="/cartera"
                />
                <Stat
                    label="Créditos activos"
                    value={collections ? t.creditos : '—'}
                    meta={collections ? `${creditosVencidos} con atraso` : 'Sin acceso a cartera'}
                    tone={creditosVencidos > 0 ? 'warn' : undefined}
                    to="/cartera"
                />
                <Stat
                    label="Ventas de hoy"
                    value={data.sales.today_count}
                    meta={money(data.sales.today_amount)}
                    to="/ventas"
                />
                <Stat
                    label="Clientes activos"
                    value={data.customers.active}
                    meta={`${data.customers.total} registrados`}
                    to="/clientes"
                />
                <Stat
                    label="Productos"
                    value={data.products.active}
                    meta={`${data.products.low_stock} con stock bajo`}
                    tone={data.products.low_stock > 0 ? 'warn' : undefined}
                    to="/productos"
                />
            </Stats>

            {collections && (
                <section className="panel">
                    <div className="panel__head">
                        <h2 className="panel__title">Distribución de la cartera por mora</h2>
                        <Link className="btn btn--ghost btn--sm" to="/cartera">
                            Ver cartera
                        </Link>
                    </div>
                    <AgingBar buckets={collections.buckets ?? []} />
                </section>
            )}

            {verPagos && (
                <section className="panel">
                    <div className="panel__head">
                        <h2 className="panel__title">Pagos recientes</h2>
                        <Link className="btn btn--ghost btn--sm" to="/cobranza">
                            Ver cobranza
                        </Link>
                    </div>
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
