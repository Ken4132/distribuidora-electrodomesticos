import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { paymentsApi, salesApi } from '../services/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { Badge, EmptyState, Pagination, Spinner } from '../components/ui.jsx';
import { ACCOUNT_STATUS_LABELS, formatDate, METHOD_LABELS, money } from '../utils/format.js';
import { PaymentModal } from './SaleDetail.jsx';

export default function Receivables() {
    const toast = useToast();
    const [tab, setTab] = useState('pendientes');
    const [status, setStatus] = useState('');
    const [page, setPage] = useState(1);
    const [state, setState] = useState({ loading: true, rows: [], pagination: null });
    const [paying, setPaying] = useState(null);

    const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true }));
        try {
            const res =
                tab === 'pendientes'
                    ? await paymentsApi.receivables({ status, page, pageSize: 15 })
                    : await paymentsApi.list({ page, pageSize: 15 });
            setState({ loading: false, rows: res.data, pagination: res.pagination });
        } catch (e) {
            setState({ loading: false, rows: [], pagination: null });
            toast.error(e.message);
        }
    }, [tab, status, page, toast]);

    useEffect(() => {
        load();
    }, [load]);
    useEffect(() => {
        setPage(1);
    }, [tab, status]);

    async function openPayment(saleId) {
        try {
            const res = await salesApi.get(saleId);
            setPaying(res.data);
        } catch (e) {
            toast.error(e.message);
        }
    }

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Cobranza</h1>
                    <p className="page__sub">Cuentas por cobrar y pagos recibidos</p>
                </div>
            </div>

            <div className="tabs">
                <button
                    className={`tab ${tab === 'pendientes' ? 'tab--active' : ''}`}
                    onClick={() => setTab('pendientes')}
                >
                    Por cobrar
                </button>
                <button className={`tab ${tab === 'pagos' ? 'tab--active' : ''}`} onClick={() => setTab('pagos')}>
                    Pagos recibidos
                </button>
            </div>

            {tab === 'pendientes' && (
                <div className="toolbar">
                    <select className="input input--select" value={status} onChange={(e) => setStatus(e.target.value)}>
                        <option value="">Todas las cuentas con saldo</option>
                        <option value="vencida">Solo vencidas</option>
                        <option value="al_dia">Al día</option>
                        <option value="pendiente">Sin pagos aún</option>
                    </select>
                </div>
            )}

            {state.loading ? (
                <Spinner />
            ) : state.rows.length === 0 ? (
                <EmptyState
                    title={tab === 'pendientes' ? 'No hay cuentas pendientes' : 'No hay pagos registrados'}
                    hint={tab === 'pendientes' ? 'Todas las ventas están saldadas.' : undefined}
                />
            ) : tab === 'pendientes' ? (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Venta</th>
                                <th>Cliente</th>
                                <th>Teléfono</th>
                                <th className="right">Total</th>
                                <th className="right">Saldo</th>
                                <th className="center">Cuotas</th>
                                <th>Próx. vence</th>
                                <th>Estado</th>
                                <th className="right">Acción</th>
                            </tr>
                        </thead>
                        <tbody>
                            {state.rows.map((s) => (
                                <tr key={s.id} className={s.account_status === 'vencida' ? 'row--error' : ''}>
                                    <td>
                                        <Link className="link mono" to={`/ventas/${s.id}`}>
                                            {s.sale_number}
                                        </Link>
                                    </td>
                                    <td>
                                        <Link className="link" to={`/clientes/${s.customer_id}`}>
                                            {s.customer_name}
                                        </Link>
                                    </td>
                                    <td className="mono">{s.customer_phone}</td>
                                    <td className="right">{money(s.total)}</td>
                                    <td className="right strong">{money(s.balance)}</td>
                                    <td className="center">
                                        {s.installments_paid}/{s.installments_count}
                                        {s.installments_overdue > 0 && (
                                            <span className="text-danger"> ({s.installments_overdue} vencida)</span>
                                        )}
                                    </td>
                                    <td>{s.next_due_date ? formatDate(s.next_due_date) : '—'}</td>
                                    <td>
                                        <Badge status={s.account_status}>{ACCOUNT_STATUS_LABELS[s.account_status]}</Badge>
                                    </td>
                                    <td className="right">
                                        <button className="btn btn--sm btn--primary" onClick={() => openPayment(s.id)}>
                                            Cobrar
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Recibo</th>
                                <th>Fecha</th>
                                <th>Cliente</th>
                                <th>Venta</th>
                                <th className="right">Monto</th>
                                <th>Método</th>
                                <th>Referencia</th>
                            </tr>
                        </thead>
                        <tbody>
                            {state.rows.map((p) => (
                                <tr key={p.id}>
                                    <td className="mono">{p.receipt_number}</td>
                                    <td>{formatDate(p.payment_date)}</td>
                                    <td>
                                        <Link className="link" to={`/clientes/${p.customer_id}`}>
                                            {p.customer_name}
                                        </Link>
                                    </td>
                                    <td>
                                        <Link className="link mono" to={`/ventas/${p.sale_id}`}>
                                            {p.sale_number}
                                        </Link>
                                    </td>
                                    <td className="right strong">{money(p.amount)}</td>
                                    <td>{METHOD_LABELS[p.method] ?? p.method}</td>
                                    <td className="muted">{p.reference || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <Pagination pagination={state.pagination} onChange={setPage} />

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
        </div>
    );
}
