import { useCallback, useEffect, useState } from 'react';
import { auditApi } from '../services/api.js';
import { useDebounce } from '../hooks/useDebounce.js';
import { useToast } from '../context/ToastContext.jsx';
import { Badge, EmptyState, Pagination, SearchInput, Spinner } from '../components/ui.jsx';

/**
 * REQ-0016 — Bitácora y auditoría.
 *
 * Solo lectura, y a propósito: las entradas las escribe el sistema y la base
 * de datos impide modificarlas o borrarlas (RN-0006). Aquí no hay ningún
 * botón de editar ni de eliminar porque no debe haberlo.
 */
const RESULT_LABEL = { ok: 'Correcta', denegado: 'Denegada', error: 'Error' };
const RESULT_BADGE = { ok: 'pagada', denegado: 'vencida', error: 'anulada' };

function formatMoment(value) {
    if (!value) return '';
    const d = new Date(value);
    return d.toLocaleString('es-GT', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

export default function Audit() {
    const toast = useToast();
    const [search, setSearch] = useState('');
    const [action, setAction] = useState('');
    const [module, setModule] = useState('');
    const [result, setResult] = useState('');
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [page, setPage] = useState(1);
    const [state, setState] = useState({ loading: true, rows: [], pagination: null });
    const [options, setOptions] = useState({ actions: [], modules: [] });
    const [expanded, setExpanded] = useState(null);
    const debounced = useDebounce(search);

    const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true }));
        try {
            const res = await auditApi.list({
                search: debounced,
                action,
                module,
                result,
                from,
                to,
                page,
                pageSize: 25,
            });
            setState({ loading: false, rows: res.data, pagination: res.pagination });
        } catch (e) {
            setState({ loading: false, rows: [], pagination: null });
            toast.error(e.message);
        }
    }, [debounced, action, module, result, from, to, page, toast]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        auditApi
            .filters()
            .then((res) => setOptions(res.data))
            .catch(() => {});
    }, []);

    useEffect(() => {
        setPage(1);
    }, [debounced, action, module, result, from, to]);

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Bitácora</h1>
                    <p className="page__sub">
                        Registro de las operaciones del sistema. No se puede modificar ni eliminar.
                    </p>
                </div>
            </div>

            <div className="toolbar">
                <SearchInput value={search} onChange={setSearch} placeholder="Descripción o usuario…" />
                <select className="input input--select" value={module} onChange={(e) => setModule(e.target.value)}>
                    <option value="">Todos los módulos</option>
                    {options.modules.map((m) => (
                        <option key={m} value={m}>
                            {m}
                        </option>
                    ))}
                </select>
                <select className="input input--select" value={action} onChange={(e) => setAction(e.target.value)}>
                    <option value="">Todas las acciones</option>
                    {options.actions.map((a) => (
                        <option key={a} value={a}>
                            {a}
                        </option>
                    ))}
                </select>
                <select className="input input--select" value={result} onChange={(e) => setResult(e.target.value)}>
                    <option value="">Todo resultado</option>
                    <option value="ok">Correctas</option>
                    <option value="denegado">Denegadas</option>
                    <option value="error">Con error</option>
                </select>
                <input
                    type="date"
                    className="input"
                    value={from}
                    max={to || undefined}
                    onChange={(e) => setFrom(e.target.value)}
                    aria-label="Desde"
                />
                <input
                    type="date"
                    className="input"
                    value={to}
                    min={from || undefined}
                    onChange={(e) => setTo(e.target.value)}
                    aria-label="Hasta"
                />
            </div>

            {state.loading ? (
                <Spinner />
            ) : state.rows.length === 0 ? (
                <EmptyState
                    title="No hay registros que coincidan"
                    hint="Prueba con otro rango de fechas o quita los filtros."
                />
            ) : (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Fecha y hora</th>
                                <th>Usuario</th>
                                <th>Acción</th>
                                <th>Descripción</th>
                                <th>Resultado</th>
                            </tr>
                        </thead>
                        <tbody>
                            {state.rows.map((row) => (
                                <tr
                                    key={row.id}
                                    onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                                    className={row.details ? 'row--clickable' : ''}
                                >
                                    <td className="nowrap mono">{formatMoment(row.occurred_at)}</td>
                                    <td>
                                        {row.user_full_name}
                                        <span className="muted"> · {row.user_role_name ?? '—'}</span>
                                    </td>
                                    <td className="mono">{row.action}</td>
                                    <td>
                                        {row.summary}
                                        {expanded === row.id && row.details && (
                                            <pre className="audit-details">
                                                {JSON.stringify(row.details, null, 2)}
                                            </pre>
                                        )}
                                    </td>
                                    <td>
                                        <Badge status={RESULT_BADGE[row.result] ?? 'pendiente'}>
                                            {RESULT_LABEL[row.result] ?? row.result}
                                        </Badge>
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
