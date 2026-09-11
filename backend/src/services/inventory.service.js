/**
 * INVENTARIO POR SUCURSAL — reglas de negocio.
 *
 * El ajuste por sucursal reutiliza `Product.adjustStock`, exactamente el
 * mismo camino que usa la venta, pasándole la sucursal. Eso garantiza tres
 * cosas a la vez y sin duplicar lógica:
 *
 *   1. queda el movimiento en `stock_movements` (trazabilidad);
 *   2. el trigger lo aplica al inventario de esa sucursal;
 *   3. `products.stock` sigue siendo la suma del desglose.
 *
 * LÍMITE CONOCIDO DE ESTA FASE — importante:
 * la venta todavía no declara sucursal, así que descuenta de la
 * predeterminada. Mover existencias a otra sucursal deja esa mercadería
 * fuera del alcance de la venta hasta que el bloque de ventas por sucursal
 * esté implementado. Por eso el ajuste sobre una sucursal que no es la
 * predeterminada devuelve un aviso explícito junto al resultado.
 */
import { withTransaction } from '../config/db.js';
import * as Inventory from '../models/inventory.model.js';
import * as Product from '../models/product.model.js';
import * as Branch from '../models/branch.model.js';
import { AppError } from '../utils/AppError.js';
import { inventoryScope, resolveInventoryBranch, NO_BRANCH_MESSAGE } from './scope.service.js';

/**
 * Listado de existencias respetando el alcance del usuario.
 *
 * A quien solo tiene alcance propio se le impone su sucursal: da igual qué
 * `branch_id` mande en la petición. Esa es la barrera real contra cambiar
 * el identificador a mano, y está aquí —en el servidor— y no en la
 * interfaz.
 */
export async function listInventory(user, opts = {}) {
    const scope = await inventoryScope(user);
    if (!scope) throw AppError.forbidden('Tu rol no tiene permiso para consultar el inventario');

    const { branchId, forced } = resolveInventoryBranch(scope, opts.branchId);

    // Alcance propio sin sucursal asignada: no hay inventario suyo que
    // mostrar. Se responde vacío con una explicación, no con un error.
    if (!scope.global && branchId === null) {
        return {
            data: [],
            pagination: { page: 1, pageSize: opts.pageSize ?? 20, total: 0, totalPages: 1 },
            scope: { global: false, branch_id: null },
            notice: NO_BRANCH_MESSAGE,
        };
    }

    const result = await Inventory.list({ ...opts, branchId });

    return {
        ...result,
        scope: { global: scope.global, branch_id: branchId },
        ...(forced
            ? {
                  notice:
                      'Solo puedes operar con el inventario de tu sucursal. ' +
                      'Para ver la disponibilidad en otras, usa la consulta informativa del producto.',
              }
            : {}),
    };
}

/**
 * Totales por sucursal. Con alcance propio se devuelve únicamente la
 * sucursal del usuario: el resumen es una vista operativa, no informativa.
 */
export async function inventorySummary(user) {
    const scope = await inventoryScope(user);
    if (!scope) throw AppError.forbidden('Tu rol no tiene permiso para consultar el inventario');

    const rows = await Inventory.summaryByBranch();
    if (scope.global) return rows;
    return rows.filter((r) => Number(r.branch_id) === scope.branchId);
}

export const inventoryMismatches = () => Inventory.mismatches();

/**
 * CONSULTA INFORMATIVA de la disponibilidad de un producto en todas las
 * sucursales.
 *
 * Es lo que el enunciado pide: el vendedor puede SABER que hay 5 unidades
 * en otra sucursal, pero esas unidades no son suyas. Por eso cada fila
 * viene marcada con `operational`: solo la de su sucursal lo tiene en
 * verdadero, y el resumen separa explícitamente el stock con el que puede
 * operar del que solo puede mirar.
 */
