import { query } from '../config/db.js';

const FIELDS = `id, code, name, description, category, brand, cost,
                price_cash, price_credit_4, price_credit_8,
                stock, min_stock, is_active, created_at, updated_at`;

export async function list({ search = '', category = '', status = 'all', lowStock = false, page = 1, pageSize = 20 }) {
    const filters = [];
    const params = [];

    if (search) {
        params.push(`%${search.toLowerCase()}%`);
        const p = `$${params.length}`;
        filters.push(`(lower(name) LIKE ${p} OR lower(code) LIKE ${p} OR lower(COALESCE(brand,'')) LIKE ${p})`);
    }
    if (category) {
        params.push(category);
        filters.push(`category = $${params.length}`);
    }
    if (status === 'active') filters.push('is_active = TRUE');
    if (status === 'inactive') filters.push('is_active = FALSE');
    if (lowStock) filters.push('stock <= min_stock');

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT ${FIELDS}, COUNT(*) OVER()::int AS total_count
           FROM products
           ${where}
       ORDER BY name
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
    const { rows } = await query(`SELECT ${FIELDS} FROM products WHERE id = $1`, [id]);
    return rows[0] ?? null;
}

export async function findByCode(code) {
    const { rows } = await query(`SELECT ${FIELDS} FROM products WHERE upper(code) = upper($1)`, [code]);
    return rows[0] ?? null;
}

export async function create(data, userId) {
    const { rows } = await query(
        `INSERT INTO products (code, name, description, category, brand, cost, stock, min_stock, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING ${FIELDS}`,
        [
            data.code,
            data.name,
            data.description ?? null,
            data.category ?? 'General',
            data.brand ?? null,
            data.cost,
            data.stock ?? 0,
            data.min_stock ?? 0,
            userId ?? null,
        ]
    );
    return rows[0];
}

/** No permite tocar `stock` — el inventario se mueve solo por operaciones. */
export async function update(id, data) {
    const { rows } = await query(
        `UPDATE products SET
             code        = COALESCE($2, code),
             name        = COALESCE($3, name),
             description = $4,
             category    = COALESCE($5, category),
             brand       = $6,
             cost        = COALESCE($7, cost),
             min_stock   = COALESCE($8, min_stock)
         WHERE id = $1
         RETURNING ${FIELDS}`,
        [
            id,
            data.code ?? null,
            data.name ?? null,
            data.description ?? null,
            data.category ?? null,
            data.brand ?? null,
            data.cost ?? null,
            data.min_stock ?? null,
        ]
    );
    return rows[0] ?? null;
}

export async function setActive(id, isActive) {
    const { rows } = await query(
        `UPDATE products SET is_active = $2 WHERE id = $1 RETURNING ${FIELDS}`,
        [id, isActive]
    );
    return rows[0] ?? null;
}

export async function listCategories() {
    const { rows } = await query(
        `SELECT category, COUNT(*)::int AS products FROM products GROUP BY category ORDER BY category`
    );
    return rows;
}

/**
 * Ajuste manual de inventario con trazabilidad.
 * `delta` positivo = entrada, negativo = salida.
 */
export async function adjustStock(client, { productId, delta, reason, saleId = null, userId = null }) {
    const { rows } = await client.query(
        `UPDATE products SET stock = stock + $2 WHERE id = $1 RETURNING id, code, name, stock`,
        [productId, delta]
    );
    const product = rows[0];
    if (!product) return null;

    await client.query(
        `INSERT INTO stock_movements (product_id, movement, quantity, stock_after, reason, sale_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            productId,
            delta > 0 ? 'entrada' : delta < 0 ? 'salida' : 'ajuste',
            Math.abs(delta),
            product.stock,
            reason,
            saleId,
            userId,
        ]
    );
    return product;
}

export async function listStockMovements(productId, limit = 50) {
    const { rows } = await query(
        `SELECT sm.id, sm.movement, sm.quantity, sm.stock_after, sm.reason,
                sm.sale_id, sm.created_at, u.username AS created_by
           FROM stock_movements sm
           LEFT JOIN users u ON u.id = sm.created_by
          WHERE sm.product_id = $1
       ORDER BY sm.created_at DESC
          LIMIT $2`,
        [productId, limit]
    );
    return rows;
}
