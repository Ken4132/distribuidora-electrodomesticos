import { query } from '../config/db.js';

export async function list({ customerId = null, saleId = null, from = null, to = null, page = 1, pageSize = 20 }) {
    const filters = ["p.status = 'aplicado'"];
    const params = [];

    if (customerId) {
        params.push(customerId);
        filters.push(`p.customer_id = $${params.length}`);
    }
    if (saleId) {
        params.push(saleId);
        filters.push(`p.sale_id = $${params.length}`);
    }
    if (from) {
        params.push(from);
        filters.push(`p.payment_date >= $${params.length}`);
    }
    if (to) {
        params.push(to);
        filters.push(`p.payment_date <= $${params.length}`);
    }

    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT p.id,
                'P-' || LPAD(p.id::text, 6, '0') AS receipt_number,
                p.sale_id,
                'V-' || LPAD(p.sale_id::text, 6, '0') AS sale_number,
                p.customer_id, c.full_name AS customer_name, c.dpi AS customer_dpi,
                p.payment_date, p.amount, p.method, p.reference, p.notes, p.status, p.voucher_status,
                p.created_at, u.username AS created_by,
                COUNT(*) OVER()::int AS total_count
           FROM payments p
           JOIN customers c ON c.id = p.customer_id
           LEFT JOIN users u ON u.id = p.created_by
          WHERE ${filters.join(' AND ')}
       ORDER BY p.payment_date DESC, p.id DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    const total = rows[0]?.total_count ?? 0;
    return {
        data: rows.map(({ total_count, ...p }) => p),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
}

export async function findById(id) {
    const { rows } = await query(
        `SELECT p.*, 'P-' || LPAD(p.id::text, 6, '0') AS receipt_number,
                c.full_name AS customer_name, c.dpi AS customer_dpi
           FROM payments p JOIN customers c ON c.id = p.customer_id
          WHERE p.id = $1`,
        [id]
    );
    return rows[0] ?? null;
}

export async function createPayment(client, data) {
    const { rows } = await client.query(
        `INSERT INTO payments (sale_id, customer_id, payment_date, amount, method, reference, notes, created_by,
                               voucher_status, client_request_id, request_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, sale_id, customer_id, payment_date, amount, method, reference, notes, status,
                   voucher_status, created_at`,
        [
            data.sale_id,
            data.customer_id,
            data.payment_date,
            data.amount,
            data.method,
            data.reference ?? null,
            data.notes ?? null,
            data.created_by ?? null,
            data.voucher_status ?? null,
            data.client_request_id ?? null,
            data.request_fingerprint ?? null,
        ]
    );
    return rows[0];
}

/** Primer evento documental del pago (y los siguientes, en 4.2). */
export async function recordVoucherEvent(client, event) {
    await client.query(
        `INSERT INTO payment_voucher_events (payment_id, from_status, to_status, action, actor_id, comment)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
            event.paymentId,
            event.fromStatus ?? null,
            event.toStatus,
            event.action,
            event.actorId ?? null,
            event.comment ?? null,
        ]
    );
}

/**
 * Pago ya registrado con esta clave de idempotencia por este usuario.
 * Mismo patrón que `creditApplication.model.findByRequestKey` (migración 007).
 */
export async function findByRequestKey(userId, clientRequestId, db = { query }) {
    const { rows } = await db.query(
        `SELECT id, sale_id, request_fingerprint
           FROM payments
          WHERE created_by = $1 AND client_request_id = $2`,
        [userId, clientRequestId]
    );
    return rows[0] ?? null;
}

/**
 * ¿Es este el ÚLTIMO pago aplicado de su venta?
 *
 * "Último" es el de mayor identificador entre los aplicados, que es el orden
 * real de aplicación del FIFO; no el de fecha más reciente, porque la fecha
 * económica puede venir atrasada a propósito.
 *
 * Devuelve el pago junto con el identificador del posterior que lo bloquea,
 * si existe. Se consulta con la venta ya bloqueada por el servicio.
 */
export async function lastAppliedCheck(client, paymentId) {
    const { rows } = await client.query(
        `SELECT p.id, p.sale_id, p.status, p.amount,
                (SELECT MAX(o.id) FROM payments o
                  WHERE o.sale_id = p.sale_id AND o.status = 'aplicado' AND o.id > p.id) AS blocking_id
           FROM payments p
          WHERE p.id = $1`,
        [paymentId]
    );
    return rows[0] ?? null;
}

export async function allocate(client, paymentId, installmentId, amount) {
    const { rows } = await client.query(
        `INSERT INTO payment_allocations (payment_id, installment_id, amount)
         VALUES ($1,$2,$3) RETURNING id, installment_id, amount`,
        [paymentId, installmentId, amount]
    );
    return rows[0];
}

/**
 * Cuotas pendientes de una venta, con bloqueo de fila (FOR UPDATE) sobre la
 * tabla base para impedir que dos pagos simultáneos se apliquen a la misma
 * cuota y generen sobrepago.
 */
export async function lockPendingInstallments(client, saleId) {
    await client.query(
        `SELECT i.id FROM installments i WHERE i.sale_id = $1 ORDER BY i.number FOR UPDATE`,
        [saleId]
    );
    // `NOT is_superseded`: una cuota que una reestructuración sustituyó (bloque
    // 5) conserva su historial pero ya no es deuda viva, así que no vuelve a
    // recibir dinero. Mientras no haya reestructuraciones no excluye ninguna.
    const { rows } = await client.query(
        `SELECT id, number, due_date, amount, paid_amount, balance, status
           FROM v_installments
          WHERE sale_id = $1 AND balance > 0 AND NOT is_superseded
       ORDER BY number`,
        [saleId]
    );
    return rows;
}

export async function voidPayment(client, paymentId, reason, userId = null) {
    const { rows } = await client.query(
        `UPDATE payments
            SET status = 'anulado', voided_at = now(), void_reason = $2, voided_by = $3
          WHERE id = $1 AND status = 'aplicado'
         RETURNING id, sale_id, customer_id, amount, voided_at`,
        [paymentId, reason ?? null, userId]
    );
    return rows[0] ?? null;
}

/** ¿El pago forma parte de un depósito? (no lo saca de él: solo informa). */
export async function depositOf(client, paymentId) {
    const { rows } = await client.query(
        `SELECT d.id, d.status, d.reference, 'D-' || LPAD(d.id::text, 6, '0') AS deposit_number
           FROM deposit_payments dp
           JOIN deposits d ON d.id = dp.deposit_id
          WHERE dp.payment_id = $1`,
        [paymentId]
    );
    return rows[0] ?? null;
}
