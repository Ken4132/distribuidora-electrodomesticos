/**
 * ALCANCE DE LOS PERMISOS  (regla U6 de docs/REGLAS-DE-NEGOCIO.md)
 *
 * Hay operaciones que un usuario puede hacer sobre TODO o solo sobre lo
 * suyo. El caso del proyecto es la cobranza: el cobrador cobra cualquier
 * venta, y el vendedor solo los créditos que él mismo vendió.
 *
 * Eso no se puede expresar con un permiso plano, así que el catálogo tiene
 * pares:
 *
 *     payments.create        -> cualquier venta
 *     payments.create.own    -> solo la cartera propia
 *
 * Reglas, en este orden:
 *
 *   1. El permiso global IMPLICA al propio. Si alguien tiene los dos, manda
 *      el global.
 *   2. `.own` es un subconjunto ESTRICTO: nunca amplía nada.
 *   3. Sin ninguno de los dos, no hay alcance y la operación se rechaza.
 *
 * Qué es "lo suyo": una venta A CRÉDITO cuyo `created_by` es el usuario.
 * Las ventas de contado quedan fuera por decisión del propietario del
 * negocio (2026-09-11), y una venta cuyo `created_by` es NULL —porque la
 * cuenta que la registró fue eliminada— no pertenece a la cartera de nadie.
 */
import { userCan } from './authorization.service.js';
import { query } from '../config/db.js';

/** Modalidades que forman parte de una cartera de cobranza. */
// `credito` (010): ventas concretadas desde una solicitud aprobada.
export const CREDIT_MODES = Object.freeze(['credito_4', 'credito_8', 'credito']);

/**
 * Resuelve el alcance de un usuario para un par de permisos.
 *
 * @returns {{global: boolean, userId: number|null}|null}
 *          null = no tiene ninguno de los dos permisos.
 */
export async function resolveScope(user, globalPermission, ownPermission) {
    if (!user) return null;
    if (await userCan(user, globalPermission)) return { global: true, userId: user.id ?? null };
    if (await userCan(user, ownPermission)) return { global: false, userId: user.id ?? null };
    return null;
}

/** Alcance de cobranza: registrar pagos. */
export const paymentScope = (user) => resolveScope(user, 'payments.create', 'payments.create.own');

/** Alcance de consulta de cartera. */
export const receivablesScope = (user) => resolveScope(user, 'receivables.view', 'receivables.view.own');

/**
 * ¿Esta venta cae dentro del alcance?
 * Recibe la fila de la venta ya leída (y, en el caso del cobro, ya
 * bloqueada dentro de la transacción).
 *
 * @returns {{allowed: true} | {allowed: false, reason: 'ajena'|'contado'}}
 */
export function saleInScope(sale, scope) {
    if (scope?.global) return { allowed: true };

    const owner = sale?.created_by === null || sale?.created_by === undefined ? null : Number(sale.created_by);
    if (owner === null || owner !== Number(scope?.userId)) {
        return { allowed: false, reason: 'ajena' };
    }
    if (!CREDIT_MODES.includes(sale?.payment_mode)) {
        return { allowed: false, reason: 'contado' };
    }
    return { allowed: true };
}

/** Mensaje para el usuario según por qué quedó fuera del alcance. */
export function scopeDenialMessage(reason) {
    return reason === 'contado'
        ? 'Las ventas de contado no forman parte de tu cartera de cobranza'
        : 'Esa venta no pertenece a tu cartera';
}

/**
 * Condición SQL para limitar una consulta sobre `v_sales` a la cartera
 * propia. Devuelve el fragmento y empuja el parámetro que necesita.
 *
 * Se usa con `v_sales`, que desde la migración 003 expone `created_by`.
 */
export function ownPortfolioFilter(scope, params) {
    // Parametrizado, no interpolado: la regla del proyecto es que ningún
    // valor se concatene en el SQL, ni siquiera una constante del código.
    params.push(scope.userId);
    const user = `$${params.length}`;
    params.push(CREDIT_MODES);
    const modes = `$${params.length}`;
    return `created_by = ${user} AND payment_mode = ANY(${modes}::varchar[])`;
}

// =====================================================================
// ALCANCE DE INVENTARIO  (bloque 2A)
//
// REGLA DE NEGOCIO DEFINITIVA:
// el vendedor opera única y exclusivamente con el inventario de SU
// sucursal. Puede consultar, a título informativo, si hay unidades en
// otras sucursales, pero esas unidades NO son stock disponible para él.
//
// Se expresa con el mismo par que ya usa la cobranza:
//
//     inventory.view       -> el inventario de todas las sucursales
//     inventory.view.own   -> solo el de la sucursal del usuario
//
// Y con una separación que el enunciado exige explícitamente: CONSULTAR
// no es ADMINISTRAR. Ajustar existencias es `inventory.manage`, que el
// vendedor no tiene en ninguna de sus formas.
// =====================================================================

/**
 * Sucursal del usuario, leída SIEMPRE de la base de datos.
 *
 * A propósito no se lee del token: el JWT solo lleva id, usuario y rol, y
 * si mañana el administrador reasigna a alguien de sucursal, el cambio
 * tiene que valer en la siguiente petición y no cuando caduque la sesión.
 * Es el mismo criterio con el que el bloque 1 resuelve los permisos.
 */
export async function branchOfUser(userId) {
    if (!userId) return null;
    const { rows } = await query('SELECT branch_id FROM users WHERE id = $1', [userId]);
    const branchId = rows[0]?.branch_id;
    return branchId === null || branchId === undefined ? null : Number(branchId);
}

/**
 * Alcance de inventario del usuario.
 *
 * @returns {{global: true, branchId: null} |
 *           {global: false, branchId: number|null} |
 *           null}
 *          null = no puede consultar inventario en absoluto.
 *          global:false con branchId null = tiene el permiso propio pero
 *          no tiene sucursal asignada, así que no hay inventario suyo.
 */
export async function inventoryScope(user) {
    if (!user) return null;
    if (await userCan(user, 'inventory.view')) return { global: true, branchId: null };
    if (await userCan(user, 'inventory.view.own')) {
        return { global: false, branchId: await branchOfUser(user.id) };
    }
    return null;
}

/** ¿Puede este usuario administrar existencias? Solo el permiso global. */
export const canManageInventory = (user) => userCan(user, 'inventory.manage');

/**
 * Resuelve la sucursal sobre la que se va a CONSULTAR.
 *
 * Aquí es donde se corta el intento de saltarse la restricción cambiando
 * el identificador en la petición: a un usuario de alcance propio se le
 * IGNORA la sucursal que pida y se le impone la suya. No se le devuelve un
 * 403 por consultar —consultar otras sucursales es legítimo y va por la
 * vía informativa—, simplemente su vista operativa nunca deja de ser la de
 * su sucursal.
 *
 * @returns {{branchId: number|null, forced: boolean}}
 */
export function resolveInventoryBranch(scope, requestedBranchId) {
    if (scope?.global) {
        return { branchId: requestedBranchId ? Number(requestedBranchId) : null, forced: false };
    }
    const requested = requestedBranchId ? Number(requestedBranchId) : null;
    return {
        branchId: scope?.branchId ?? null,
        forced: requested !== null && requested !== (scope?.branchId ?? null),
    };
}

/** Mensaje cuando el usuario no tiene sucursal asignada. */
export const NO_BRANCH_MESSAGE =
    'Tu usuario no tiene sucursal asignada, así que no hay inventario propio que mostrar. ' +
    'Pídele al administrador que te asigne una sucursal.';
