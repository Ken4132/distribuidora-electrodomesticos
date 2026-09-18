import { useEffect, useState } from 'react';
import { paymentsApi } from '../services/api.js';
import { Modal, Spinner } from './ui.jsx';
import { formatDate, formatDateTime, METHOD_LABELS, money, VOUCHER_STATUS_LABELS } from '../utils/format.js';

/**
 * RECIBO INMUTABLE de un pago (bloque 4.3).
 *
 * Todo lo que se muestra viene de `GET /api/payments/:id/receipt`: aquí no se
 * recalcula ni un número. Lo que el recibo congeló (monto, saldos, reparto de
 * cuotas) se muestra tal cual; el estado VIVO del pago —si después se anuló,
 * en qué depósito acabó— se muestra aparte para no confundirlos.
 */
export function ReceiptModal({ paymentId, onClose }) {
    const [state, setState] = useState({ loading: true, receipt: null, error: '' });

    useEffect(() => {
        let alive = true;
        setState({ loading: true, receipt: null, error: '' });
        paymentsApi
            .receipt(paymentId)
            .then((r) => alive && setState({ loading: false, receipt: r.data, error: '' }))
            .catch((e) => alive && setState({ loading: false, receipt: null, error: e.message }));
        return () => {
            alive = false;
        };
    }, [paymentId]);

    const r = state.receipt;

    return (
        <Modal open title={r ? `Recibo ${r.receipt_number}` : 'Recibo'} onClose={onClose} wide>
            {state.loading ? (
                <Spinner label="Buscando el recibo…" />
            ) : state.error ? (
                <p className="alert alert--error">{state.error}</p>
            ) : (
                <div className="receipt">
                    {r.payment_status === 'anulado' && (
                        <p className="alert alert--warn">
                            El pago que documenta este recibo fue <strong>ANULADO</strong>
                            {r.voided_at ? ` el ${formatDateTime(r.voided_at)}` : ''}
                            {r.voided_by_username ? ` por ${r.voided_by_username}` : ''}.
                            {r.void_reason ? ` Motivo: ${r.void_reason}` : ''} El recibo se conserva sin cambios.
                        </p>
                    )}

                    {/* El recibo se presenta como documento, no como formulario:
                        correlativo arriba, cifras en el centro, detalle abajo. */}
                    <div className="receipt__doc">
                        <div className="receipt__head">
                            <div>
                                <span className="stat__label">Recibo de pago</span>
                                <div className="receipt__no">{r.receipt_number}</div>
                                <span className="muted small">Emitido {formatDateTime(r.issued_at)}</span>
                            </div>
                            <div className="right">
                                <span className="stat__label">Cliente</span>
                                <div className="strong">{r.customer_name}</div>
                                <span className="muted small mono">DPI {r.customer_dpi}</span>
                            </div>
                        </div>

                        <div className="receipt__body">
                            <div className="figures">
                                <div className="figure">
                                    <span className="figure__label">Saldo anterior</span>
                                    <span className="figure__value">{money(r.balance_before)}</span>
                                </div>
                                <span className="figures__op" aria-hidden="true">
                                    −
                                </span>
                                <div className="figure figure--main">
                                    <span className="figure__label">Monto pagado</span>
                                    <span className="figure__value">{money(r.amount)}</span>
                                </div>
                                <span className="figures__op" aria-hidden="true">
                                    =
                                </span>
                                <div className="figure figure--result">
                                    <span className="figure__label">Saldo nuevo</span>
                                    <span className="figure__value">{money(r.balance_after)}</span>
                                </div>
                            </div>

                            <dl className="datalist">
                                <div>
                                    <dt>Fecha del pago</dt>
                                    <dd>{formatDate(r.payment_date)}</dd>
                                </div>
                                <div>
                                    <dt>Venta</dt>
                                    <dd className="mono">{r.sale_number}</dd>
                                </div>
                                <div>
                                    <dt>Método</dt>
                                    <dd>
                                        {METHOD_LABELS[r.method] ?? r.method}
                                        {r.snapshot?.reference ? ` · ${r.snapshot.reference}` : ''}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Sucursal</dt>
                                    <dd>{r.branch_name || '—'}</dd>
                                </div>
                                <div>
                                    <dt>Registró</dt>
                                    <dd>{r.issued_by_username || '—'}</dd>
                                </div>
                                <div>
                                    <dt>Comprobante</dt>
                                    <dd>{VOUCHER_STATUS_LABELS[r.voucher_status] ?? '—'}</dd>
                                </div>
                                {r.current_deposit_number && (
                                    <div>
                                        <dt>Depósito</dt>
                                        <dd className="mono">{r.current_deposit_number}</dd>
                                    </div>
                                )}
                            </dl>

                            <h3 className="panel__title">Cuotas afectadas</h3>
                            <AllocationsTable allocations={r.allocations} />
                        </div>
                    </div>
                </div>
            )}
            <div className="form-actions">
                <button type="button" className="btn btn--ghost" onClick={onClose}>
                    Cerrar
                </button>
            </div>
        </Modal>
    );
}

/**
 * Reparto del pago entre cuotas, tal como lo resolvió el backend (FIFO).
 * El frontend NO decide nada aquí: solo muestra lo que vino.
 */
export function AllocationsTable({ allocations = [] }) {
    if (!allocations.length) return <p className="muted">Sin cuotas afectadas.</p>;
    return (
        <div className="table-wrap">
            <table className="table">
                <thead>
                    <tr>
                        <th className="center">Cuota</th>
                        <th>Vence</th>
                        <th className="right">Aplicado</th>
                    </tr>
                </thead>
                <tbody>
                    {allocations.map((a, i) => (
                        <tr key={a.installment_id ?? i}>
                            <td className="center mono">{a.installment_number}</td>
                            <td>{a.due_date ? formatDate(a.due_date) : '—'}</td>
                            <td className="right strong">{money(a.amount)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
