/**
 * SUCURSALES — reglas de negocio.
 *
 * Lo que se protege aquí:
 *
 *   * No puede haber dos sucursales con el mismo código ni con el mismo
 *     nombre una vez normalizado ("Sucursal Central" y "SUCURSAL CENTRAL"
 *     son la misma).
 *   * Siempre tiene que quedar una sucursal predeterminada activa: es la
 *     que recibe todo movimiento que no declara sucursal, y sin ella el
 *     registro de ventas se caería.
 *   * Una sucursal con existencias o con usuarios asignados no se desactiva
 *     a ciegas: se perdería de vista mercadería real.
 */
import { withTransaction } from '../config/db.js';
import * as Branch from '../models/branch.model.js';
import { AppError } from '../utils/AppError.js';

export const listBranches = (opts) => Branch.list(opts);

export async function getBranch(id) {
    const branch = await Branch.findById(id);
    if (!branch) throw AppError.notFound('Sucursal no encontrada');
    return { ...branch, usage: await Branch.usage(id) };
}

export async function createBranch(data, userId) {
    const byCode = await Branch.findByCode(data.code);
    if (byCode) {
        throw AppError.conflict(`Ya existe una sucursal con el código ${data.code}: ${byCode.name}`, {
            branch_id: byCode.id,
        });
    }

    // El nombre se compara normalizado: es lo que impide que entren
    // "Sucursal Central" y "SUCURSAL CENTRAL" como dos locales distintos.
    const byName = await Branch.findByName(data.name);
    if (byName) {
        throw AppError.conflict(`Ya existe una sucursal con ese nombre: ${byName.code} — ${byName.name}`, {
            branch_id: byName.id,
        });
    }

    return Branch.create(data, userId);
}

export async function updateBranch(id, data) {
    const current = await Branch.findById(id);
    if (!current) throw AppError.notFound('Sucursal no encontrada');

    if (data.code && data.code.toUpperCase() !== current.code.toUpperCase()) {
        const other = await Branch.findByCode(data.code);
        if (other && other.id !== current.id) {
            throw AppError.conflict(`El código ${data.code} ya lo usa la sucursal "${other.name}"`);
        }
    }
    if (data.name) {
        const other = await Branch.findByName(data.name);
        if (other && other.id !== current.id) {
            throw AppError.conflict(`Ese nombre ya lo usa la sucursal ${other.code}`);
        }
    }
    return Branch.update(id, data);
}

export async function setBranchActive(id, isActive) {
    const current = await Branch.findById(id);
    if (!current) throw AppError.notFound('Sucursal no encontrada');

    if (!isActive) {
        if (current.is_default) {
            throw AppError.conflict(
                'No se puede desactivar la sucursal predeterminada. Marca antes otra como predeterminada.'
            );
        }
        const usage = await Branch.usage(id);
        if (usage.stock_units > 0) {
            throw AppError.conflict(
                `No se puede desactivar: la sucursal todavía tiene ${usage.stock_units} unidad(es) en inventario.`
            );
        }
        if (usage.active_users > 0) {
            throw AppError.conflict(
                `No se puede desactivar: hay ${usage.active_users} usuario(s) activo(s) asignado(s) a esta sucursal.`
            );
        }
    }
    return Branch.setActive(id, isActive);
}

/**
 * Marca una sucursal como predeterminada.
 *
 * Tiene consecuencias operativas reales: a partir de aquí, toda venta y
 * todo ajuste que no declare sucursal descontarán de esta. Por eso exige
 * que la sucursal esté activa.
 */
export async function makeDefault(id) {
    const current = await Branch.findById(id);
    if (!current) throw AppError.notFound('Sucursal no encontrada');
    if (!current.is_active) {
        throw AppError.unprocessable('Una sucursal desactivada no puede ser la predeterminada');
    }
    if (current.is_default) return current;

    return withTransaction((client) => Branch.setDefault(client, id));
}

/**
 * Sucursal a la que se imputa una operación que no declara ninguna.
 * Se usa desde el servicio de inventario cuando el ajuste no trae sucursal.
 */
export async function requireDefaultBranch() {
    const branch = await Branch.findDefault();
    if (!branch) {
        throw AppError.unprocessable(
            'No hay una sucursal predeterminada configurada. Márcala desde la pantalla de Sucursales.'
        );
    }
    return branch;
}
