/**
 * PUENTE DE INTEGRACIÓN CON n8n — patrón OUTBOX.
 *
 * Principio irrenunciable del proyecto: la aplicación NO depende de n8n.
 *   1. La operación comercial se persiste en su transacción.
 *   2. En esa MISMA transacción se inserta el evento en `integration_events`.
 *   3. El envío al webhook ocurre DESPUÉS del commit, de forma asíncrona.
 *
 * Si n8n está caído, el evento queda 'pendiente'/'fallido' y se puede
 * reintentar; registrar un cliente, una venta o un pago nunca falla por eso.
 *
 * El despacho real se activa en la fase de integración (N8N_DISPATCH_ENABLED).
 */
import { query } from '../config/db.js';
import { config } from '../config/env.js';

export const EVENT_TYPES = Object.freeze({
    CUSTOMER_CREATED: 'customer.created',
    CUSTOMER_UPDATED: 'customer.updated',
    SALE_CREATED: 'sale.created',
    SALE_PAID: 'sale.paid',
    SALE_CANCELLED: 'sale.cancelled',
    PAYMENT_CREATED: 'payment.created',
    INSTALLMENT_UPCOMING: 'installment.upcoming',
    INSTALLMENT_OVERDUE: 'installment.overdue',
});

/**
 * Registra un evento. Si se pasa `client`, se inserta dentro de la
 * transacción en curso (atómico con la operación de negocio).
 */
export async function recordEvent({ type, aggregate, aggregateId, payload }, client = null) {
    const runner = client ?? { query };
    const { rows } = await runner.query(
        `INSERT INTO integration_events (event_type, aggregate, aggregate_id, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id, event_type, status, created_at`,
        [type, aggregate, aggregateId, JSON.stringify(payload ?? {})]
    );
    return rows[0];
}

/**
 * Intenta enviar los eventos pendientes al webhook de n8n.
 * Se llama de forma "fire and forget" después del commit y nunca propaga
 * errores hacia la petición HTTP del usuario.
 */
export async function dispatchPending(limit = 20) {
    if (!config.n8n.dispatchEnabled) return { dispatched: 0, skipped: true };

    const { rows } = await query(
        `SELECT id, event_type, aggregate, aggregate_id, payload
           FROM integration_events
          WHERE status IN ('pendiente', 'fallido') AND attempts < 5
          ORDER BY created_at
          LIMIT $1`,
        [limit]
    );

    let dispatched = 0;
    for (const event of rows) {
        try {
            const response = await fetch(config.n8n.webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(config.n8n.webhookSecret ? { 'X-Webhook-Secret': config.n8n.webhookSecret } : {}),
                },
                body: JSON.stringify({
                    id: event.id,
                    event: event.event_type,
                    aggregate: event.aggregate,
                    aggregate_id: event.aggregate_id,
                    data: event.payload,
                    emitted_at: new Date().toISOString(),
                }),
                signal: AbortSignal.timeout(8000),
            });

            if (!response.ok) throw new Error(`n8n respondió ${response.status}`);

            await query(
                `UPDATE integration_events
                    SET status = 'enviado', sent_at = now(), attempts = attempts + 1, last_error = NULL
                  WHERE id = $1`,
                [event.id]
            );
            dispatched += 1;
        } catch (error) {
            await query(
                `UPDATE integration_events
                    SET status = 'fallido', attempts = attempts + 1, last_error = $2
                  WHERE id = $1`,
                [event.id, String(error.message).slice(0, 500)]
            );
        }
    }
    return { dispatched, skipped: false };
}

/** Dispara el despacho sin bloquear la respuesta HTTP. */
export function dispatchInBackground() {
    if (!config.n8n.dispatchEnabled) return;
    dispatchPending().catch((err) => console.error('[n8n] fallo al despachar:', err.message));
}
