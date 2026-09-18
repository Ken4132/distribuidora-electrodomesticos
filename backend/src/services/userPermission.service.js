import { query, withTransaction } from '../config/db.js';
import * as User from '../models/user.model.js';
import {
    effectivePermissions,
    invalidateUserPermissionCache,
    userPermissionOverrides,
} from './authorization.service.js';
import { AppError } from '../utils/AppError.js';

/**
 * PERMISOS ADICIONALES POR USUARIO (migración 012)
 *
 * El rol sigue siendo la base del control de acceso. Esta capa concede
 * (GRANT) o retira (REVOKE) un permiso a UN usuario concreto, sin crear roles
 * nuevos: es lo que permite que un Cobrador registre y concrete sus propias
 * ventas sin convertir a todos los cobradores en vendedores.
 *
 *   permiso efectivo = permisos del rol + GRANT del usuario - REVOKE del usuario
 *
 * Todo cambio queda en `user_permission_changes` (solo inserción) con quién,
 * qué permiso, a qué usuario, cuándo y por qué.
 */

async function assertUserExists(id) {
    const user = await User.findById(id);
    if (!user) throw AppError.notFound('Usuario no encontrado');
    return user;
}

async function assertPermissionExists(client, code) {
    const { rows } = await client.query('SELECT code, name FROM permissions WHERE code = $1', [code]);
    if (!rows[0]) throw AppError.unprocessable(`El permiso "${code}" no existe`);
    return rows[0];
}

/** Expediente de permisos del usuario: los de su rol, los propios y el efectivo. */
export async function getUserPermissions(userId) {
    const user = await assertUserExists(userId);
    const [overrides, effective, rolePermissions] = await Promise.all([
        userPermissionOverrides(user.id),
        effectivePermissions(user),
        query('SELECT permission_code FROM role_permissions WHERE role_code = $1 ORDER BY permission_code', [user.role]),
    ]);
    const { rows: history } = await query(
        `SELECT c.id, c.permission_code, c.action, c.effect, c.changed_at, c.reason,
                u.username AS changed_by_username
           FROM user_permission_changes c
           LEFT JOIN users u ON u.id = c.changed_by
          WHERE c.user_id = $1
       ORDER BY c.changed_at DESC, c.id DESC
          LIMIT 100`,
        [user.id]
    );
    return {
        user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
        role_permissions: rolePermissions.rows.map((r) => r.permission_code),
        user_permissions: overrides,
        effective_permissions: effective,
        history,
    };
}

/**
 * Concede o retira un permiso a un usuario.
 *
 * @param {number} userId
 * @param {{permission_code: string, effect: 'GRANT'|'REVOKE', reason?: string|null}} input
 * @param {{id: number}} actor
 */
export async function setUserPermission(userId, input, actor) {
    const user = await assertUserExists(userId);

    await withTransaction(async (client) => {
        await assertPermissionExists(client, input.permission_code);

        const { rows: previous } = await client.query(
            'SELECT effect FROM user_permissions WHERE user_id = $1 AND permission_code = $2 FOR UPDATE',
            [user.id, input.permission_code]
        );
        if (previous[0]?.effect === input.effect) {
            throw AppError.conflict(
                `El usuario "${user.username}" ya tiene ese permiso ${input.effect === 'GRANT' ? 'concedido' : 'retirado'}`
            );
        }

        await client.query(
            `INSERT INTO user_permissions (user_id, permission_code, effect, granted_by, reason)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id, permission_code) DO UPDATE
                 SET effect = EXCLUDED.effect,
                     granted_by = EXCLUDED.granted_by,
                     granted_at = now(),
                     reason = EXCLUDED.reason`,
            [user.id, input.permission_code, input.effect, actor?.id ?? null, input.reason ?? null]
        );

        await client.query(
            `INSERT INTO user_permission_changes (user_id, permission_code, action, effect, changed_by, reason)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                user.id,
                input.permission_code,
                input.effect === 'GRANT' ? 'CONCEDIDO' : 'REVOCADO',
                input.effect,
                actor?.id ?? null,
                input.reason ?? null,
            ]
        );
    });

    // El cambio surte efecto de inmediato: no se espera a que caduque la copia
    // en memoria ni a que el usuario vuelva a iniciar sesión.
    invalidateUserPermissionCache(user.id);
    return getUserPermissions(user.id);
}

/** Quita la excepción: el usuario vuelve a tener exactamente lo de su rol. */
export async function clearUserPermission(userId, permissionCode, reason, actor) {
    const user = await assertUserExists(userId);

    await withTransaction(async (client) => {
        const { rows } = await client.query(
            'DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = $2 RETURNING effect',
            [user.id, permissionCode]
        );
        if (!rows[0]) {
            throw AppError.notFound(`El usuario "${user.username}" no tiene una excepción para "${permissionCode}"`);
        }
        await client.query(
            `INSERT INTO user_permission_changes (user_id, permission_code, action, effect, changed_by, reason)
             VALUES ($1, $2, 'RETIRADO', $3, $4, $5)`,
            [user.id, permissionCode, rows[0].effect, actor?.id ?? null, reason ?? null]
        );
    });

    invalidateUserPermissionCache(user.id);
    return getUserPermissions(user.id);
}

/** Catálogo de permisos para la pantalla de usuarios. */
export async function listPermissionCatalog() {
    const { rows } = await query('SELECT code, module, name, description FROM permissions ORDER BY module, code');
    return rows;
}
