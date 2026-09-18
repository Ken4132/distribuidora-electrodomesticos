import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { creditsApi } from '../services/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useDebounce } from '../hooks/useDebounce.js';
import { useToast } from '../context/ToastContext.jsx';
import { Badge, EmptyState, Pagination, SearchInput, Spinner } from '../components/ui.jsx';
import { CREDIT_STATUS_BADGE, CREDIT_STATUS_LABELS, CREDIT_TYPE_LABELS, formatDateTime, money } from '../utils/format.js';

/**
 * Bandeja de solicitudes de crédito. Lo que aparece lo decide el backend según
 * el alcance del usuario: el vendedor ve las suyas, el cobrador las de su
 * sucursal por verificar, Administración y Gerencia todas.
 */
export default function CreditApplications() {
    const toast = useToast();
    const { can } = useAuth();
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState('');
    const [page, setPage] = useState(1);
    const [state, setState] = useState({ loading: true, rows: [], pagination: null });
    const debounced = useDebounce(search);

    const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true }));
        try {
            const res = await creditsApi.list({ search: debounced, status, page, pageSize: 15 });
            setState({ loading: false, rows: res.data, pagination: res.pagination });
        } catch (e) {
            setState({ loading: false, rows: [], pagination: null });
            toast.error(e.message);
        }
    }, [debounced, status, page, toast]);

    useEffect(() => {
        load();
    }, [load]);
    useEffect(() => {
        setPage(1);
    }, [debounced, status]);

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Solicitudes de crédito</h1>
                    <p className="page__sub">Busca por número, nombre o DPI del cliente</p>
                </div>
                {can('credits.create') && (
                    <Link to="/creditos/nueva" className="btn btn--primary">
                        Nueva solicitud
                    </Link>
                )}
            </div>

            <div className="toolbar">
                <SearchInput value={search} onChange={setSearch} placeholder="Número, nombre o DPI…" />
                <select className="input input--select" value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="">Todos los estados</option>
                    {Object.entries(CREDIT_STATUS_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>
                            {v}
                        </option>
                    ))}
                </select>
            </div>

            {state.loading ? (
                <Spinner />
            ) : state.rows.length === 0 ? (
                <EmptyState title="No hay solicitudes que coincidan" />
            ) : (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>No.</th>
                                <th>Registrada</th>
                                <th>Cliente</th>
                                <th>Tipo</th>
                                <th>Sucursal</th>
                                <th>Vendedor</th>
                                <th className="right">Total</th>
                                <th className="right">Enganche</th>
                                <th>Excepción</th>
                                <th>Estado</th>
                            </tr>
                        </thead>
                        <tbody>
                            {state.rows.map((r) => (
                                <tr key={r.id}>
                                    <td>
                                        <Link className="link mono" to={`/creditos/${r.id}`}>
                                            #{r.application_number}
                                        </Link>
                                    </td>
                                    <td>{formatDateTime(r.created_at)}</td>
                                    <td>
                                        {r.customer_full_name_snapshot}
                                        <div className="muted small">DPI {r.customer_dpi_snapshot}</div>
                                    </td>
                                    <td>{CREDIT_TYPE_LABELS[r.credit_type] ?? r.credit_type}</td>
                                    <td>{r.branch_name}</td>
                                    <td>{r.created_by_username}</td>
                                    <td className="right">{money(r.total)}</td>
                                    <td className="right">{money(r.proposed_down_payment)}</td>
                                    <td>{r.requires_exception ? <Badge status="vencida">Bajo mínimo</Badge> : '—'}</td>
                                    <td>
                                        <Badge status={CREDIT_STATUS_BADGE[r.status]}>{CREDIT_STATUS_LABELS[r.status]}</Badge>
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
