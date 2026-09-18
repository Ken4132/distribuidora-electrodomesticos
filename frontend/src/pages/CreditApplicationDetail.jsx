import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { creditsApi } from '../services/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Badge, Field, Modal, Spinner } from '../components/ui.jsx';
import { CreditProductPicker } from './NewCreditApplication.jsx';
import {
    ACCOUNT_STATUS_LABELS,
    CREDIT_STATUS_BADGE,
    CREDIT_STATUS_LABELS,
    CREDIT_TYPE_LABELS,
    FINANCING_TYPE_LABELS,
    formatDate,
    formatDateTime,
    METHOD_LABELS,
    money,
    PAYMENT_MODE_LABELS,
    VERIFICATION_RESULT_LABELS,
} from '../utils/format.js';

/*
 * Detalle de una solicitud de crédito (Bloques 3.2 y 3.3).
 *
 * Los botones se muestran según permisos y estado solo por comodidad:
 * el backend vuelve a validar permiso, alcance y transición en cada acción.
 */

const PRE_DECISION = ['SOLICITADO', 'EN_VERIFICACION', 'EN_EVALUACION'];
const CHECK_LABELS = { SI: 'Sí', NO: 'No', NO_VERIFICABLE: 'No verificable' };
const CHECK_FIELDS = [
    ['address_matches', 'La dirección coincide', true],
    ['housing_verified', 'Vivienda verificada', true],
    ['residence_time_matches', 'Tiempo de residencia coincide', true],
    ['employment_verified', 'Empleo verificado', false],
    ['labor_reference_confirmed', 'Referencia laboral confirmada', false],
    ['personal_reference_confirmed', 'Referencia personal confirmada', false],
];
const CHANGE_FIELD_LABELS = {
    financing_type: 'Tipo de financiamiento',
    installments_count: 'Cuotas',
    proposed_price: 'Precio unitario',
    proposed_installment: 'Cuota de la línea',
    minimum_price_snapshot: 'Precio mínimo',
    minimum_installment_snapshot: 'Cuota mínima',
    proposed_down_payment: 'Enganche propuesto',
};

function isOwner(app, user) {
    return app?.created_by != null && Number(app.created_by) === Number(user?.id);
}

