import { query, withTransaction } from '../config/db.js';

/** Roles con su conteo de permisos y de usuarios (vista de la migración 003). */
export async function list() {
    const { rows } = await query(
        `SELECT role_code, role_name, description, is_system, is_active,
                permissions_count, permissions, users_count
           FROM v_role_permissions
       ORDER BY (role_code = 'admin') DESC, role_name`
    );
    return rows;
}

export async function findByCode(code) {
    const { rows } = await query(`SELECT * FROM v_role_permissions WHERE role_code = $1`, [code]);
    return rows[0] ?? null;
}

/** Catálogo completo de permisos agrupado por módulo, para la pantalla. */
export async function listPermissions() {
    const { rows } = await query(
        `SELECT code, module, name, description FROM permissions ORDER BY module, code`
    );
    return rows;
}

export async function create({ code, name, description }) {
    const { rows } = await query(
        `INSERT INTO roles (code, name, description, is_system)
         VALUES ($1, $2, $3, FALSE)
         RETURNING code, name, description, is_system, is_active`,
        [code, name, description ?? null]
    );
    return rows[0];
}

export async function update(code, { name, description, isActive }) {
    const { rows } = await query(
        `UPDATE roles SET
             name        = COALESCE($2, name),
             description = $3,
             is_active   = COALESCE($4, is_active)
         WHERE code = $1
         RETURNING code, name, description, is_system, is_active`,
        [code, name ?? null, description ?? null, isActive ?? null]
    );
    return rows[0] ?? null;
}

/**
 * Reemplaza por completo los permisos de un rol.
 * Se hace en una transacción: dejar un rol sin permisos a medio camino
 * porque falló el segundo INSERT sería peor que no haber cambiado nada.
 */
export async function replacePermissions(code, permissionCodes) {
    return withTransaction(async (client) => {
        await client.query('DELETE FROM role_permissions WHERE role_code = $1', [code]);

        if (permissionCodes.length) {
            await client.query(
                `INSERT INTO role_permissions (role_code, permission_code)
                 SELECT $1, unnest($2::varchar[])`,
                [code, permissionCodes]
            );
        }

        const { rows } = await client.query(`SELECT * FROM v_role_permissions WHERE role_code = $1`, [code]);
        return rows[0] ?? null;
    });
}

/** Permisos que existen en el catálogo, de una lista propuesta. */
export async function filterKnownPermissions(codes) {
    if (!codes?.length) return [];
    const { rows } = await query(`SELECT code FROM permissions WHERE code = ANY($1::varchar[])`, [codes]);
    return rows.map((r) => r.code);
}
