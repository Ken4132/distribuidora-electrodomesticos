import { query } from '../config/db.js';

export async function list({ search = '', customerId = null, accountStatus = '', from = null, to = null, page = 1, pageSize = 20 }) {
    const filters = [];
    const params = [];

    if (search) {
        params.push(`%${search.toLowerCase()}%`);
        const p = `$${params.length}`;
        filters.push(`(lower(customer_name) LIKE ${p} OR customer_dpi LIKE ${p} OR lower(sale_number) LIKE ${p})`);
    }
    if (customerId) {
        params.push(customerId);
        filters.push(`customer_id = $${params.length}`);
    }
    if (accountStatus) {
        params.push(accountStatus);
        filters.push(`account_status = $${params.length}`);
    }
    if (from) {
        params.push(from);
        filters.push(`sale_date >= $${params.length}`);
    }
    if (to) {
        params.push(to);
        filters.push(`sale_date <= $${params.length}`);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT *, COUNT(*) OVER()::int AS total_count
           FROM v_sales
           ${where}
       ORDER BY sale_date DESC, id DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    const total = rows[0]?.total_count ?? 0;
    return {
        data: rows.map(({ total_count, ...s }) => s),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
}

export async function findById(id) {
    const { rows } = await query('SELECT * FROM v_sales WHERE id = $1', [id]);
    return rows[0] ?? null;
}

export async function findItems(saleId) {
    const { rows } = await query(
        `SELECT id, product_id, product_code, product_name, quantity, unit_cost, unit_price, line_total
           FROM sale_items WHERE sale_id = $1 ORDER BY id`,
        [saleId]
    );
    return rows;
}

export async function findInstallments(saleId) {
    const { rows } = await query(
        `SELECT id, number, due_date, amount, paid_amount, balance, status, days_overdue
           FROM v_installments WHERE sale_id = $1 ORDER BY number`,
        [saleId]
    );
    return rows;
}

export async function findPayments(saleId) {
    const { rows } = await query(
        `SELECT p.id, p.payment_date, p.amount, p.method, p.reference, p.notes, p.status,
                p.created_at, u.username AS created_by,
                COALESCE(
                    json_agg(json_build_object('installment_number', i.number, 'amount', pa.amount)
                             ORDER BY i.number) FILTER (WHERE pa.id IS NOT NULL),
                    '[]'
                ) AS allocations
           FROM payments p
           LEFT JOIN users u ON u.id = p.created_by
           LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
           LEFT JOIN installments i ON i.id = pa.installment_id
          WHERE p.sale_id = $1
       GROUP BY p.id, u.username
       ORDER BY p.payment_date, p.id`,
        [saleId]
    );
    return rows;
}

/** Crea la cabecera de la venta dentro de una transacción. */
export async function createSale(client, data) {
    const { rows } = await client.query(
        `INSERT INTO sales (customer_id, sale_date, payment_mode, installments_count,
                            subtotal, total, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, customer_id, sale_date, payment_mode, installments_count,
                   subtotal, total, status, created_at`,
        [
            data.customer_id,
            data.sale_date,
            data.payment_mode,
            data.installments_count,
            data.subtotal,
            data.total,
            data.notes ?? null,
            data.created_by ?? null,
        ]
    );
    return rows[0];
}

export async function createItem(client, saleId, item) {
    const { rows } = await client.query(
        `INSERT INTO sale_items (sale_id, product_id, product_code, product_name,
                                 quantity, unit_cost, unit_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, product_id, product_code, product_name, quantity, unit_cost, unit_price, line_total`,
        [saleId, item.product_id, item.product_code, item.product_name, item.quantity, item.unit_cost, item.unit_price]
    );
    return rows[0];
}

export async function createInstallment(client, saleId, { number, dueDate, amount }) {
    const { rows } = await client.query(
        `INSERT INTO installments (sale_id, number, due_date, amount)
         VALUES ($1,$2,$3,$4)
         RETURNING id, number, due_date, amount`,
        [saleId, number, dueDate, amount]
    );
    return rows[0];
}

export async function cancel(client, saleId, reason) {
    const { rows } = await client.query(
        `UPDATE sales SET status = 'anulada', cancelled_at = now(), cancel_reason = $2
          WHERE id = $1 AND status = 'activa'
         RETURNING id`,
        [saleId, reason ?? null]
    );
    return rows[0] ?? null;
}
