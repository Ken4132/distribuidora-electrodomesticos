import { query } from '../config/db.js';
import { normalizeSearch } from '../utils/normalize.js';

const FIELDS = `id, code, name, description, category, brand, model, category_id, brand_id, cost,
                price_cash, price_credit_4, price_credit_8,
                stock, min_stock, is_active, created_at, updated_at`;

/**
 * @param {number|null} opts.scopeBranchId
 *        Cuando el usuario opera con el inventario de UNA sucursal, se pasa
 *        aquí. El listado añade entonces `branch_stock`: las unidades con
 *        las que ese usuario puede operar de verdad. La columna `stock`
 *        sigue siendo el total de la empresa, y es informativa para él.
 */
export async function list({
    search = '',
    category = '',
    categoryId = null,
    brandId = null,
    status = 'all',
    lowStock = false,
    scopeBranchId = null,
    page = 1,
    pageSize = 20,
}) {
    const filters = [];
    const params = [];

    if (search) {
        // Misma forma canónica que se usó al guardar: "cámara", "CAMARA" y
        // "  cámara " encuentran el mismo producto. La descripción entra en
        // la búsqueda normalizada aunque se guarde tal cual se escribió.
        params.push(`%${normalizeSearch(search)}%`);
        const p = `$${params.length}`;
        filters.push(
            `(normalize_business_text(name) LIKE ${p}
              OR upper(code) LIKE ${p}
              OR normalize_business_text(COALESCE(brand, '')) LIKE ${p}
              OR normalize_business_text(COALESCE(model, '')) LIKE ${p}
              OR normalize_business_text(COALESCE(category, '')) LIKE ${p}
              OR normalize_business_text(COALESCE(description, '')) LIKE ${p})`
        );
    }
    if (category) {
        // Se compara normalizado para que el filtro funcione tanto si llega
        // "Cama" como "CAMA".
        params.push(normalizeSearch(category));
        filters.push(`normalize_business_text(category) = $${params.length}`);
    }
    if (categoryId) {
        params.push(categoryId);
        filters.push(`category_id = $${params.length}`);
    }
    if (brandId) {
        params.push(brandId);
        filters.push(`brand_id = $${params.length}`);
    }
    if (status === 'active') filters.push('is_active = TRUE');
    if (status === 'inactive') filters.push('is_active = FALSE');
    if (lowStock) filters.push('stock <= min_stock');

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    // Existencia operativa del usuario: las unidades de SU sucursal. El
    // parámetro se empuja antes que los de paginación para que los índices
    // de LIMIT/OFFSET sigan siendo los dos últimos.
    let branchStock = '';
    if (scopeBranchId) {
        params.push(scopeBranchId);
        const b = `$${params.length}`;
        // Sin alias en `products`: así los filtros de arriba siguen siendo
        // válidos tal cual y no hay que reescribirlos.
        branchStock = `,
                ${b}::bigint AS branch_id,
                COALESCE((SELECT i.quantity FROM inventory i
                           WHERE i.product_id = products.id AND i.branch_id = ${b}), 0)::int AS branch_stock`;
    }

    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT ${FIELDS}${branchStock}, COUNT(*) OVER()::int AS total_count
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
        `INSERT INTO products (code, name, description, category, brand, model,
                               category_id, brand_id, cost, stock, min_stock, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING ${FIELDS}`,
        [
            data.code,
            data.name,
            data.description ?? null,
            data.category ?? 'GENERAL',
            data.brand ?? null,
            data.model ?? null,
            data.category_id ?? null,
            data.brand_id ?? null,
            data.cost,
            data.stock ?? 0,
            data.min_stock ?? 0,
            userId ?? null,
        ]
    );
    return rows[0];
}

/**
 * No permite tocar `stock` — el inventario se mueve solo por operaciones.
 *
 * `category_id` y `brand_id` usan COALESCE igual que el resto: enviarlos
 * nulos significa "no los toques". Para desvincular la marca se envía
 * `brand_id: 0` desde el servicio, que lo traduce a NULL explícito.
 */