export default function CreditApplicationDetail() {
    const { id } = useParams();
    const { user, can } = useAuth();
    const [app, setApp] = useState(null);
    const [error, setError] = useState('');
    const [modal, setModal] = useState(null);
    const [evaluation, setEvaluation] = useState(null);

    const load = useCallback(async () => {
        try {
            const res = await creditsApi.get(id);
            setApp(res.data);
            setError('');
        } catch (e) {
            setError(e.message);
        }
    }, [id]);

    useEffect(() => {
        load();
    }, [load]);

    const canDecide = can('credits.decide');
    useEffect(() => {
        if (!app || !canDecide || !PRE_DECISION.includes(app.status)) return;
        creditsApi
            .evaluation(id)
            .then((res) => setEvaluation(res.data))
            .catch(() => setEvaluation(null));
    }, [app, canDecide, id]);

    if (error) return <p className="alert alert--error">{error}</p>;
    if (!app) return <Spinner />;
    if (app.out_of_scope) {
        return (
            <div className="page">
                <Link to="/creditos" className="link link--back">
                    ← Créditos
                </Link>
                <p className="alert">
                    La solicitud {app.application_number} está ahora en estado{' '}
                    <strong>{CREDIT_STATUS_LABELS[app.status]}</strong> y ya no está dentro de tu alcance.
                </p>
            </div>
        );
    }

    const exceptional = app.credit_type === 'EXCEPCIONAL_CONTADO';
    const items = app.items ?? [];
    const verifications = app.verifications ?? [];
    const lastVerification = verifications.at(-1);
    const done = (res) => {
        setModal(null);
        // Si la acción deja la solicitud fuera del alcance del usuario (p. ej. el
        // Cobrador la envía a evaluación), se muestra el resumen que devolvió el servidor.
        if (res?.data?.out_of_scope) setApp(res.data);
        else load();
    };

    const actions = {
        verify: can('credits.verify') && !exceptional && ['SOLICITADO', 'EN_VERIFICACION'].includes(app.status),
        conclude:
            can('credits.verify') &&
            app.status === 'EN_VERIFICACION' &&
            lastVerification &&
            lastVerification.result !== 'NECESITA_REVISION',
        // Decisión 2026-09-17: también después de aprobada (antes de concretar la
        // venta). Y el vendedor que la registró modifica la suya: si ya estaba
        // aprobada, su cambio la deja pendiente de la última revisión.
        modify:
            !exceptional &&
            [...PRE_DECISION, 'APROBADO'].includes(app.status) &&
            (canDecide || (can('credits.modify.own') && isOwner(app, user))),
        decide:
            canDecide &&
            (exceptional
                ? PRE_DECISION.includes(app.status)
                : app.status === 'EN_EVALUACION' && Boolean(app.verification_concluded_at)),
        cancel:
            (can('credits.cancel') && [...PRE_DECISION, 'APROBADO'].includes(app.status)) ||
            (can('credits.create') && isOwner(app, user) && PRE_DECISION.includes(app.status)),
        concretize:
            app.status === 'APROBADO' &&
            !app.requires_final_review &&
            (can('credits.concretize') || (can('credits.concretize.own') && isOwner(app, user))),
        // Última revisión: solo Administración y Gerencia, y solo si el vendedor
        // cambió las condiciones después de la aprobación.
        finalReview: can('credits.review.final') && app.status === 'APROBADO' && app.requires_final_review === true,
    };

    return (
        <div className="page">
            <div className="page__head">
                <div>
                    <Link to="/creditos" className="link link--back">
                        ← Créditos
                    </Link>
                    <h1>
                        Solicitud {app.application_number}{' '}
                        <Badge status={CREDIT_STATUS_BADGE[app.status]}>{CREDIT_STATUS_LABELS[app.status]}</Badge>
                    </h1>
                    <p className="page__sub">
                        {CREDIT_TYPE_LABELS[app.credit_type] ?? app.credit_type} ·{' '}
                        <Link className="link" to={`/clientes/${app.customer_id}`}>
                            {app.customer_full_name_snapshot}
                        </Link>{' '}
                        (DPI {app.customer_dpi_snapshot}) · {app.branch_name} · registrada {formatDateTime(app.created_at)}
                        {app.created_by_username ? ` por ${app.created_by_username}` : ''}
                    </p>
                </div>
                <div className="row-actions">
                    {actions.verify && (
                        <button className="btn btn--primary" onClick={() => setModal('verify')}>
                            Registrar verificación
                        </button>
                    )}
                    {actions.conclude && (
                        <button className="btn btn--primary" onClick={() => setModal('conclude')}>
                            Enviar a evaluación
                        </button>
                    )}
                    {actions.modify && (
                        <button className="btn btn--ghost" onClick={() => setModal('modify')}>
                            Modificar condiciones
                        </button>
                    )}
                    {actions.decide && (
                        <button className="btn btn--primary" onClick={() => setModal('decide')}>
                            Decidir
                        </button>
                    )}
                    {actions.finalReview && (
                        <button className="btn btn--primary" onClick={() => setModal('final-review')}>
                            Última revisión
                        </button>
                    )}
                    {actions.concretize && (
                        <button className="btn btn--primary" onClick={() => setModal('concretize')}>
                            Concretar venta
                        </button>
                    )}
                    {actions.cancel && (
                        <button className="btn btn--ghost" onClick={() => setModal('cancel')}>
                            Cancelar solicitud
                        </button>
                    )}
                </div>
            </div>

            {canDecide && app.status === 'EN_EVALUACION' && !app.verification_concluded_at && !exceptional && (
                <p className="alert">La verificación todavía no fue concluida por Cobranza; no se puede decidir.</p>
            )}

            <div className="cards">
                <div className="card card--static">
                    <span className="card__label">Total</span>
                    <strong className="card__value">{money(app.total)}</strong>
                </div>
                <div className="card card--static">
                    <span className="card__label">{app.actual_down_payment != null ? 'Enganche real' : 'Enganche propuesto'}</span>
                    <strong className="card__value">
                        {money(app.actual_down_payment != null ? app.actual_down_payment : app.proposed_down_payment)}
                    </strong>
                    {app.actual_down_payment != null && (
                        <span className="card__extra">Propuesto: {money(app.proposed_down_payment)}</span>
                    )}
                </div>
                <div className="card card--static">
                    <span className="card__label">Monto financiado</span>
                    <strong className="card__value">{money(app.financed_amount)}</strong>
                </div>
                <div className="card card--static">
                    <span className="card__label">Cuota</span>
                    <strong className="card__value">
                        {app.proposed_installment != null ? money(app.proposed_installment) : 'Consolidada'}
                    </strong>
                    <span className="card__extra">
                        {app.installments_count != null ? `${app.installments_count} cuota(s)` : 'Plazos distintos por línea'}
                    </span>
                </div>
            </div>

            {app.requires_final_review && (
                <p className="alert alert--warn">
                    Las condiciones se modificaron <strong>después de la aprobación</strong>. La solicitud sigue aprobada,
                    pero <strong>no se puede concretar</strong> hasta que Administración o Gerencia hagan la última
                    revisión
                    {app.final_review_requested_at ? ` (pendiente desde ${formatDateTime(app.final_review_requested_at)})` : ''}.
                </p>
            )}
            {app.status === 'VENTA_ANULADA' && (
                <p className="alert alert--error">
                    La venta de esta solicitud fue anulada
                    {app.sale_cancelled_at ? ` el ${formatDateTime(app.sale_cancelled_at)}` : ''}. La solicitud conserva
                    todo su historial y no se puede reutilizar: si el cliente vuelve, se registra una solicitud nueva.
                </p>
            )}
            {app.sale_id && app.sale_status === 'anulada' && app.status !== 'VENTA_ANULADA' && (
                <p className="alert alert--error">La venta de esta solicitud fue anulada.</p>
            )}
            {app.sale_id && (
                <p className="alert">
                    Venta concretada{app.concretized_at ? ` el ${formatDateTime(app.concretized_at)}` : ''}:{' '}
                    <Link className="link" to={`/ventas/${app.sale_id}`}>
                        ver venta, plan de pagos y pagos
                    </Link>
                </p>
            )}

            <section className="panel">
                <h2 className="panel__title">Productos y condiciones</h2>
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Producto</th>
                                <th className="center">Cant.</th>
                                <th>Plan</th>
                                <th className="right">Precio unit.</th>
                                <th className="right">Mínimo unit.</th>
                                <th className="right">Total línea</th>
                                <th className="right">Cuota línea</th>
                                <th className="right">Cuota mínima</th>
                            </tr>
                        </thead>
                        <tbody>
                            {items.map((i) => (
                                <tr key={i.id} className={i.is_void ? 'row--muted' : ''}>
                                    <td>
                                        <span className="mono">{i.product_code_snapshot}</span> {i.product_name_snapshot}
                                        {i.is_void && (
                                            <div className="muted small">
                                                Retirada{i.voided_at ? ` el ${formatDateTime(i.voided_at)}` : ''} — se conserva
                                                en el expediente y no cuenta en el total
                                            </div>
                                        )}
                                        {!i.is_void && i.requires_exception && (
                                            <div className="text-danger small">Bajo el mínimo: requiere autorización</div>
                                        )}
                                    </td>
                                    <td className="center">{i.quantity}</td>
                                    <td>
                                        {FINANCING_TYPE_LABELS[i.financing_type] ?? i.financing_type} · {i.installments_count}
                                    </td>
                                    <td className={`right ${i.requires_price_exception ? 'text-danger' : ''}`}>
                                        {money(i.proposed_unit_price)}
                                    </td>
                                    <td className="right muted">{money(i.minimum_unit_price)}</td>
                                    <td className="right strong">{money(i.line_total)}</td>
                                    <td className={`right ${i.requires_installment_exception ? 'text-danger' : ''}`}>
                                        {money(i.line_installment)}
                                    </td>
                                    <td className="right muted">{money(i.line_minimum_installment)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            {evaluation && <EvaluationPanel evaluation={evaluation} />}

            <VerificationsPanel verifications={verifications} app={app} />

            {(app.decision || (app.exceptions ?? []).length > 0) && <DecisionPanel app={app} />}

            <HistoryPanel app={app} />

            {modal === 'verify' && <VerificationModal app={app} onClose={() => setModal(null)} onSaved={done} />}
            {modal === 'conclude' && <ConcludeModal app={app} onClose={() => setModal(null)} onSaved={done} />}
            {modal === 'modify' && <ModifyModal app={app} onClose={() => setModal(null)} onSaved={done} />}
            {modal === 'decide' && <DecisionModal app={app} onClose={() => setModal(null)} onSaved={done} />}
            {modal === 'cancel' && <CancelModal app={app} onClose={() => setModal(null)} onSaved={done} />}
            {modal === 'concretize' && <ConcretizeModal app={app} onClose={() => setModal(null)} onSaved={done} />}
            {modal === 'final-review' && <FinalReviewModal app={app} onClose={() => setModal(null)} onSaved={done} />}
        </div>
    );
}

function EvaluationPanel({ evaluation }) {
    const history = evaluation.customer_history ?? {};
    const sales = history.sales ?? [];
    const applications = history.applications ?? [];
    return (
        <section className="panel">
            <h2 className="panel__title">Historial crediticio del cliente</h2>
            {history.account && (
                <p className="muted">
                    Estado de cuenta: <strong>{ACCOUNT_STATUS_LABELS[history.account.account_status] ?? '—'}</strong>
                    {history.account.balance != null ? ` · Saldo total ${money(history.account.balance)}` : ''}
                </p>
            )}
            {sales.length === 0 && applications.length === 0 ? (
                <p className="muted">Cliente sin ventas ni otras solicitudes registradas.</p>
            ) : (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Operación</th>
                                <th>Fecha</th>
                                <th>Modalidad / estado</th>
                                <th className="right">Total</th>
                                <th className="right">Saldo</th>
                                <th>Cuenta</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sales.map((s) => (
                                <tr key={`s${s.id}`}>
                                    <td>
                                        <Link className="link" to={`/ventas/${s.id}`}>
                                            Venta {s.sale_number}
                                        </Link>
                                    </td>
                                    <td>{formatDate(s.sale_date)}</td>
                                    <td>{PAYMENT_MODE_LABELS[s.payment_mode] ?? s.payment_mode}</td>
                                    <td className="right">{money(s.total)}</td>
                                    <td className="right">{money(s.balance)}</td>
                                    <td>
                                        <Badge status={s.account_status}>{ACCOUNT_STATUS_LABELS[s.account_status]}</Badge>
                                        {Number(s.installments_overdue) > 0 && (
                                            <span className="text-danger small"> · {s.installments_overdue} vencida(s)</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                            {applications.map((a) => (
                                <tr key={`a${a.id}`}>
                                    <td>
                                        <Link className="link" to={`/creditos/${a.id}`}>
                                            Solicitud {a.application_number}
                                        </Link>
                                    </td>
                                    <td>{formatDate(a.created_at)}</td>
                                    <td>{CREDIT_STATUS_LABELS[a.status] ?? a.status}</td>
                                    <td className="right">{money(a.total)}</td>
                                    <td className="right muted">—</td>
                                    <td className="muted">—</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

function VerificationsPanel({ verifications, app }) {
    return (
        <section className="panel">
            <h2 className="panel__title">Verificaciones</h2>
            {app.verification_concluded_at && (
                <p className="muted small">
                    Verificación concluida el {formatDateTime(app.verification_concluded_at)}.
                </p>
            )}
            {verifications.length === 0 ? (
                <p className="muted">Todavía no hay verificaciones registradas.</p>
            ) : (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Fecha</th>
                                <th>Cobrador</th>
                                <th>Resultado</th>
                                <th>Recomendación</th>
                                <th>Checklist</th>
                                <th>Comentarios</th>
                            </tr>
                        </thead>
                        <tbody>
                            {verifications.map((v) => (
                                <tr key={v.id}>
                                    <td className="nowrap">{formatDateTime(v.verification_date)}</td>
                                    <td>{v.verified_by_name || v.verified_by_username}</td>
                                    <td>{VERIFICATION_RESULT_LABELS[v.result] ?? v.result}</td>
                                    <td>{VERIFICATION_RESULT_LABELS[v.recommendation] ?? v.recommendation ?? '—'}</td>
                                    <td className="small">
                                        {CHECK_FIELDS.filter(([k]) => v[k])
                                            .map(([k, label]) => `${label}: ${CHECK_LABELS[v[k]] ?? v[k]}`)
                                            .join(' · ')}
                                        {v.latitude != null && (
                                            <div className="muted">
                                                Coordenadas: {v.latitude}, {v.longitude}
                                            </div>
                                        )}
                                    </td>
                                    <td className="small">{v.comments || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

function DecisionPanel({ app }) {
    const d = app.decision;
    const exceptions = app.exceptions ?? [];
    const itemName = (itemId) => app.items?.find((i) => Number(i.id) === Number(itemId))?.product_name_snapshot ?? `Línea ${itemId}`;
    return (
        <section className="panel">
            <h2 className="panel__title">Decisión</h2>
            {d && (
                <p>
                    <strong>{d.decision === 'APROBADO' ? 'Aprobado' : 'Rechazado'}</strong> por {d.decided_by_name || d.decided_by_username} el{' '}
                    {formatDateTime(d.decision_date)}
                    {d.decision_comment ? ` — ${d.decision_comment}` : ''}
                </p>
            )}
            {exceptions.length > 0 && (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Línea autorizada bajo el mínimo</th>
                                <th>Tipo</th>
                                <th className="right">Mínimo / propuesto</th>
                                <th className="right">Cuota mín. / prop.</th>
                                <th>Motivo</th>
                                <th>Origen</th>
                                <th>Autorizó</th>
                            </tr>
                        </thead>
                        <tbody>
                            {exceptions.map((e) => (
                                <tr key={e.id}>
                                    <td>{itemName(e.credit_application_item_id)}</td>
                                    <td>{e.exception_kind}</td>
                                    <td className="right">
                                        {money(e.minimum_unit_price)} / {money(e.proposed_unit_price)}
                                    </td>
                                    <td className="right">
                                        {money(e.minimum_line_installment)} / {money(e.proposed_line_installment)}
                                    </td>
                                    <td className="small">{e.reason}</td>
                                    <td className="small">
                                        {e.source === 'MODIFICACION' ? 'Modificación' : 'Decisión'} · {formatDateTime(e.created_at)}
                                    </td>
                                    <td>{e.authorized_by_username}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

function HistoryPanel({ app }) {
    const history = app.status_history ?? [];
    const changes = app.changes ?? [];
    const finalReviews = app.final_reviews ?? [];
    const itemName = (itemId) =>
        itemId == null ? 'Solicitud' : app.items?.find((i) => Number(i.id) === Number(itemId))?.product_name_snapshot ?? `Línea ${itemId}`;
    return (
        <section className="panel">
            <h2 className="panel__title">Historial</h2>
            {app.cancel_reason && (
                <p className="alert">
                    Cancelada{app.cancelled_at ? ` el ${formatDateTime(app.cancelled_at)}` : ''}: {app.cancel_reason}
                </p>
            )}
            <div className="table-wrap">
                <table className="table">
                    <thead>
                        <tr>
                            <th>Fecha</th>
                            <th>Cambio de estado</th>
                            <th>Usuario</th>
                            <th>Motivo</th>
                        </tr>
                    </thead>
                    <tbody>
                        {history.map((h) => (
                            <tr key={h.id}>
                                <td className="nowrap">{formatDateTime(h.changed_at)}</td>
                                <td>
                                    {h.from_status ? `${CREDIT_STATUS_LABELS[h.from_status] ?? h.from_status} → ` : ''}
                                    {CREDIT_STATUS_LABELS[h.to_status] ?? h.to_status}
                                </td>
                                <td>{h.changed_by_username ?? '—'}</td>
                                <td className="small">{h.reason || '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {finalReviews.length > 0 && (
                <>
                    <h3 className="panel__title">Últimas revisiones de Administración o Gerencia</h3>
                    <p className="muted small">
                        Revisión de los cambios hechos después de la aprobación. No son decisiones nuevas: la solicitud
                        conserva su única aprobación.
                    </p>
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Fecha</th>
                                    <th>Resultado</th>
                                    <th>Revisó</th>
                                    <th>Cambios de</th>
                                    <th>Comentario</th>
                                </tr>
                            </thead>
                            <tbody>
                                {finalReviews.map((r) => (
                                    <tr key={r.id}>
                                        <td className="nowrap">{formatDateTime(r.reviewed_at)}</td>
                                        <td>
                                            <Badge status={r.result === 'CONFIRMADO' ? 'pagada' : 'vencida'}>
                                                {r.result === 'CONFIRMADO' ? 'Confirmado' : 'Rechazado'}
                                            </Badge>
                                        </td>
                                        <td>{r.reviewed_by_username ?? '—'}</td>
                                        <td>{r.triggered_by_username ?? '—'}</td>
                                        <td className="small">{r.comment || '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
            {changes.length > 0 && (
                <>
                    <h3 className="panel__title">Modificaciones de condiciones</h3>
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Fecha</th>
                                    <th>Elemento</th>
                                    <th>Campo</th>
                                    <th>Anterior</th>
                                    <th>Nuevo</th>
                                    <th>Usuario</th>
                                    <th>Comentario</th>
                                </tr>
                            </thead>
                            <tbody>
                                {changes.map((c) => (
                                    <tr key={c.id}>
                                        <td className="nowrap">{formatDateTime(c.changed_at)}</td>
                                        <td>{itemName(c.credit_application_item_id)}</td>
                                        <td>{CHANGE_FIELD_LABELS[c.field] ?? c.field}</td>
                                        <td className="muted">{c.old_value ?? '—'}</td>
                                        <td className="strong">{c.new_value ?? '—'}</td>
                                        <td>{c.changed_by_username}</td>
                                        <td className="small">{c.comment || '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </section>
    );
}

function useSubmit(onSaved) {
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const [errors, setErrors] = useState({});
    async function run(fn, successMessage) {
        setBusy(true);
        setErrors({});
        try {
            const res = await fn();
            toast.success(res?.message || successMessage);
            onSaved(res);
        } catch (err) {
            setErrors(err.fieldErrors ?? {});
            toast.error(err.fullMessage ?? err.message);
        } finally {
            setBusy(false);
        }
    }
    return { busy, errors, run };
}

function FormActions({ busy, onClose, label, busyLabel, disabled = false }) {
    return (
        <div className="form-actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
                Cerrar
            </button>
            <button className="btn btn--primary" disabled={busy || disabled}>
                {busy ? busyLabel : label}
            </button>
        </div>
    );
}

function VerificationModal({ app, onClose, onSaved }) {
    const { busy, errors, run } = useSubmit(onSaved);
    const [form, setForm] = useState({
        result: 'FAVORABLE',
        recommendation: 'FAVORABLE',
        address_matches: 'SI',
        housing_verified: 'SI',
        residence_time_matches: 'SI',
        employment_verified: '',
        labor_reference_confirmed: '',
        personal_reference_confirmed: '',
        comments: '',
        latitude: '',
        longitude: '',
        conclude: false,
    });
    const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
    const needsReview = form.result === 'NECESITA_REVISION';

    function locate() {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition((pos) => {
            set('latitude', pos.coords.latitude.toFixed(6));
            set('longitude', pos.coords.longitude.toFixed(6));
        });
    }

    function submit(e) {
        e.preventDefault();
        const payload = {
            result: form.result,
            recommendation: form.recommendation,
            comments: form.comments,
            conclude: form.conclude && !needsReview,
        };
        for (const [k, , required] of CHECK_FIELDS) {
            if (required || form[k]) payload[k] = form[k];
        }
        if (form.latitude !== '' || form.longitude !== '') {
            payload.latitude = Number(form.latitude);
            payload.longitude = Number(form.longitude);
        }
        run(() => creditsApi.verify(app.id, payload), 'Verificación registrada');
    }

    return (
        <Modal open wide title={`Verificación — ${app.application_number}`} onClose={onClose}>
            <form onSubmit={submit}>
                <div className="form-grid">
                    <Field label="Resultado" required error={errors.result}>
                        <select className="input input--select" value={form.result} onChange={(e) => set('result', e.target.value)}>
                            {Object.entries(VERIFICATION_RESULT_LABELS).map(([k, label]) => (
                                <option key={k} value={k}>
                                    {label}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <Field label="Recomendación" required error={errors.recommendation}>
                        <select
                            className="input input--select"
                            value={form.recommendation}
                            onChange={(e) => set('recommendation', e.target.value)}
                        >
                            {Object.entries(VERIFICATION_RESULT_LABELS).map(([k, label]) => (
                                <option key={k} value={k}>
                                    {label}
                                </option>
                            ))}
                        </select>
                    </Field>
                    {CHECK_FIELDS.map(([k, label, required]) => (
                        <Field key={k} label={label} required={required} error={errors[k]}>
                            <select className="input input--select" value={form[k]} onChange={(e) => set(k, e.target.value)}>
                                {!required && <option value="">No aplica</option>}
                                {Object.entries(CHECK_LABELS).map(([v, l]) => (
                                    <option key={v} value={v}>
                                        {l}
                                    </option>
                                ))}
                            </select>
                        </Field>
                    ))}
                    <Field label="Latitud" error={errors.latitude}>
                        <input className="input" type="number" step="any" value={form.latitude} onChange={(e) => set('latitude', e.target.value)} />
                    </Field>
                    <Field label="Longitud" error={errors.longitude}>
                        <input className="input" type="number" step="any" value={form.longitude} onChange={(e) => set('longitude', e.target.value)} />
                    </Field>
                </div>
                <button type="button" className="btn btn--ghost btn--sm" onClick={locate}>
                    Usar mi ubicación actual
                </button>
                <Field label="Comentarios" error={errors.comments}>
                    <textarea className="input" rows={3} value={form.comments} onChange={(e) => set('comments', e.target.value)} />
                </Field>
                <label className="checkbox">
                    <input
                        type="checkbox"
                        checked={form.conclude && !needsReview}
                        disabled={needsReview}
                        onChange={(e) => set('conclude', e.target.checked)}
                    />{' '}
                    Concluir la verificación y enviar a evaluación
                </label>
                {needsReview && (
                    <p className="muted small">Con “Necesita revisión” la solicitud sigue en verificación.</p>
                )}
                <FormActions busy={busy} onClose={onClose} label="Guardar verificación" busyLabel="Guardando…" />
            </form>
        </Modal>
    );
}

function ConcludeModal({ app, onClose, onSaved }) {
    const { busy, run } = useSubmit(onSaved);
    const last = app.verifications?.at(-1);
    return (
        <Modal open title={`Enviar a evaluación — ${app.application_number}`} onClose={onClose}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    run(() => creditsApi.conclude(app.id), 'Verificación concluida');
                }}
            >
                <p>
                    Se concluirá la verificación con el último resultado registrado:{' '}
                    <strong>{VERIFICATION_RESULT_LABELS[last?.result] ?? '—'}</strong>. Después la solicitud pasa a
                    evaluación de Administración o Gerencia.
                </p>
                <FormActions busy={busy} onClose={onClose} label="Concluir" busyLabel="Enviando…" />
            </form>
        </Modal>
    );
}

function ModifyModal({ app, onClose, onSaved }) {
    const { busy, errors, run } = useSubmit(onSaved);
    const { can } = useAuth();
    const live = useMemo(() => (app.items ?? []).filter((i) => !i.is_void), [app]);
    const initial = useMemo(
        () =>
            Object.fromEntries(
                live.map((i) => [
                    i.id,
                    {
                        financing_type: i.financing_type,
                        installments_count: String(i.installments_count),
                        quantity: String(i.quantity),
                        proposed_price: Number(i.proposed_unit_price).toFixed(2),
                    },
                ])
            ),
        [live]
    );
    const [lines, setLines] = useState(initial);
    const [removed, setRemoved] = useState({});
    const [added, setAdded] = useState([]);
    const [downPayment, setDownPayment] = useState(Number(app.proposed_down_payment).toFixed(2));
    const [comment, setComment] = useState('');
    // Solo en APROBADO: líneas que la modificación deja bajo el mínimo (las informa el servidor).
    const [pendingExceptions, setPendingExceptions] = useState([]);
    const [reasons, setReasons] = useState({});
    const setLine = (id, k, v) => setLines((l) => ({ ...l, [id]: { ...l[id], [k]: v } }));
    const approved = app.status === 'APROBADO';
    const decider = can('credits.decide');

    const items = Object.entries(lines)
        .filter(([id]) => !removed[id])
        .map(([id, l]) => {
            const change = { item_id: Number(id) };
            const before = initial[id];
            if (!before) return change;
            if (l.financing_type !== before.financing_type) change.financing_type = l.financing_type;
            if (l.installments_count !== before.installments_count) change.installments_count = Number(l.installments_count);
            if (l.quantity !== before.quantity) change.quantity = Number(l.quantity);
            if (Number(l.proposed_price).toFixed(2) !== before.proposed_price) change.proposed_price = Number(l.proposed_price).toFixed(2);
            return change;
        })
        .filter((c) => Object.keys(c).length > 1);

    // `removed[id]` guarda el MOTIVO del retiro (cadena) o false si no se retira.
    const voidItems = Object.entries(removed)
        .filter(([, reason]) => reason !== false && reason !== undefined)
        .map(([id, reason]) => ({ item_id: Number(id), reason: String(reason).trim() }));

    const addItems = added.map((a) => ({
        product_id: a.product_id,
        quantity: Number(a.quantity),
        financing_type: a.financing_type,
        installments_count: Number(a.installments_count),
        proposed_price: Number(a.proposed_price).toFixed(2),
    }));

    const downChanged = Number(downPayment).toFixed(2) !== Number(app.proposed_down_payment).toFixed(2);
    const nothing = items.length === 0 && addItems.length === 0 && voidItems.length === 0 && !downChanged;
    const missingVoidReason = voidItems.some((v) => (v.reason ?? '').trim().length < 5);
    const missingAdd = added.some((a) => !a.product_id || Number(a.proposed_price) <= 0 || Number(a.quantity) < 1);
    const remainingLines = live.length - voidItems.length + addItems.length;
    const missingReason = pendingExceptions.some((x) => (reasons[x.item_id] ?? '').trim().length < 5);
    const missingComment = approved && comment.trim().length < 1;

    async function submit(e) {
        e.preventDefault();
        const payload = { items, add_items: addItems, void_items: voidItems, comment };
        if (downChanged) payload.proposed_down_payment = Number(downPayment).toFixed(2);
        if (pendingExceptions.length) {
            payload.exceptions = pendingExceptions.map((x) => ({ item_id: x.item_id, reason: reasons[x.item_id] }));
        }
        await run(async () => {
            try {
                return await creditsApi.modify(app.id, payload);
            } catch (err) {
                if (err.details?.reason === 'EXCEPTION_AUTHORIZATION_REQUIRED') {
                    setPendingExceptions(err.details.items ?? []);
                    const info = new Error(err.message);
                    info.fullMessage = err.message;
                    throw info;
                }
                throw err;
            }
        }, 'Condiciones modificadas');
    }

    return (
        <Modal open wide title={`Modificar condiciones — ${app.application_number}`} onClose={onClose}>
            <form onSubmit={submit}>
                <p className="muted small">
                    Cada cambio queda en el historial (valor anterior, nuevo, usuario, fecha y motivo). El mínimo se
                    recalcula con el plan elegido. Un producto retirado <strong>no se borra</strong>: se conserva en el
                    expediente y deja de contar en el total.
                </p>
                {approved && !decider && (
                    <p className="alert alert--warn">
                        La solicitud ya está aprobada. Si la modificas, la aprobación se conserva pero la venta queda
                        bloqueada hasta que Administración o Gerencia hagan la <strong>última revisión</strong>.
                    </p>
                )}
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Producto</th>
                                <th className="center">Cant.</th>
                                <th>Plan</th>
                                <th className="center">Cuotas</th>
                                <th className="right">Precio unitario (Q)</th>
                                <th>Retirar</th>
                            </tr>
                        </thead>
                        <tbody>
                            {live.map((i) => {
                                const off = Boolean(removed[i.id]);
                                return (
                                    <tr key={i.id} className={off ? 'row--muted' : ''}>
                                        <td>{i.product_name_snapshot}</td>
                                        <td className="center">
                                            <input
                                                className="input"
                                                type="number"
                                                min="1"
                                                max="9999"
                                                disabled={off}
                                                value={lines[i.id]?.quantity ?? ''}
                                                onChange={(e) => setLine(i.id, 'quantity', e.target.value)}
                                            />
                                        </td>
                                        <td>
                                            <select
                                                className="input input--select"
                                                disabled={off}
                                                value={lines[i.id]?.financing_type ?? 'PREDEFINIDO'}
                                                onChange={(e) => setLine(i.id, 'financing_type', e.target.value)}
                                            >
                                                <option value="PREDEFINIDO">{FINANCING_TYPE_LABELS.PREDEFINIDO}</option>
                                                <option value="ESPECIAL">{FINANCING_TYPE_LABELS.ESPECIAL}</option>
                                            </select>
                                        </td>
                                        <td className="center">
                                            <input
                                                className="input"
                                                type="number"
                                                min="1"
                                                max="120"
                                                disabled={off}
                                                value={lines[i.id]?.installments_count ?? ''}
                                                onChange={(e) => setLine(i.id, 'installments_count', e.target.value)}
                                            />
                                        </td>
                                        <td className="right">
                                            <input
                                                className="input"
                                                type="number"
                                                step="0.01"
                                                min="0.01"
                                                disabled={off}
                                                value={lines[i.id]?.proposed_price ?? ''}
                                                onChange={(e) => setLine(i.id, 'proposed_price', e.target.value)}
                                            />
                                        </td>
                                        <td>
                                            {off ? (
                                                <div className="stack-xs">
                                                    <input
                                                        className="input"
                                                        placeholder="Motivo del retiro"
                                                        value={typeof removed[i.id] === 'string' ? removed[i.id] : ''}
                                                        onChange={(e) =>
                                                            setRemoved((r) => ({ ...r, [i.id]: e.target.value }))
                                                        }
                                                    />
                                                    <button
                                                        type="button"
                                                        className="btn btn--ghost btn--sm"
                                                        onClick={() => setRemoved((r) => ({ ...r, [i.id]: false }))}
                                                    >
                                                        Deshacer
                                                    </button>
                                                </div>
                                            ) : (
                                                <button
                                                    type="button"
                                                    className="btn btn--ghost btn--sm"
                                                    disabled={remainingLines <= 1}
                                                    onClick={() => setRemoved((r) => ({ ...r, [i.id]: ' ' }))}
                                                >
                                                    Retirar
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                            {added.map((a, idx) => (
                                <tr key={`nuevo-${idx}`}>
                                    <td>
                                        {a.product_id ? (
                                            <>
                                                <span className="mono">{a.product_code}</span> {a.product_name}
                                            </>
                                        ) : (
                                            <CreditProductPicker
                                                onPick={(p) =>
                                                    setAdded((list) =>
                                                        list.map((x, k) =>
                                                            k === idx
                                                                ? { ...x, product_id: p.id, product_code: p.code, product_name: p.name }
                                                                : x
                                                        )
                                                    )
                                                }
                                            />
                                        )}
                                    </td>
                                    <td className="center">
                                        <input
                                            className="input"
                                            type="number"
                                            min="1"
                                            value={a.quantity}
                                            onChange={(e) =>
                                                setAdded((l) => l.map((x, k) => (k === idx ? { ...x, quantity: e.target.value } : x)))
                                            }
                                        />
                                    </td>
                                    <td>
                                        <select
                                            className="input input--select"
                                            value={a.financing_type}
                                            onChange={(e) =>
                                                setAdded((l) => l.map((x, k) => (k === idx ? { ...x, financing_type: e.target.value } : x)))
                                            }
                                        >
                                            <option value="PREDEFINIDO">{FINANCING_TYPE_LABELS.PREDEFINIDO}</option>
                                            <option value="ESPECIAL">{FINANCING_TYPE_LABELS.ESPECIAL}</option>
                                        </select>
                                    </td>
                                    <td className="center">
                                        <input
                                            className="input"
                                            type="number"
                                            min="1"
                                            max="120"
                                            value={a.installments_count}
                                            onChange={(e) =>
                                                setAdded((l) => l.map((x, k) => (k === idx ? { ...x, installments_count: e.target.value } : x)))
                                            }
                                        />
                                    </td>
                                    <td className="right">
                                        <input
                                            className="input"
                                            type="number"
                                            step="0.01"
                                            min="0.01"
                                            value={a.proposed_price}
                                            onChange={(e) =>
                                                setAdded((l) => l.map((x, k) => (k === idx ? { ...x, proposed_price: e.target.value } : x)))
                                            }
                                        />
                                    </td>
                                    <td>
                                        <button
                                            type="button"
                                            className="btn btn--ghost btn--sm"
                                            onClick={() => setAdded((l) => l.filter((_, k) => k !== idx))}
                                        >
                                            Quitar
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() =>
                        setAdded((l) => [
                            ...l,
                            { product_id: null, quantity: '1', financing_type: 'PREDEFINIDO', installments_count: '12', proposed_price: '' },
                        ])
                    }
                >
                    Agregar producto
                </button>
                {errors.items && <p className="text-danger small">{errors.items}</p>}
                {errors.add_items && <p className="text-danger small">{errors.add_items}</p>}
                {errors.void_items && <p className="text-danger small">{errors.void_items}</p>}
                {approved && (
                    <p className="muted small">
                        La solicitud está aprobada: la aprobación se conserva y no hay una segunda decisión. Si un cambio
                        deja una línea bajo el mínimo, se pedirá autorizarla con su motivo.
                    </p>
                )}
                {pendingExceptions.map((x) => (
                    <Field
                        key={x.item_id}
                        required
                        label={`Autorizar ${x.producto}: precio ${money(x.precio_propuesto)} (mín. ${money(x.precio_minimo)}), cuota ${money(x.cuota_propuesta)} (mín. ${money(x.cuota_minima)})`}
                    >
                        <input
                            className="input"
                            placeholder="Motivo de la autorización"
                            value={reasons[x.item_id] ?? ''}
                            onChange={(e) => setReasons((r) => ({ ...r, [x.item_id]: e.target.value }))}
                        />
                    </Field>
                ))}
                <Field label="Enganche propuesto (Q)" error={errors.proposed_down_payment} hint="No es un pago; debe ser menor al total">
                    <input className="input" type="number" step="0.01" min="0" value={downPayment} onChange={(e) => setDownPayment(e.target.value)} />
                </Field>
                <Field
                    label="Motivo del cambio"
                    required={approved}
                    error={errors.comment}
                    hint={approved ? 'Obligatorio al modificar una solicitud aprobada' : undefined}
                >
                    <input className="input" value={comment} onChange={(e) => setComment(e.target.value)} />
                </Field>
                <FormActions
                    busy={busy}
                    onClose={onClose}
                    label="Guardar cambios"
                    busyLabel="Guardando…"
                    disabled={nothing || missingReason || missingVoidReason || missingAdd || missingComment}
                />
            </form>
        </Modal>
    );
}

/**
 * ÚLTIMA REVISIÓN (Administración / Gerencia).
 * No es una segunda decisión: confirma o rechaza los cambios que el vendedor
 * hizo después de la aprobación. Mientras no se confirme, no hay venta.
 */
function FinalReviewModal({ app, onClose, onSaved }) {
    const { busy, errors, run } = useSubmit(onSaved);
    const [result, setResult] = useState('CONFIRMADO');
    const [comment, setComment] = useState('');
    const [reasons, setReasons] = useState({});
    const confirming = result === 'CONFIRMADO';
    const exceptionLines = (app.items ?? []).filter((i) => !i.is_void && i.requires_exception);
    const missingReason = confirming && exceptionLines.some((i) => (reasons[i.id] ?? '').trim().length < 5);
    const missingComment = !confirming && comment.trim().length < 5;
    const changes = (app.changes ?? []).filter((c) => c.changed_at >= (app.final_review_requested_at ?? ''));

    function submit(e) {
        e.preventDefault();
        const payload = { result, comment };
        payload.exceptions = confirming ? exceptionLines.map((i) => ({ item_id: Number(i.id), reason: reasons[i.id] })) : [];
        run(
            () => creditsApi.finalReview(app.id, payload),
            confirming ? 'Cambios confirmados: la venta ya se puede concretar' : 'Cambios rechazados'
        );
    }

    return (
        <Modal open wide title={`Última revisión — ${app.application_number}`} onClose={onClose}>
            <form onSubmit={submit}>
                <p className="muted small">
                    El vendedor modificó las condiciones después de la aprobación. Esto <strong>no</strong> es una
                    segunda decisión: la solicitud sigue aprobada y conserva su decisión original. Solo confirmas o
                    rechazas los cambios.
                </p>
                <div className="row-actions">
                    <label className="checkbox">
                        <input type="radio" name="final-review" checked={confirming} onChange={() => setResult('CONFIRMADO')} />{' '}
                        Confirmar (la venta se podrá concretar)
                    </label>
                    <label className="checkbox">
                        <input type="radio" name="final-review" checked={!confirming} onChange={() => setResult('RECHAZADO')} />{' '}
                        Rechazar (la venta sigue bloqueada)
                    </label>
                </div>
                <p className="muted small">
                    Total {money(app.total)} · Enganche propuesto {money(app.proposed_down_payment)} · Financiado{' '}
                    {money(app.financed_amount)}
                </p>
                {changes.length > 0 && (
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Cambio</th>
                                    <th>Antes</th>
                                    <th>Ahora</th>
                                    <th>Quién</th>
                                </tr>
                            </thead>
                            <tbody>
                                {changes.map((c) => (
                                    <tr key={c.id}>
                                        <td>{c.field}</td>
                                        <td className="muted">{c.old_value ?? '—'}</td>
                                        <td className="strong">{c.new_value ?? '—'}</td>
                                        <td>{c.changed_by_username}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {confirming &&
                    exceptionLines.map((i) => (
                        <Field
                            key={i.id}
                            required
                            label={`Autorizar ${i.product_name_snapshot}: precio ${money(i.proposed_unit_price)} (mín. ${money(i.minimum_unit_price)}), cuota ${money(i.line_installment)} (mín. ${money(i.line_minimum_installment)})`}
                        >
                            <input
                                className="input"
                                placeholder="Motivo de la autorización"
                                value={reasons[i.id] ?? ''}
                                onChange={(e) => setReasons((r) => ({ ...r, [i.id]: e.target.value }))}
                            />
                        </Field>
                    ))}
                <Field label="Comentario" required={!confirming} error={errors.comment}>
                    <input className="input" value={comment} onChange={(e) => setComment(e.target.value)} />
                </Field>
                <FormActions
                    busy={busy}
                    onClose={onClose}
                    label={confirming ? 'Confirmar cambios' : 'Rechazar cambios'}
                    busyLabel="Guardando…"
                    disabled={missingReason || missingComment}
                />
            </form>
        </Modal>
    );
}

function DecisionModal({ app, onClose, onSaved }) {
    const { busy, errors, run } = useSubmit(onSaved);
    const [decision, setDecision] = useState('APROBADO');
    const [comment, setComment] = useState('');
    const exceptionLines = (app.items ?? []).filter((i) => i.requires_exception);
    const [reasons, setReasons] = useState({});
    const approving = decision === 'APROBADO';
    const missingReason = approving && exceptionLines.some((i) => (reasons[i.id] ?? '').trim().length < 5);
    const missingComment = !approving && comment.trim().length < 5;

    function submit(e) {
        e.preventDefault();
        const payload = { decision, comment };
        payload.exceptions = approving ? exceptionLines.map((i) => ({ item_id: Number(i.id), reason: reasons[i.id] })) : [];
        run(() => creditsApi.decide(app.id, payload), approving ? 'Solicitud aprobada' : 'Solicitud rechazada');
    }

    return (
        <Modal open wide title={`Decisión — ${app.application_number}`} onClose={onClose}>
            <form onSubmit={submit}>
                <div className="row-actions">
                    <label className="checkbox">
                        <input type="radio" name="decision" checked={approving} onChange={() => setDecision('APROBADO')} /> Aprobar
                    </label>
                    <label className="checkbox">
                        <input type="radio" name="decision" checked={!approving} onChange={() => setDecision('RECHAZADO')} /> Rechazar
                        (definitivo)
                    </label>
                </div>
                <p className="muted small">
                    Total {money(app.total)} · Enganche propuesto {money(app.proposed_down_payment)} · Financiado{' '}
                    {money(app.financed_amount)}
                </p>
                {approving && exceptionLines.length > 0 && (
                    <>
                        <p className="alert">
                            Estas líneas están por debajo del mínimo. Aprobar implica autorizar la excepción de cada una con su
                            motivo.
                        </p>
                        {exceptionLines.map((i) => (
                            <Field
                                key={i.id}
                                required
                                label={`${i.product_name_snapshot}: ${money(i.proposed_unit_price)} (mín. ${money(i.minimum_unit_price)}), cuota ${money(i.line_installment)} (mín. ${money(i.line_minimum_installment)})`}
                            >
                                <input
                                    className="input"
                                    placeholder="Motivo de la autorización"
                                    value={reasons[i.id] ?? ''}
                                    onChange={(e) => setReasons((r) => ({ ...r, [i.id]: e.target.value }))}
                                />
                            </Field>
                        ))}
                    </>
                )}
                {errors.exceptions && <p className="text-danger small">{errors.exceptions}</p>}
                <Field label={approving ? 'Comentario' : 'Razón del rechazo'} required={!approving} error={errors.comment}>
                    <textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
                </Field>
                <FormActions
                    busy={busy}
                    onClose={onClose}
                    label={approving ? 'Aprobar' : 'Rechazar'}
                    busyLabel="Guardando…"
                    disabled={missingReason || missingComment}
                />
            </form>
        </Modal>
    );
}

function CancelModal({ app, onClose, onSaved }) {
    const { busy, errors, run } = useSubmit(onSaved);
    const [reason, setReason] = useState('');
    return (
        <Modal open title={`Cancelar solicitud ${app.application_number}`} onClose={onClose}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    run(() => creditsApi.cancel(app.id, reason), 'Solicitud cancelada');
                }}
            >
                <p className="muted">La cancelación es definitiva y queda registrada en el historial.</p>
                <Field label="Motivo" required error={errors.reason}>
                    <textarea className="input" rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <FormActions busy={busy} onClose={onClose} label="Cancelar solicitud" busyLabel="Cancelando…" disabled={reason.trim().length < 5} />
            </form>
        </Modal>
    );
}

function ConcretizeModal({ app, onClose, onSaved }) {
    const exceptional = app.credit_type === 'EXCEPCIONAL_CONTADO';
    const { busy, errors, run } = useSubmit(onSaved);
    const [downPayment, setDownPayment] = useState(exceptional ? '0.00' : Number(app.proposed_down_payment).toFixed(2));
    const [method, setMethod] = useState('efectivo');
    const [reference, setReference] = useState('');
    const [notes, setNotes] = useState('');
    const value = Number(downPayment) || 0;
    const approved = Number(app.proposed_down_payment);
    const total = Number(app.total);
    const invalid = value < 0 || value > approved || value >= total;

    function submit(e) {
        e.preventDefault();
        const payload = { down_payment: value.toFixed(2), notes };
        if (value > 0) {
            payload.payment_method = method;
            if (reference) payload.payment_reference = reference;
        }
        run(() => creditsApi.concretize(app.id, payload), 'Venta concretada y crédito activo');
    }

    return (
        <Modal open title={`Concretar venta — ${app.application_number}`} onClose={onClose}>
            <form onSubmit={submit}>
                <p className="muted">
                    Se creará la venta a crédito con los precios aprobados, se descontará el inventario de{' '}
                    <strong>{app.branch_name}</strong> y se generarán las cuotas mensuales (la primera vence dentro de un mes).
                </p>
                <p className="muted small">
                    Total {money(total)} · Enganche aprobado {money(approved)}
                </p>
                <Field
                    label="Enganche real recibido (Q)"
                    required
                    error={errors.down_payment}
                    hint={exceptional ? 'El crédito excepcional no lleva enganche' : 'Puede ser menor al aprobado; Q0 si no se recibe'}
                >
                    <input
                        className="input"
                        type="number"
                        step="0.01"
                        min="0"
                        max={approved}
                        disabled={exceptional}
                        value={downPayment}
                        onChange={(e) => setDownPayment(e.target.value)}
                    />
                </Field>
                {value > approved && <p className="text-danger small">El enganche real no puede superar el aprobado.</p>}
                {value > 0 && (
                    <>
                        <Field label="Método de pago del enganche" required error={errors.payment_method}>
                            <select className="input input--select" value={method} onChange={(e) => setMethod(e.target.value)}>
                                {Object.entries(METHOD_LABELS).map(([k, label]) => (
                                    <option key={k} value={k}>
                                        {label}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Referencia" error={errors.payment_reference} hint="Número de boleta o transacción">
                            <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
                        </Field>
                    </>
                )}
                <Field label="Observaciones" error={errors.notes}>
                    <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>
                <FormActions busy={busy} onClose={onClose} label="Concretar venta" busyLabel="Concretando…" disabled={invalid} />
            </form>
        </Modal>
    );
}
