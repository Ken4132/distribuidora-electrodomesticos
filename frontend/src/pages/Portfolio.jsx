import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { collectionsApi } from '../services/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { Badge, EmptyState, Pagination, SearchInput, Spinner } from '../components/ui.jsx';
import {
    ACCOUNT_STATUS_LABELS,
    BUCKET_BADGE,
    BUCKET_LABELS,
    formatDate,
    INSTALLMENT_STATUS_LABELS,
    money,
} from '../utils/format.js';

const BUCKETS = ['AL_DIA', '1_30', '31_60', '61_90', 'MAS_90'];

/**
 * CARTERA Y MORosidad.
 *
 * Todo lo que se ve —días de atraso, saldo vencido, tramo— lo calcula el
 * backend en `/collections`. Aquí no se deriva ni un número: solo se pinta.
 */
export default function Portfolio() {
    const toast = useToast();
    const [params] = useSearchParams();
    const [tab, setTab] = useState('creditos');
    // El panel de inicio enlaza aquí con un tramo ya elegido.
    const [bucket, setBucket] = useState(params.get('tramo') ?? '');
    const [status, setStatus] = useState('');
    const [text, setText] = useState('');
    const [page, setPage] = useState(1);
    const [scope, setScope] = useState(null);
    const [summary, setSummary] = useState(null);
    const [state, setState] = useState({ loading: true, rows: [], pagination: null, error: '' });

    useEffect(() => {
        collectionsApi
            .summary()
            .then((r) => setSummary(r.data))
            .catch((e) => toast.error(e.message));
    }, [toast]);

    const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true, error: '' }));
        try {
            const params = { page, pageSize: 20, bucket: bucket || undefined };
            let res;
            if (tab === 'creditos') {
                res = await collectionsApi.portfolio({ ...params, status: status || undefined });
            } else if (tab === 'vencidas') {
                res = await collectionsApi.overdue(params);
            } else {
                res = await collectionsApi.installments({ ...params, onlyPending: 'true' });
            }
            setScope(res.scope ?? null);
            setState({ loading: false, rows: res.data ?? [], pagination: res.pagination, error: '' });
        } catch (e) {
            setState({ loading: false, rows: [], pagination: null, error: e.message });
        }
    }, [tab, bucket, status, page]);

    useEffect(() => {
        load();
    }, [load]);
    useEffect(() => {
        setPage(1);
    }, [tab, bucket, status]);

    /**
     * Búsqueda por cliente. El backend filtra por identificador, no por texto,
     * así que el texto acota lo que ya está en pantalla en lugar de inventar
     * un endpoint que no existe.
     */
    const rows = useMemo(() => {
        const q = text.trim().toLowerCase();
        if (!q) return state.rows;
        return state.rows.filter(
            (r) =>
                String(r.customer_name ?? '').toLowerCase().includes(q) ||
                String(r.customer_dpi ?? '').includes(q) ||
                String(r.sale_number ?? '').toLowerCase().includes(q)
        );
    }, [state.rows, text]);

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>{scope === 'propia' ? 'Tu cartera' : 'Cartera y cobranza'}</h1>
                    <p className="page__sub">
                        {scope === 'propia'
                            ? 'Créditos que registraste, con su atraso y su saldo'
                            : 'Créditos vivos, cuotas vencidas y tramos de morosidad'}
                    </p>
                </div>
            </div>

            {summary && <SummaryCards summary={summary} active={bucket} onPick={setBucket} />}

            <div className="tabs">
                <button className={`tab ${tab === 'creditos' ? 'tab--active' : ''}`} onClick={() => setTab('creditos')}>
                    Créditos
                </button>
                <button className={`tab ${tab === 'vencidas' ? 'tab--active' : ''}`} onClick={() => setTab('vencidas')}>
                    Cuotas vencidas
                </button>
                <button className={`tab ${tab === 'cuotas' ? 'tab--active' : ''}`} onClick={() => setTab('cuotas')}>
                    Cuotas pendientes
                </button>
            </div>

            <div className="toolbar">
                <SearchInput value={text} onChange={setText} placeholder="Buscar cliente, DPI o número de venta…" />
                <select className="input input--select" value={bucket} onChange={(e) => setBucket(e.target.value)}>
                    <option value="">Todos los tramos de mora</option>
                    {BUCKETS.map((b) => (
                        <option key={b} value={b}>
                            {BUCKET_LABELS[b]}
                        </option>
                    ))}
                </select>
                {tab === 'creditos' && (
                    <select className="input input--select" value={status} onChange={(e) => setStatus(e.target.value)}>
                        <option value="">Todos los estados</option>
                        <option value="vencida">Vencida</option>
                        <option value="al_dia">Al día</option>
                        <option value="pendiente">Sin pagos aún</option>
                    </select>
                )}
            </div>

            {state.loading ? (
                <Spinner />
            ) : state.error ? (
                <p className="alert alert--error">{state.error}</p>
            ) : rows.length === 0 ? (
                <EmptyState
                    title={text ? 'Nada coincide con la búsqueda' : 'No hay nada en este filtro'}
                    hint={text ? 'Prueba con otro nombre o número.' : 'La cartera está al día para este criterio.'}
                />
            ) : tab === 'creditos' ? (
                <CreditsTable rows={rows} />
            ) : (
                <InstallmentsTable rows={rows} />
            )}

            <Pagination pagination={state.pagination} onChange={setPage} />
        </div>
    );
}

