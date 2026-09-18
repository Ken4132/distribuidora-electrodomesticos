/**
 * ACCESO A DATOS DE DEPÓSITOS (bloque 4.2).
 *
 * Todo lo que se consulta sale de `v_deposits`, que es donde vive el cálculo
 * de la conciliación. Aquí no se recalcula nada: si el número se pudiera
 * obtener de la vista, no se copia a mano.
 */
import { query } from '../config/db.js';

const NUMBER = (alias) => `'D-' || LPAD(${alias}.id::text, 6, '0')`;

export async function list({
    status = '',
    branchId = null,
    from = null,
    to = null,
    withDifference = null,
    page = 1,
    pageSize = 20,
}) {
    const filters = [];
    const params = [];

    if (status) {
        params.push(status);
        filters.push(`status = $${params.length}`);
    }
    if (branchId) {
        params.push(branchId);
        filters.push(`branch_id = $${params.length}`);
    }
    if (from) {
        params.push(from);
        filters.push(`deposit_date >= $${params.length}`);
    }
    if (to) {
        params.push(to);
        filters.push(`deposit_date <= $${params.length}`);
    }
    if (withDifference !== null) {
        filters.push(withDifference ? 'has_difference' : 'NOT has_difference');
    }

    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT *, COUNT(*) OVER()::int AS total_count
           FROM v_deposits
          ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
       ORDER BY deposit_date DESC, id DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    const total = rows[0]?.total_count ?? 0;
    return {
        data: rows.map(({ total_count, ...d }) => d),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
}

export async function findById(id, db = { query }) {
    const { rows } = await db.query('SELECT * FROM v_deposits WHERE id = $1', [id]);
    return rows[0] ?? null;
}

/** Los pagos incluidos, anulados incluidos: de un depósito no sale nadie. */
export async function findPayments(depositId) {
    const { rows } = await query(
        `SELECT p.id,
                'P-' || LPAD(p.id::text, 6, '0') AS receipt_number,
                p.sale_id,
                'V-' || LPAD(p.sale_id::text, 6, '0') AS sale_number,
                p.customer_id, c.full_name AS customer_name,
                p.payment_date, p.amount, p.method, p.reference, p.status, p.voucher_status,
                p.voided_at, p.void_reason,
                s.branch_id AS sale_branch_id,
                dp.added_at, dp.added_by, u.username AS added_by_username
           FROM deposit_payments dp
           JOIN payments p ON p.id = dp.payment_id
           JOIN sales s ON s.id = p.sale_id
           JOIN customers c ON c.id = p.customer_id
           LEFT JOIN users u ON u.id = dp.added_by
          WHERE dp.deposit_id = $1
       ORDER BY p.payment_date, p.id`,
        [depositId]
    );
    return rows;
}

export async function findEvents(depositId) {
    const { rows } = await query(
        `SELECT e.id, e.event, e.from_status, e.to_status, e.occurred_at, e.comment,
                e.actor_id, u.username AS actor_username,
                e.payment_id,
                CASE WHEN e.payment_id IS NULL THEN NULL
                     ELSE 'P-' || LPAD(e.payment_id::text, 6, '0') END AS payment_number
           FROM deposit_events e
           LEFT JOIN users u ON u.id = e.actor_id
          WHERE e.deposit_id = $1
       ORDER BY e.occurred_at, e.id`,
        [depositId]
    );
    return rows;
}

export async function create(client, data) {
    const { rows } = await client.query(
        `INSERT INTO deposits (branch_id, deposit_date, bank, account, reference, declared_amount, notes, created_by)
         VALUES ($1, COALESCE($2::date, app_today()), $3, $4, $5, $6, $7, $8)
         RETURNING id, branch_id, deposit_date, declared_amount, status, created_by, created_at`,
        [
            data.branch_id,
            data.deposit_date ?? null,
            data.bank ?? null,
            data.account ?? null,
            data.reference ?? null,
            data.declared_amount,
            data.notes ?? null,
            data.created_by,
        ]
    );
    return rows[0];
}

/** Bloquea el depósito: dos revisiones simultáneas no se pisan. */
export async function lockById(client, id) {
    const { rows } = await client.query(
        `SELECT id, branch_id, status, declared_amount, created_by, ${NUMBER('deposits')} AS deposit_number
           FROM deposits WHERE id = $1 FOR UPDATE`,
        [id]
    );
    return rows[0] ?? null;
}

/**
 * Bloquea los pagos indicados y devuelve lo que hace falta para decidir si
 * pueden entrar: estado, sucursal de su venta y depósito al que ya pertenecen.
 * El bloqueo va por identificador ascendente para no cruzarse con otra
 * petición que incluya los mismos pagos en otro orden.
 */
export async function lockPaymentsForDeposit(client, ids) {
    if (!ids.length) return [];
    await client.query('SELECT id FROM payments WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids]);
    const { rows } = await client.query(
        `SELECT p.id, p.status, p.amount, p.method, p.sale_id, p.payment_date,
                s.branch_id AS sale_branch_id,
                dp.deposit_id AS current_deposit_id
           FROM payments p
           JOIN sales s ON s.id = p.sale_id
           LEFT JOIN deposit_payments dp ON dp.payment_id = p.id
          WHERE p.id = ANY($1::bigint[])`,
        [ids]
    );
    return rows;
}

export async function addPayment(client, depositId, paymentId, userId) {
    await client.query(
        'INSERT INTO deposit_payments (deposit_id, payment_id, added_by) VALUES ($1, $2, $3)',
        [depositId, paymentId, userId ?? null]
    );
}

/** Historial: solo inserción. Nada de esto se edita después. */
export async function recordEvent(client, event) {
    const { rows } = await client.query(
        `INSERT INTO deposit_events (deposit_id, event, from_status, to_status, actor_id, comment, payment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, event, occurred_at`,
        [
            event.depositId,
            event.event,
            event.fromStatus ?? null,
            event.toStatus ?? null,
            event.actorId ?? null,
            event.comment ?? null,
            event.paymentId ?? null,
        ]
    );
    return rows[0];
}

/** REVISADO -> VALIDADO. Condicionado al estado para que sea idempotente. */
export async function markValidated(client, id, userId) {
    const { rows } = await client.query(
        `UPDATE deposits
            SET status = 'VALIDADO', validated_by = $2, validated_at = now()
          WHERE id = $1 AND status = 'REVISADO'
         RETURNING id, status, validated_at`,
        [id, userId]
    );
    return rows[0] ?? null;
}
