/**
 * INVENTARIO POR SUCURSAL
 *
 * Lectura del desglose por sucursal y ajuste con trazabilidad.
 *
 * Lo importante de este módulo es lo que NO hace: no escribe en `inventory`
 * directamente. Todo ajuste pasa por `stock_movements`, y un trigger de la
 * migración 004 lo aplica al inventario de la sucursal. Un único camino
 * para cambiar existencias significa que no hay forma de mover stock sin
 * dejar rastro, y que `products.stock` y el desglose por sucursal no pueden
 * separarse.
 */
import { query } from '../config/db.js';
import { normalizeSearch } from '../utils/normalize.js';

export async function list({
    branchId = null,
    search = '',
    onlyRestock = false,
    withStock = false,
    page = 1,
    pageSize = 20,
} = {}) {
    const filters = [];
    const params = [];

    if (branchId) {
        params.push(branchId);
        filters.push(`branch_id = $${params.length}`);
    }
    if (search) {
        params.push(`%${normalizeSearch(search)}%`);
        const p = `$${params.length}`;
        filters.push(
            `(normalize_business_text(product_name) LIKE ${p}
              OR upper(product_code) LIKE ${p}
              OR normalize_business_text(COALESCE(brand, '')) LIKE ${p})`
        );
    }
    if (onlyRestock) filters.push('needs_restock');
    if (withStock) filters.push('quantity > 0');

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT id, product_id, product_code, product_name, category, brand, product_active,
                branch_id, branch_code, branch_name, quantity, min_stock, needs_restock, updated_at,
                COUNT(*) OVER()::int AS total_count
           FROM v_inventory
           ${where}
       ORDER BY branch_name, product_name
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    const total = rows[0]?.total_count ?? 0;
    return {
        data: rows.map(({ total_count, ...row }) => row),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
}

export async function findEntry(productId, branchId) {
    const { rows } = await query(
        `SELECT * FROM v_inventory WHERE product_id = $1 AND branch_id = $2`,
        [productId, branchId]
    );
    return rows[0] ?? null;
}

/** Totales por sucursal para el encabezado de la pantalla. */
export async function summaryByBranch() {
    const { rows } = await query(
        `SELECT b.id AS branch_id, b.code AS branch_code, b.name AS branch_name, b.is_active,
                COALESCE(SUM(i.quantity), 0)::int                          AS stock_units,
                COUNT(i.id) FILTER (WHERE i.quantity > 0)::int             AS products_in_stock,
                COUNT(i.id) FILTER (WHERE i.quantity <= i.min_stock)::int  AS needs_restock
           FROM branches b
           LEFT JOIN inventory i ON i.branch_id = b.id
       GROUP BY b.id
       ORDER BY b.is_default DESC, b.name`
    );
    return rows;
}

/**
 * Mínimo de reposición del par producto/sucursal.
 * Es el único campo de `inventory` que se escribe directamente: no es una
 * existencia, es una preferencia de reposición, y no necesita movimiento.
 */
export async function setMinStock(productId, branchId, minStock) {
    const { rows } = await query(
        `INSERT INTO inventory (product_id, branch_id, quantity, min_stock)
         VALUES ($1, $2, 0, $3)
         ON CONFLICT (product_id, branch_id) DO UPDATE SET min_stock = EXCLUDED.min_stock
         RETURNING product_id, branch_id, quantity, min_stock`,
        [productId, branchId, minStock]
    );
    return rows[0];
}

/**
 * Descuadres entre `products.stock` y la suma del desglose por sucursal.
 * En condiciones normales devuelve vacío; que no lo haga es señal de que
 * alguien escribió existencias por fuera del único camino permitido.
 */
export async function mismatches() {
    const { rows } = await query(`SELECT * FROM v_inventory_mismatch ORDER BY code`);
    return rows;
}
