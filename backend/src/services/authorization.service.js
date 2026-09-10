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
