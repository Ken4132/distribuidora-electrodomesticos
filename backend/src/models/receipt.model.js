/**
 * ACCESO A DATOS DE RECIBOS (bloque 4.3).
 *
 * `payment_receipts` es de SOLO INSERCIÓN (disparador de la migración 013):
 * aquí no hay update ni delete, y no los va a haber. Una corrección se hace
 * anulando el pago, que deja su propio rastro sin tocar el recibo.
 */
import { query } from '../config/db.js';

/**
 * Emite el recibo de un pago DENTRO de la transacción del pago.
 *
 * El número lo da la base (`next_receipt_number()`) y la sucursal se lee de
 * la venta en el propio INSERT: así no depende de que el llamador la traiga
 * en el objeto `sale`, que no es igual en el cobro normal y en el enganche.
 */
export async function issue(client, data) {
    const { rows } = await client.query(
        `INSERT INTO payment_receipts
             (payment_id, receipt_number, customer_id, sale_id, branch_id, issued_by,
              payment_date, method, amount, balance_before, balance_after,
              deposit_id, deposit_reference, allocations, snapshot)
         VALUES ($1, next_receipt_number(), $2, $3,
                 (SELECT s.branch_id FROM sales s WHERE s.id = $3),
                 $4, $5, $6, $7, $8, $9, NULL, $10, $11::jsonb, $12::jsonb)
         RETURNING id, receipt_number, issued_at, branch_id`,
        [
            data.paymentId,
            data.customerId,
            data.saleId,
            data.issuedBy ?? null,
            data.paymentDate,
            data.method,
            data.amount,
            data.balanceBefore,
            data.balanceAfter,
            data.depositReference ?? null,
            JSON.stringify(data.allocations ?? []),
            JSON.stringify(data.snapshot ?? {}),
        ]
    );
    return rows[0];
}

export async function findByPayment(paymentId, db = { query }) {
    const { rows } = await db.query('SELECT * FROM v_payment_receipts WHERE payment_id = $1', [paymentId]);
    return rows[0] ?? null;
}

export async function findById(id) {
    const { rows } = await query('SELECT * FROM v_payment_receipts WHERE id = $1', [id]);
    return rows[0] ?? null;
}

export async function list({
    customerId = null,
    saleId = null,
    branchId = null,
    paymentStatus = '',
    from = null,
    to = null,
    page = 1,
    pageSize = 20,
}) {
    const filters = [];
    const params = [];

    if (customerId) {
        params.push(customerId);
        filters.push(`customer_id = $${params.length}`);
    }
    if (saleId) {
        params.push(saleId);
        filters.push(`sale_id = $${params.length}`);
    }
    if (branchId) {
        params.push(branchId);
        filters.push(`branch_id = $${params.length}`);
    }
    if (paymentStatus) {
        params.push(paymentStatus);
        filters.push(`payment_status = $${params.length}`);
    }
    if (from) {
        params.push(from);
        filters.push(`payment_date >= $${params.length}`);
    }
    if (to) {
        params.push(to);
        filters.push(`payment_date <= $${params.length}`);
    }

    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT *, COUNT(*) OVER()::int AS total_count
           FROM v_payment_receipts
          ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
       ORDER BY issued_at DESC, id DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    const total = rows[0]?.total_count ?? 0;
    return {
        data: rows.map(({ total_count, ...r }) => r),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
}