export async function productAvailability(user, productId) {
    const scope = await inventoryScope(user);
    const product = await requireProduct(productId);

    const rows = await Product.listInventoryByProduct(productId);
    const ownBranch = scope?.global ? null : (scope?.branchId ?? null);

    const detail = rows.map((row) => ({
        branch_id: row.branch_id,
        branch_code: row.branch_code,
        branch_name: row.branch_name,
        quantity: row.quantity,
        min_stock: row.min_stock,
        needs_restock: row.needs_restock,
        // Operativo = disponible para las operaciones de este usuario.
        operational: scope?.global === true || Number(row.branch_id) === ownBranch,
    }));

    const operationalStock = detail
        .filter((r) => r.operational)
        .reduce((sum, r) => sum + Number(r.quantity), 0);
    const informationalStock = detail
        .filter((r) => !r.operational)
        .reduce((sum, r) => sum + Number(r.quantity), 0);

    return {
        product: { id: product.id, code: product.code, name: product.name },
        scope: { global: scope?.global ?? false, branch_id: ownBranch },
        operational_stock: operationalStock,
        informational_stock: informationalStock,
        total_stock: operationalStock + informationalStock,
        branches: detail,
        notice:
            scope?.global || informationalStock === 0
                ? null
                : `Hay ${informationalStock} unidad(es) en otras sucursales. Son informativas: no forman parte de tu inventario disponible.`,
    };
}

async function requireBranch(branchId) {
    const branch = await Branch.findById(branchId);
    if (!branch) throw AppError.badRequest('La sucursal seleccionada no existe');
    if (!branch.is_active) throw AppError.unprocessable(`La sucursal "${branch.name}" está desactivada`);
    return branch;
}

async function requireProduct(productId) {
    const product = await Product.findById(productId);
    if (!product) throw AppError.badRequest('El producto seleccionado no existe');
    return product;
}

/**
 * Entrada, salida o corrección de existencias en una sucursal concreta.
 * `delta` positivo suma, negativo resta.
 */
export async function adjustInventory({ productId, branchId, delta, reason, notes = null }, userId) {
    if (!Number.isInteger(delta) || delta === 0) {
        throw AppError.badRequest('La cantidad del ajuste debe ser un entero distinto de cero');
    }
    // Ajustar exige `inventory.manage`, que la ruta ya comprueba. No existe
    // una variante propia: el vendedor no ajusta existencias, ni las suyas
    // ni las de nadie. Administrar y consultar son cosas distintas.

    const [product, branch] = await Promise.all([requireProduct(productId), requireBranch(branchId)]);

    const current = await Inventory.findEntry(productId, branchId);
    const available = current?.quantity ?? 0;

    if (available + delta < 0) {
        throw AppError.unprocessable(
            `El ajuste dejaría "${product.name}" en ${available + delta} unidades en ${branch.name}. ` +
                `Existencia disponible en esa sucursal: ${available}.`
        );
    }

    const result = await withTransaction(async (client) => {
        await Product.adjustStock(client, {
            productId,
            branchId,
            delta,
            reason: reason || 'ajuste_manual',
            userId,
        });

        const { rows } = await client.query(
            `SELECT quantity, min_stock FROM inventory WHERE product_id = $1 AND branch_id = $2`,
            [productId, branchId]
        );
        const { rows: productRows } = await client.query(
            `SELECT id, code, name, stock FROM products WHERE id = $1`,
            [productId]
        );

        return {
            product: productRows[0],
            branch: { id: branch.id, code: branch.code, name: branch.name },
            quantity: rows[0]?.quantity ?? 0,
            min_stock: rows[0]?.min_stock ?? 0,
            delta,
            reason: reason || 'ajuste_manual',
            notes,
        };
    });

    // Aviso, no error: la operación es legítima, pero el operador tiene que
    // saber que esa mercadería no la puede vender el flujo actual.
    if (!branch.is_default && delta > 0) {
        result.warning =
            `Las ventas todavía descuentan de la sucursal predeterminada. ` +
            `Las ${delta} unidad(es) que acabas de ingresar en ${branch.name} no estarán disponibles ` +
            `para el registro de ventas hasta que la venta por sucursal esté implementada.`;
    }

    return result;
}

/** Mínimo de reposición del par producto/sucursal. */
export async function setMinStock({ productId, branchId, minStock }) {
    if (!Number.isInteger(minStock) || minStock < 0) {
        throw AppError.badRequest('El mínimo de reposición debe ser un entero mayor o igual a cero');
    }
    await Promise.all([requireProduct(productId), requireBranch(branchId)]);
    return Inventory.setMinStock(productId, branchId, minStock);
}
