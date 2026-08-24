import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { salesApi } from '../services/api.js';
import { useDebounce } from '../hooks/useDebounce.js';
import { useToast } from '../context/ToastContext.jsx';
import { Badge, EmptyState, Pagination, SearchInput, Spinner } from '../components/ui.jsx';
import { ACCOUNT_STATUS_LABELS, formatDate, money, PAYMENT_MODE_LABELS } from '../utils/format.js';

export default function Sales() {
    const toast = useToast();
    const [search, setSearch] = useState('');
    const [accountStatus, setAccountStatus] = useState('');
    const [page, setPage] = useState(1);
    const [state, setState] = useState({ loading: true, rows: [], pagination: null });
    const debounced = useDebounce(search);

    const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true }));
        try {
            const res = await salesApi.list({ search: debounced, accountStatus, page, pageSize: 15 });
            setState({ loading: false, rows: res.data, pagination: res.pagination });
        } catch (e) {
            setState({ loading: false, rows: [], pagination: null });
            toast.error(e.message);
        }
    }, [debounced, accountStatus, page, toast]);

    useEffect(() => {
        load();
    }, [load]);
    useEffect(() => {
        setPage(1);
    }, [debounced, accountStatus]);

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Ventas</h1>
                    <p className="page__sub">Busca por número de venta, cliente o DPI</p>
                </div>
                <Link to="/ventas/nueva" className="btn btn--primary">
                    Nueva venta
                </Link>
            </div>

            <div className="toolbar">
                <SearchInput value={search} onChange={setSearch} placeholder="V-000001, nombre o DPI…" />
                <select
                    className="input input--select"
                    value={accountStatus}
                    onChange={(e) => setAccountStatus(e.target.value)}
                >
                    <option value="">Todos los estados</option>
                    <option value="pendiente">Pendiente</option>
                    <option value="al_dia">Al día</option>
                    <option value="vencida">Vencida</option>
                    <option value="pagada">Pagada</option>
                    <option value="anulada">Anulada</option>
                </select>
            </div>

            {state.loading ? (
                <Spinner />
            ) : state.rows.length === 0 ? (
                <EmptyState title="No hay ventas que coincidan" />
            ) : (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>No.</th>
                                <th>Fecha</th>
                                <th>Cliente</th>
                                <th>Modalidad</th>
                                <th className="right">Total</th>
                                <th className="right">Pagado</th>
                                <th className="right">Saldo</th>
                                <th>Cuotas</th>
                                <th>Próx. vence</th>
                                <th>Estado</th>
                            </tr>
                        </thead>
                        <tbody>
                            {state.rows.map((s) => (
                                <tr key={s.id}>
                                    <td>
                                        <Link className="link mono" to={`/ventas/${s.id}`}>
                                            {s.sale_number}
                                        </Link>
                                    </td>
                                    <td>{formatDate(s.sale_date)}</td>
                                    <td>
                                        <Link className="link" to={`/clientes/${s.customer_id}`}>
                                            {s.customer_name}
                                        </Link>
                                    </td>
                                    <td>{PAYMENT_MODE_LABELS[s.payment_mode]}</td>
                                    <td className="right">{money(s.total)}</td>
                                    <td className="right">{money(s.paid_amount)}</td>
                                    <td className="right strong">{money(s.balance)}</td>
                                    <td className="center">
                                        {s.installments_paid}/{s.installments_count}
                                    </td>
                                    <td>{s.next_due_date ? formatDate(s.next_due_date) : '—'}</td>
                                    <td>
                                        <Badge status={s.account_status}>{ACCOUNT_STATUS_LABELS[s.account_status]}</Badge>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <Pagination pagination={state.pagination} onChange={setPage} />
        </div>
    );
}