export async function update(id, data) {
    const { rows } = await query(
        `UPDATE products SET
             code        = COALESCE($2, code),
             name        = COALESCE($3, name),
             description = $4,
             category    = COALESCE($5, category),
             brand       = $6,
             model       = $7,
             cost        = COALESCE($8, cost),
             min_stock   = COALESCE($9, min_stock),
             category_id = COALESCE($10, category_id),
             brand_id    = CASE WHEN $11::bigint = 0 THEN NULL
                                ELSE COALESCE($11::bigint, brand_id) END
         WHERE id = $1
         RETURNING ${FIELDS}`,
        [
            id,
            data.code ?? null,
            data.name ?? null,
            data.description ?? null,
            data.category ?? null,
            data.brand ?? null,
            data.model ?? null,
            data.cost ?? null,
            data.min_stock ?? null,
            data.category_id ?? null,
            data.brand_id ?? null,
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
 * Ajuste de inventario con trazabilidad.
 * `delta` positivo = entrada, negativo = salida.
 *
 * `branchId` es opcional y por omisión va NULL: la migración 004 lo imputa
 * entonces a la sucursal predeterminada. Gracias a eso el flujo de ventas,
 * que no conoce sucursales, sigue funcionando sin cambios; y el movimiento
 * aterriza igualmente en el inventario por sucursal.
 */
export async function adjustStock(
    client,
    { productId, delta, reason, saleId = null, userId = null, branchId = null }
) {
    const { rows } = await client.query(
        `UPDATE products SET stock = stock + $2 WHERE id = $1 RETURNING id, code, name, stock`,
        [productId, delta]
    );
    const product = rows[0];
    if (!product) return null;

    await client.query(
        `INSERT INTO stock_movements
             (product_id, branch_id, movement, quantity, stock_after, reason, sale_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
            productId,
            branchId,
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
                sm.sale_id, sm.created_at, u.username AS created_by,
                sm.branch_id, b.code AS branch_code, b.name AS branch_name
           FROM stock_movements sm
           LEFT JOIN users u ON u.id = sm.created_by
           LEFT JOIN branches b ON b.id = sm.branch_id
          WHERE sm.product_id = $1
       ORDER BY sm.created_at DESC
          LIMIT $2`,
        [productId, limit]
    );
    return rows;
}

// ---------------------------------------------------------------------
// HISTÓRICO DE COSTOS
//
// Se escribe desde el servicio, dentro de la misma transacción que cambia
// el costo, igual que ya se hace con `stock_movements`. Se sigue la
// convención del proyecto en vez de esconderlo en un trigger: aquí se ve
// quién lo escribe y con qué datos.
// ---------------------------------------------------------------------

export async function recordCostChange(
    client,
    { productId, cost, previousCost = null, reason = 'actualizacion', notes = null, userId = null }
) {
    const { rows } = await client.query(
        `INSERT INTO product_cost_history
             (product_id, cost, previous_cost, reason, notes, changed_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, product_id, cost, previous_cost, reason, notes, changed_by, changed_at`,
        [productId, cost, previousCost, reason, notes, userId]
    );
    return rows[0];
}

export async function listCostHistory(productId, limit = 100) {
    const { rows } = await query(
        `SELECT id, product_id, product_code, product_name, cost, previous_cost,
                variation, reason, notes, changed_by, changed_by_username, changed_at
           FROM v_product_cost_history
          WHERE product_id = $1
       ORDER BY changed_at DESC, id DESC
          LIMIT $2`,
        [productId, limit]
    );
    return rows;
}

/** Existencias de un producto desglosadas por sucursal. */
export async function listInventoryByProduct(productId) {
    const { rows } = await query(
        `SELECT branch_id, branch_code, branch_name, branch_active,
                quantity, min_stock, needs_restock, updated_at
           FROM v_inventory
          WHERE product_id = $1
       ORDER BY branch_name`,
        [productId]
    );
    return rows;
}
