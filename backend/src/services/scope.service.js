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
import { can } from './authorization.service.js';

/** Modalidades que forman parte de una cartera de cobranza. */
export const CREDIT_MODES = Object.freeze(['credito_4', 'credito_8']);

/**
 * Resuelve el alcance de un usuario para un par de permisos.
 *
 * @returns {{global: boolean, userId: number|null}|null}
 *          null = no tiene ninguno de los dos permisos.
 */
export async function resolveScope(user, globalPermission, ownPermission) {
    if (!user) return null;
    if (await can(user.role, globalPermission)) return { global: true, userId: user.id ?? null };
    if (await can(user.role, ownPermission)) return { global: false, userId: user.id ?? null };
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
