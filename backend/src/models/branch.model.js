/**
 * SUCURSALES
 *
 * La primera instalación opera con un solo local, pero el modelo admite N
 * desde el primer día: el inventario, los usuarios y cada movimiento de
 * existencias ya cuelgan de una sucursal.
 *
 * La sucursal PREDETERMINADA tiene un papel técnico concreto: es a la que
 * se imputa todo movimiento que todavía no declara sucursal. Mientras la
 * venta no sea consciente de sucursal (bloque posterior), eso significa
 * todas las ventas.
 */
import { query } from '../config/db.js';
import { normalizeSearch } from '../utils/normalize.js';

const FIELDS = `id, code, name, address, phone, is_default, is_active, notes,
                created_at, updated_at`;

export async function list({ search = '', status = 'all' } = {}) {
    const filters = [];
    const params = [];

    if (search) {
        params.push(`%${normalizeSearch(search)}%`);
        const p = `$${params.length}`;
        filters.push(`(normalize_business_text(b.name) LIKE ${p} OR b.code LIKE ${p})`);
    }
    if (status === 'active') filters.push('b.is_active = TRUE');
    if (status === 'inactive') filters.push('b.is_active = FALSE');

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const { rows } = await query(
        `SELECT b.id, b.code, b.name, b.address, b.phone, b.is_default, b.is_active,
                b.notes, b.created_at, b.updated_at,
                COUNT(DISTINCT u.id)::int AS users,
                COALESCE(SUM(i.quantity), 0)::int AS stock_units,
                COUNT(DISTINCT i.product_id) FILTER (WHERE i.quantity > 0)::int AS products_in_stock
           FROM branches b
           LEFT JOIN users u ON u.branch_id = b.id AND u.is_active
           LEFT JOIN inventory i ON i.branch_id = b.id
           ${where}
       GROUP BY b.id
       ORDER BY b.is_default DESC, b.name`,
        params
    );
    return rows;
}

export async function findById(id) {
    const { rows } = await query(`SELECT ${FIELDS} FROM branches WHERE id = $1`, [id]);
    return rows[0] ?? null;
}

export async function findByCode(code) {
    const { rows } = await query(`SELECT ${FIELDS} FROM branches WHERE upper(code) = upper($1)`, [code]);
    return rows[0] ?? null;
}

export async function findByName(name) {
    const { rows } = await query(
        `SELECT ${FIELDS} FROM branches
          WHERE normalize_business_text(name) = normalize_business_text($1)`,
        [name]
    );
    return rows[0] ?? null;
}

export async function findDefault() {
    const { rows } = await query(`SELECT ${FIELDS} FROM branches WHERE is_default`);
    return rows[0] ?? null;
}

export async function create(data, userId = null) {
    const { rows } = await query(
        `INSERT INTO branches (code, name, address, phone, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${FIELDS}`,
        [data.code, data.name, data.address ?? null, data.phone ?? null, data.notes ?? null, userId]
    );
    return rows[0];
}

export async function update(id, data) {
    const { rows } = await query(
        `UPDATE branches SET
             code    = COALESCE($2, code),
             name    = COALESCE($3, name),
             address = $4,
             phone   = $5,
             notes   = $6
         WHERE id = $1 RETURNING ${FIELDS}`,
        [id, data.code ?? null, data.name ?? null, data.address ?? null, data.phone ?? null, data.notes ?? null]
    );
    return rows[0] ?? null;
}

export async function setActive(id, isActive) {
    const { rows } = await query(
        `UPDATE branches SET is_active = $2 WHERE id = $1 RETURNING ${FIELDS}`,
        [id, isActive]
    );
    return rows[0] ?? null;
}

/**
 * Cambia cuál es la sucursal predeterminada.
 *
 * Se quita primero y se pone después, en la misma transacción: el índice
 * único parcial `ux_branches_default` no admite dos a la vez ni por un
 * instante.
 */
export async function setDefault(client, id) {
    await client.query('UPDATE branches SET is_default = FALSE WHERE is_default AND id <> $1', [id]);
    const { rows } = await client.query(
        `UPDATE branches SET is_default = TRUE WHERE id = $1 RETURNING ${FIELDS}`,
        [id]
    );
    return rows[0] ?? null;
}

/** Qué hay colgando de la sucursal. Se consulta antes de desactivarla. */
export async function usage(id) {
    const { rows } = await query(
        `SELECT (SELECT COUNT(*)::int FROM users WHERE branch_id = $1 AND is_active)        AS active_users,
                (SELECT COALESCE(SUM(quantity), 0)::int FROM inventory WHERE branch_id = $1) AS stock_units,
                (SELECT COUNT(*)::int FROM stock_movements WHERE branch_id = $1)             AS movements`,
        [id]
    );
    return rows[0];
}
