import { query } from '../config/db.js';

const PUBLIC_FIELDS = `id, username, full_name, email, phone, role, is_active,
                       created_at, updated_at, last_login_at, deactivated_at`;

/**
 * El hash de la contraseña SOLO sale de aquí, y solo por esta función, que
 * es la única que lo necesita (el login). Ningún otro punto del sistema debe
 * poder devolverlo.
 */
export async function findByUsername(username) {
    const { rows } = await query(
        `SELECT id, username, full_name, email, role, is_active, password_hash
           FROM users WHERE lower(username) = lower($1)`,
        [username]
    );
    return rows[0] ?? null;
}

export async function findById(id) {
    const { rows } = await query(
        `SELECT ${PUBLIC_FIELDS.split(',').map((f) => `u.${f.trim()}`).join(', ')},
                r.name AS role_name
           FROM users u
           LEFT JOIN roles r ON r.code = u.role
          WHERE u.id = $1`,
        [id]
    );
    return rows[0] ?? null;
}

/** Listado con búsqueda y paginación para la pantalla de usuarios (REQ-0010). */
export async function list({ search = '', role = '', status = 'all', page = 1, pageSize = 20 }) {
    const filters = [];
    const params = [];

    if (search) {
        params.push(`%${search.toLowerCase()}%`);
        const p = `$${params.length}`;
        filters.push(`(lower(u.username) LIKE ${p} OR lower(u.full_name) LIKE ${p} OR lower(COALESCE(u.email,'')) LIKE ${p})`);
    }
    if (role) {
        params.push(role);
        filters.push(`u.role = $${params.length}`);
    }
    if (status === 'active') filters.push('u.is_active = TRUE');
    if (status === 'inactive') filters.push('u.is_active = FALSE');

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.role,
                r.name AS role_name, u.is_active, u.created_at, u.last_login_at,
                COUNT(*) OVER()::int AS total_count
           FROM users u
           LEFT JOIN roles r ON r.code = u.role
           ${where}
       ORDER BY u.is_active DESC, u.full_name
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    const total = rows[0]?.total_count ?? 0;
    return {
        data: rows.map(({ total_count, ...u }) => u),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
}

export async function create({ username, fullName, email, phone, passwordHash, role = 'vendedor' }) {
    const { rows } = await query(
        `INSERT INTO users (username, full_name, email, phone, password_hash, role)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${PUBLIC_FIELDS}`,
        [username, fullName, email ?? null, phone ?? null, passwordHash, role]
    );
    return rows[0];
}

/** Actualiza datos de la cuenta. NO toca la contraseña ni el estado. */
export async function update(id, { fullName, email, phone, role }) {
    const { rows } = await query(
        `UPDATE users SET
             full_name = COALESCE($2, full_name),
             email     = $3,
             phone     = $4,
             role      = COALESCE($5, role)
         WHERE id = $1
         RETURNING ${PUBLIC_FIELDS}`,
        [id, fullName ?? null, email ?? null, phone ?? null, role ?? null]
    );
    return rows[0] ?? null;
}

/**
 * REQ-0010: "Al desactivar un usuario se conservará su historial de
 * actividades sin eliminar la información registrada."
 * Por eso es baja lógica y nunca DELETE.
 */
export async function setActive(id, isActive) {
    const { rows } = await query(
        `UPDATE users SET
             is_active      = $2,
             deactivated_at = CASE WHEN $2 THEN NULL ELSE now() END
         WHERE id = $1
         RETURNING ${PUBLIC_FIELDS}`,
        [id, isActive]
    );
    return rows[0] ?? null;
}

export async function updatePassword(id, passwordHash) {
    const { rows } = await query(
        `UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING ${PUBLIC_FIELDS}`,
        [id, passwordHash]
    );
    return rows[0] ?? null;
}

export async function touchLastLogin(id) {
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

export async function countUsers() {
    const { rows } = await query('SELECT COUNT(*)::int AS total FROM users');
    return rows[0].total;
}

/**
 * Cuántos administradores ACTIVOS hay, excluyendo opcionalmente a uno.
 * Sirve para impedir que el sistema se quede sin nadie que pueda administrarlo.
 */
export async function countActiveAdmins(excludeId = null) {
    const { rows } = await query(
        `SELECT COUNT(*)::int AS total
           FROM users
          WHERE role = 'admin' AND is_active = TRUE AND ($1::bigint IS NULL OR id <> $1)`,
        [excludeId]
    );
    return rows[0].total;
}
