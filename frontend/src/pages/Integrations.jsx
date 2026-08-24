import { useCallback, useEffect, useState } from 'react';
import { integrationsApi } from '../services/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { Badge, EmptyState, Modal, Pagination, Spinner } from '../components/ui.jsx';
import { formatDateTime } from '../utils/format.js';

const STATUS_LABELS = {
    pendiente: 'Pendiente',
    enviado: 'Enviado',
    fallido: 'Fallido',
    descartado: 'Descartado',
};

// Reutiliza los colores de estado de cuenta: verde para lo resuelto,
// rojo para lo que necesita atención.
const STATUS_BADGE = {
    enviado: 'pagada',
    pendiente: 'pendiente',
    fallido: 'vencida',
    descartado: 'anulada',
};

export default function Integrations() {
    const toast = useToast();
    const [status, setStatus] = useState(null);
    const [filter, setFilter] = useState('');
    const [typeFilter, setTypeFilter] = useState('');
    const [page, setPage] = useState(1);
    const [list, setList] = useState({ loading: true, rows: [], pagination: null });
    const [detail, setDetail] = useState(null);
    const [busy, setBusy] = useState('');

    const loadStatus = useCallback(async () => {
        try {
            const res = await integrationsApi.status();
            setStatus(res.data);
        } catch (e) {
            toast.error(e.message);
        }
    }, [toast]);

    const loadList = useCallback(async () => {
        setList((s) => ({ ...s, loading: true }));
        try {
            const res = await integrationsApi.events({ status: filter, type: typeFilter, page, pageSize: 15 });
            setList({ loading: false, rows: res.data, pagination: res.pagination });
        } catch (e) {
            setList({ loading: false, rows: [], pagination: null });
            toast.error(e.message);
        }
    }, [filter, typeFilter, page, toast]);

    useEffect(() => {
        loadStatus();
    }, [loadStatus]);
    useEffect(() => {
        loadList();
    }, [loadList]);
    useEffect(() => {
        setPage(1);
    }, [filter, typeFilter]);

    async function run(action, label) {
        setBusy(label);
        try {
            const res = await action();
            toast.success(res.message ?? 'Listo');
            await Promise.all([loadStatus(), loadList()]);
        } catch (e) {
            toast.error(e.fullMessage);
        } finally {
            setBusy('');
        }
    }

    async function openDetail(id) {
        try {
            const res = await integrationsApi.event(id);
            setDetail(res.data);
        } catch (e) {
            toast.error(e.message);
        }
    }

    if (!status) return <Spinner label="Consultando el estado del puente…" />;

    const c = status.counts;
    const pendingWork = c.pendiente + c.fallido;

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <h1>Integraciones</h1>
                    <p className="page__sub">
                        Bandeja de salida de eventos hacia n8n. La aplicación guarda primero y notifica después: si n8n
                        está caído, la operación no se detiene.
                    </p>
                </div>
                <div className="row-actions">
                    <button
                        className="btn"
                        disabled={Boolean(busy)}
                        onClick={() => run(integrationsApi.scan, 'scan')}
                    >
                        {busy === 'scan' ? 'Barriendo…' : 'Barrer cuotas'}
                    </button>
                    <button
                        className="btn btn--primary"
                        disabled={Boolean(busy)}
                        onClick={() => run(integrationsApi.dispatch, 'dispatch')}
                    >
                        {busy === 'dispatch' ? 'Enviando…' : 'Enviar pendientes'}
                    </button>
                </div>
            </div>

            {!status.enabled && (
                <p className="alert alert--warn">
                    El envío hacia n8n está <strong>desactivado</strong>. Los eventos se siguen registrando y se
                    enviarán cuando lo actives con <code>N8N_DISPATCH_ENABLED=true</code> y <code>N8N_WEBHOOK_URL</code>{' '}
                    en <code>backend/.env</code>.
                </p>
            )}
            {status.enabled && !status.signature_configured && (
                <p className="alert alert--error">
                    Falta <code>N8N_WEBHOOK_SECRET</code>: los envíos van <strong>sin firma</strong> y n8n no puede
                    comprobar que vienen de este sistema.
                </p>
            )}

            <div className="cards">
                <div className="card card--static">
                    <span className="card__label">Enviados</span>
                    <strong className="card__value">{c.enviado}</strong>
                </div>
                <div className={`card card--static ${c.pendiente > 0 ? 'card--alert' : ''}`}>
                    <span className="card__label">Pendientes</span>
                    <strong className="card__value">{c.pendiente}</strong>
                </div>
                <div className={`card card--static ${c.fallido > 0 ? 'card--alert' : ''}`}>
                    <span className="card__label">Fallidos</span>
                    <strong className="card__value">{c.fallido}</strong>
                    <span className="card__extra">se reintentan solos</span>
                </div>
                <div className={`card card--static ${c.descartado > 0 ? 'card--alert' : ''}`}>
                    <span className="card__label">Descartados</span>
                    <strong className="card__value">{c.descartado}</strong>
                    <span className="card__extra">tras {status.max_attempts} intentos</span>
                </div>
            </div>

            <section className="panel">
                <h2 className="panel__title">Configuración vigente</h2>
                <dl className="datalist">
                    <div>
                        <dt>Envío automático</dt>
                        <dd>{status.enabled ? 'Activo' : 'Desactivado'}</dd>
                    </div>
                    <div>
                        <dt>Webhook</dt>
                        <dd>{status.webhook_configured ? 'Configurado' : 'Sin configurar'}</dd>
                    </div>
                    <div>
                        <dt>Firma HMAC</dt>
                        <dd>{status.signature_configured ? 'Activa' : 'Sin secreto'}</dd>
                    </div>
                    <div>
                        <dt>Revisión cada</dt>
                        <dd>{Math.round(status.interval_ms / 1000)} s</dd>
                    </div>
                    <div>
                        <dt>Espera entre reintentos</dt>
                        <dd>{status.backoff_seconds.map((s) => humanSeconds(s)).join(' · ')}</dd>
                    </div>
                    <div>
                        <dt>Más antiguo sin enviar</dt>
                        <dd>
                            {status.oldest_pending
                                ? `${status.oldest_pending.event_type} · ${formatDateTime(
                                      status.oldest_pending.created_at
                                  )}`
                                : '—'}
                        </dd>
                    </div>
                </dl>
            </section>

            <section className="panel">
                <h2 className="panel__title">Eventos por tipo</h2>
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Evento</th>
                                <th className="right">Total</th>
                                <th className="right">Enviados</th>
                                <th className="right">Sin enviar</th>
                            </tr>
                        </thead>
                        <tbody>
                            {status.by_type.length === 0 ? (
                                <tr>
                                    <td colSpan={4} className="muted">
                                        Todavía no se ha generado ningún evento.
                                    </td>
                                </tr>
                            ) : (
                                status.by_type.map((t) => (
                                    <tr key={t.event_type}>
                                        <td className="mono">{t.event_type}</td>
                                        <td className="right">{t.total}</td>
                                        <td className="right">{t.enviados}</td>
                                        <td className={`right ${t.no_enviados > 0 ? 'text-danger strong' : ''}`}>
                                            {t.no_enviados}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="panel">
                <h2 className="panel__title">
                    Bandeja de salida {pendingWork > 0 && <span className="text-danger">· {pendingWork} sin entregar</span>}
                </h2>

                <div className="toolbar">
                    <select className="input input--select" value={filter} onChange={(e) => setFilter(e.target.value)}>
                        <option value="">Todos los estados</option>
                        <option value="pendiente">Pendientes</option>
                        <option value="enviado">Enviados</option>
                        <option value="fallido">Fallidos</option>
                        <option value="descartado">Descartados</option>
                    </select>
                    <select
                        className="input input--select"
                        value={typeFilter}
                        onChange={(e) => setTypeFilter(e.target.value)}
                    >
                        <option value="">Todos los eventos</option>
                        {status.by_type.map((t) => (
                            <option key={t.event_type} value={t.event_type}>
                                {t.event_type}
                            </option>
                        ))}
                    </select>
                </div>

                {list.loading ? (
                    <Spinner />
                ) : list.rows.length === 0 ? (
                    <EmptyState title="No hay eventos que coincidan" />
                ) : (
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>Evento</th>
                                    <th>Referencia</th>
                                    <th>Generado</th>
                                    <th>Entregado</th>
                                    <th className="center">Intentos</th>
                                    <th>Estado</th>
                                    <th className="right">Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                {list.rows.map((e) => (
                                    <tr key={e.id} className={e.status === 'descartado' ? 'row--error' : ''}>
                                        <td className="mono">{e.id}</td>
                                        <td className="mono">{e.event_type}</td>
                                        <td className="muted small">
                                            {e.aggregate} {e.aggregate_id}
                                        </td>
                                        <td className="small">{formatDateTime(e.created_at)}</td>
                                        <td className="small">{e.sent_at ? formatDateTime(e.sent_at) : '—'}</td>
                                        <td className="center">{e.attempts}</td>
                                        <td>
                                            <Badge status={STATUS_BADGE[e.status]}>{STATUS_LABELS[e.status]}</Badge>
                                            {e.last_error && (
                                                <div className="text-danger small truncate" title={e.last_error}>
                                                    {e.last_error}
                                                </div>
                                            )}
                                        </td>
                                        <td className="right nowrap">
                                            <button className="btn btn--ghost btn--sm" onClick={() => openDetail(e.id)}>
                                                Ver
                                            </button>
                                            {e.status !== 'enviado' && (
                                                <button
                                                    className="btn btn--ghost btn--sm"
                                                    onClick={() => run(() => integrationsApi.retry(e.id), `r${e.id}`)}
                                                >
                                                    Reintentar
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                <Pagination pagination={list.pagination} onChange={setPage} />
            </section>

            {detail && <EventDetail event={detail} onClose={() => setDetail(null)} />}
        </div>
    );
}

function humanSeconds(s) {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}min`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
}

function EventDetail({ event, onClose }) {
    return (
        <Modal open wide title={`Evento ${event.id} · ${event.event_type}`} onClose={onClose}>
            <dl className="datalist">
                <div>
                    <dt>Estado</dt>
                    <dd>
                        <Badge status={STATUS_BADGE[event.status]}>{STATUS_LABELS[event.status]}</Badge>
                    </dd>
                </div>
                <div>
                    <dt>Generado</dt>
                    <dd>{formatDateTime(event.created_at)}</dd>
                </div>
                <div>
                    <dt>Entregado</dt>
                    <dd>{event.sent_at ? formatDateTime(event.sent_at) : '—'}</dd>
                </div>
                <div>
                    <dt>Próximo intento</dt>
                    <dd>{event.status === 'enviado' ? '—' : formatDateTime(event.next_attempt_at)}</dd>
                </div>
                <div>
                    <dt>Clave de idempotencia</dt>
                    <dd className="mono small">{event.unique_key || '—'}</dd>
                </div>
            </dl>

            <h3 className="panel__title">Intentos de entrega</h3>
            {event.attempts.length === 0 ? (
                <p className="muted">Todavía no se ha intentado enviar.</p>
            ) : (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th className="center">#</th>
                                <th>Momento</th>
                                <th className="right">Duración</th>
                                <th className="center">HTTP</th>
                                <th>Resultado</th>
                            </tr>
                        </thead>
                        <tbody>
                            {event.attempts.map((a) => (
                                <tr key={a.attempt_no}>
                                    <td className="center">{a.attempt_no}</td>
                                    <td className="small">{formatDateTime(a.started_at)}</td>
                                    <td className="right">{a.duration_ms} ms</td>
                                    <td className="center">{a.http_status ?? '—'}</td>
                                    <td className={a.ok ? '' : 'text-danger'}>{a.ok ? 'Entregado' : a.error}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <h3 className="panel__title">Contenido enviado a n8n</h3>
            <pre className="code-block">{JSON.stringify(event.payload, null, 2)}</pre>
        </Modal>
    );
}
