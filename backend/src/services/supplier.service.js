/**
 * PROVEEDORES — reglas de negocio.
 *
 * Lo que se protege aquí:
 *
 *   * Un NIT no puede estar dos veces ENTRE PROVEEDORES ACTIVOS. Si el NIT
 *     pertenece a un proveedor dado de baja, el alta no se bloquea: se
 *     avisa de que existe y se ofrece reactivarlo, que es lo correcto —un
 *     proveedor duplicado partiría en dos su historial de compras.
 *
 *   * Un proveedor NO se elimina. Se desactiva. La baja lógica es la misma
 *     doctrina que clientes, productos y sucursales, y aquí pesa además que
 *     las compras y las cuentas por pagar del bloque siguiente colgarán de
 *     esta tabla.
 *
 *   * Reactivar es la operación delicada: al volver a poner `is_active` en
 *     TRUE el NIT vuelve a entrar en el índice único, así que hay que
 *     comprobar antes que no haya otro proveedor activo con ese mismo NIT.
 *
 * NO se emite ningún evento de integración: n8n no participa en el
 * catálogo de proveedores y este bloque no lo toca.
 */
import * as Supplier from '../models/supplier.model.js';
import { AppError } from '../utils/AppError.js';

export const listSuppliers = (opts) => Supplier.list(opts);

export async function getSupplier(id) {
    const supplier = await Supplier.findById(id);
    if (!supplier) throw AppError.notFound('Proveedor no encontrado');
    return supplier;
}

export async function createSupplier(data, userId) {
    const activo = await Supplier.findActiveByNit(data.nit);
    if (activo) {
        // Comprobación explícita para dar un mensaje útil; la garantía real
        // contra la condición de carrera sigue siendo el índice único
        // parcial `ux_suppliers_nit_active`.
        throw AppError.conflict(
            `El NIT ${data.nit} ya está registrado a nombre de ${activo.business_name}`,
            { supplier_id: activo.id, reason: 'nit_activo_duplicado' }
        );
    }

    const inactivos = await Supplier.findInactiveByNit(data.nit);
    if (inactivos.length > 0) {
        const previo = inactivos[0];
        throw AppError.conflict(
            `El NIT ${data.nit} pertenece a ${previo.business_name}, que está DESACTIVADO. ` +
                'Reactívalo en lugar de crear un proveedor nuevo: así conserva su historial.',
            { supplier_id: previo.id, reason: 'nit_inactivo_reactivable' }
        );
    }

    return Supplier.create(data, userId);
}

export async function updateSupplier(id, data) {
    const current = await Supplier.findById(id);
    if (!current) throw AppError.notFound('Proveedor no encontrado');

    if (data.nit && data.nit !== current.nit) {
        // El NIT solo choca si este proveedor está activo: el índice único
        // es parcial. Un proveedor inactivo puede quedarse con el NIT que
        // sea sin desplazar a nadie.
        if (current.is_active) {
            const otro = await Supplier.findActiveByNit(data.nit);
            if (otro && otro.id !== current.id) {
                throw AppError.conflict(
                    `El NIT ${data.nit} ya lo usa el proveedor activo ${otro.business_name}`,
                    { supplier_id: otro.id }
                );
            }
        }
    }

    return Supplier.update(id, data);
}

export async function setSupplierActive(id, isActive) {
    const current = await Supplier.findById(id);
    if (!current) throw AppError.notFound('Proveedor no encontrado');
    if (current.is_active === isActive) return current;

    if (isActive) {
        // Al reactivar, el NIT vuelve a entrar en el índice único de
        // activos: si mientras tanto se dio de alta otro proveedor con ese
        // NIT, reactivar este chocaría. Se explica en lugar de reventar.
        const otro = await Supplier.findActiveByNit(current.nit);
        if (otro && otro.id !== current.id) {
            throw AppError.conflict(
                `No se puede reactivar: el NIT ${current.nit} lo tiene ahora el proveedor activo ` +
                    `${otro.business_name}. Desactiva ese primero o corrige el NIT.`,
                { supplier_id: otro.id }
            );
        }
    }

    return Supplier.setActive(id, isActive);
}