function SummaryCards({ summary, active, onPick }) {
    const t = summary.totales ?? {};
    return (
        <>
            <div className="cards">
                <div className="card card--static">
                    <span className="card__label">Créditos con saldo</span>
                    <strong className="card__value">{t.creditos ?? 0}</strong>
                </div>
                <div className="card card--static">
                    <span className="card__label">Saldo de cartera</span>
                    <strong className="card__value">{money(t.saldo)}</strong>
                </div>
                <div className={`card card--static ${Number(t.saldo_vencido) > 0 ? 'card--alert' : ''}`}>
                    <span className="card__label">Monto vencido</span>
                    <strong className="card__value">{money(t.saldo_vencido)}</strong>
                </div>
            </div>

            <div className="cards">
                {(summary.buckets ?? []).map((b) => (
                    <button
                        key={b.bucket}
                        type="button"
                        className={`card ${active === b.bucket ? 'card--alert' : ''}`}
                        onClick={() => onPick(active === b.bucket ? '' : b.bucket)}
                    >
                        <span className="card__label">{BUCKET_LABELS[b.bucket] ?? b.bucket}</span>
                        <strong className="card__value">{b.creditos}</strong>
                        <span className="card__extra">{money(b.saldo)}</span>
                    </button>
                ))}
            </div>
        </>
    );
}

function CreditsTable({ rows }) {
    return (
        <div className="table-wrap">
            <table className="table">
                <thead>
                    <tr>
                        <th>Crédito</th>
                        <th>Cliente</th>
                        <th className="right">Total</th>
                        <th className="right">Saldo</th>
                        <th className="center">Cuotas</th>
                        <th>Próx. vence</th>
                        <th className="center">Atraso</th>
                        <th>Mora</th>
                        <th>Estado</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((s) => (
                        <tr key={s.sale_id} className={Number(s.days_overdue) > 0 ? 'row--error' : ''}>
                            <td>
                                <Link className="link mono" to={`/cartera/creditos/${s.sale_id}`}>
                                    {s.sale_number}
                                </Link>
                            </td>
                            <td>
                                <Link className="link" to={`/clientes/${s.customer_id}`}>
                                    {s.customer_name}
                                </Link>
                                <br />
                                <span className="muted small mono">{s.customer_phone}</span>
                            </td>
                            <td className="right">{money(s.total)}</td>
                            <td className="right strong">{money(s.balance)}</td>
                            <td className="center">
                                {s.installments_paid}/{s.installments_count}
                                {Number(s.installments_overdue) > 0 && (
                                    <span className="text-danger"> ({s.installments_overdue} venc.)</span>
                                )}
                            </td>
                            <td>{s.next_due_date ? formatDate(s.next_due_date) : '—'}</td>
                            <td className="center">{Number(s.days_overdue) > 0 ? `${s.days_overdue} d` : '—'}</td>
                            <td>
                                <Badge status={BUCKET_BADGE[s.overdue_bucket] ?? 'pendiente'}>
                                    {BUCKET_LABELS[s.overdue_bucket] ?? s.overdue_bucket}
                                </Badge>
                            </td>
                            <td>
                                <Badge status={s.account_status}>{ACCOUNT_STATUS_LABELS[s.account_status]}</Badge>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function InstallmentsTable({ rows }) {
    return (
        <div className="table-wrap">
            <table className="table">
                <thead>
                    <tr>
                        <th>Crédito</th>
                        <th>Cliente</th>
                        <th className="center">Cuota</th>
                        <th>Vence</th>
                        <th className="center">Atraso</th>
                        <th className="right">Monto</th>
                        <th className="right">Saldo</th>
                        <th>Mora</th>
                        <th>Estado</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((i) => (
                        <tr key={i.installment_id} className={Number(i.days_overdue) > 0 ? 'row--error' : ''}>
                            <td>
                                <Link className="link mono" to={`/cartera/creditos/${i.sale_id}`}>
                                    {i.sale_number}
                                </Link>
                            </td>
                            <td>
                                <Link className="link" to={`/clientes/${i.customer_id}`}>
                                    {i.customer_name}
                                </Link>
                                <br />
                                <span className="muted small mono">{i.customer_phone}</span>
                            </td>
                            <td className="center mono">{i.installment_number}</td>
                            <td>{formatDate(i.due_date)}</td>
                            <td className="center">{Number(i.days_overdue) > 0 ? `${i.days_overdue} d` : '—'}</td>
                            <td className="right">{money(i.amount)}</td>
                            <td className="right strong">{money(i.balance)}</td>
                            <td>
                                <Badge status={BUCKET_BADGE[i.overdue_bucket] ?? 'pendiente'}>
                                    {BUCKET_LABELS[i.overdue_bucket] ?? i.overdue_bucket}
                                </Badge>
                            </td>
                            <td>
                                <Badge status={i.status}>{INSTALLMENT_STATUS_LABELS[i.status] ?? i.status}</Badge>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
