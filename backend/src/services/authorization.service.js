/**
 * CONTROL DE ACCESO POR PERMISOS  (REQ-0011, RN-0008)
 *
 * El rol sigue viajando en el token, igual que antes. Lo que cambia es que
 * ya no se compara contra una lista fija escrita en el código: se consulta
 * qué permisos tiene ese rol en la base de datos, de modo que el
 * administrador pueda cambiarlos sin tocar el código ni recompilar nada.
 *
 * Los permisos NO se meten en el token a propósito:
 *   1. Un token dura 8 horas. Si el administrador quita un permiso, el
 *      cambio debe surtir efecto ya, no cuando el usuario vuelva a entrar.
 *   2. El token es público para quien lo tenga; cuanta menos información
 *      lleve, mejor.
 *
 * Para no pagar una consulta por petición se mantiene una copia en memoria
 * con vida corta, que además se invalida en cuanto se modifica un rol.
 */
import { query } from '../config/db.js';

const CACHE_TTL_MS = 60_000;

/** @type {Map<string, Set<string>> | null} */
let cache = null;
let loadedAt = 0;
let loading = null;

async function loadFromDatabase() {
    const { rows } = await query(
        `SELECT r.code AS role_code, rp.permission_code
           FROM roles r
           LEFT JOIN role_permissions rp ON rp.role_code = r.code
          WHERE r.is_active = TRUE`
    );

    const map = new Map();
    for (const row of rows) {
        if (!map.has(row.role_code)) map.set(row.role_code, new Set());
        if (row.permission_code) map.get(row.role_code).add(row.permission_code);
    }
    cache = map;
    loadedAt = Date.now();
    return map;
}

/** Devuelve el mapa rol -> permisos, recargándolo si la copia venció. */
async function getMap() {
    if (cache && Date.now() - loadedAt < CACHE_TTL_MS) return cache;
    // Si ya hay una recarga en curso, esperarla en lugar de lanzar otra.
    if (!loading) {
        loading = loadFromDatabase().finally(() => {
            loading = null;
        });
    }
    return loading;
}

/** Se llama al modificar roles o permisos para que el cambio surta efecto ya. */
export function invalidatePermissionCache() {
    cache = null;
    loadedAt = 0;
    userCache.clear();
}

/** Lista de permisos de un rol. Rol desconocido o inactivo -> sin permisos. */
export async function permissionsFor(role) {
    if (!role) return [];
    const map = await getMap();
    return [...(map.get(role) ?? [])].sort();
}

/** ¿El rol tiene ESTE permiso? */
export async function can(role, permission) {
    if (!role || !permission) return false;
    const map = await getMap();
    return map.get(role)?.has(permission) ?? false;
}

/** ¿El rol tiene AL MENOS UNO de estos permisos? */
export async function canAny(role, permissions) {
    if (!permissions?.length) return false;
    const map = await getMap();
    const owned = map.get(role);
    if (!owned) return false;
    return permissions.some((p) => owned.has(p));
}

// ---------------------------------------------------------------------
// PERMISOS ADICIONALES POR USUARIO (migración 012)
//
// El rol sigue siendo la base. `user_permissions` concede (GRANT) o retira
// (REVOKE) permisos a UN usuario concreto, sin crear roles nuevos: es lo que
// permite, por ejemplo, que un Cobrador venda y concrete sus propias ventas
// sin convertir a TODOS los cobradores en vendedores.
//
//   permiso efectivo = permisos del rol + GRANT del usuario - REVOKE del usuario
//
// Se cachea por usuario con la misma vida corta que el mapa de roles y se
// invalida en cuanto se concede o se retira un permiso.
// ---------------------------------------------------------------------

/** @type {Map<number, {granted: Set<string>, revoked: Set<string>, at: number}>} */
const userCache = new Map();

/** Anula la copia en memoria de un usuario (o de todos). */
export function invalidateUserPermissionCache(userId = null) {
    if (userId === null) userCache.clear();
    else userCache.delete(Number(userId));
}

async function overridesFor(userId) {
    const id = Number(userId);
    if (!Number.isFinite(id)) return { granted: new Set(), revoked: new Set() };

    const cached = userCache.get(id);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;

    const { rows } = await query(
        'SELECT permission_code, effect FROM user_permissions WHERE user_id = $1',
        [id]
    );
    const entry = { granted: new Set(), revoked: new Set(), at: Date.now() };
    for (const row of rows) {
        (row.effect === 'REVOKE' ? entry.revoked : entry.granted).add(row.permission_code);
    }
    userCache.set(id, entry);
    return entry;
}

/**
 * ¿ESTE usuario tiene el permiso? Es la comprobación que deben usar las rutas
 * y los servicios: `can(role, ...)` solo mira el rol y se queda corta desde
 * que existen los permisos por usuario.
 *
 * @param {{id?: number, role?: string}} user
 */
export async function userCan(user, permission) {
    if (!user || !permission) return false;
    const overrides = await overridesFor(user.id);
    if (overrides.revoked.has(permission)) return false;
    if (overrides.granted.has(permission)) return true;
    return can(user.role, permission);
}

/** ¿AL MENOS UNO de estos permisos, contando los del usuario? */
export async function userCanAny(user, permissions) {
    if (!permissions?.length) return false;
    for (const permission of permissions) {
        if (await userCan(user, permission)) return true;
    }
    return false;
}

/** Permisos efectivos del usuario: los de su rol, ya ajustados. */
export async function effectivePermissions(user) {
    const [rolePermissions, overrides] = await Promise.all([
        permissionsFor(user?.role),
        overridesFor(user?.id),
    ]);
    const effective = new Set(rolePermissions);
    for (const code of overrides.granted) effective.add(code);
    for (const code of overrides.revoked) effective.delete(code);
    return [...effective].sort();
}

/** Detalle de los permisos propios del usuario (para la pantalla de usuarios). */
export async function userPermissionOverrides(userId) {
    const { rows } = await query(
        `SELECT up.permission_code, up.effect, up.reason, up.granted_at,
                u.username AS granted_by_username, p.name AS permission_name, p.module
           FROM user_permissions up
           JOIN permissions p ON p.code = up.permission_code
           LEFT JOIN users u ON u.id = up.granted_by
          WHERE up.user_id = $1
       ORDER BY up.permission_code`,
        [userId]
    );
    return rows;
}
