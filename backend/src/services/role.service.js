/**
 * GESTIÓN DE ROLES Y PERMISOS  (REQ-0011, RN-0008)
 *
 * Salvaguardas:
 *   * El rol `admin` no se puede desactivar ni quedarse sin los permisos de
 *     administración: sería dejar el sistema sin nadie que pueda arreglarlo.
 *   * Un rol de sistema no se elimina.
 *   * Solo se aceptan permisos del catálogo; un permiso inventado no
 *     protegería nada y daría una falsa sensación de control.
 */
import * as Role from '../models/role.model.js';
import { AppError } from '../utils/AppError.js';
import { invalidatePermissionCache } from './authorization.service.js';

/** Sin estos permisos, el rol de administrador dejaría de poder administrar. */
const ADMIN_ESSENTIALS = ['users.manage', 'roles.manage', 'audit.view'];

export const listRoles = () => Role.list();
export const listPermissions = () => Role.listPermissions();

export async function getRole(code) {
    const role = await Role.findByCode(code);
    if (!role) throw AppError.notFound('Rol no encontrado');
    return role;
}

export async function createRole(data) {
    const existing = await Role.findByCode(data.code);
    if (existing) throw AppError.conflict(`Ya existe un rol con el código "${data.code}"`);

    const role = await Role.create(data);
    invalidatePermissionCache();
    return role;
}

export async function updateRole(code, data) {
    const current = await Role.findByCode(code);
    if (!current) throw AppError.notFound('Rol no encontrado');

    if (data.is_active === false) {
        if (code === 'admin') {
            throw AppError.conflict('El rol de administrador no se puede desactivar.');
        }
        if (current.users_count > 0) {
            throw AppError.conflict(
                `No se puede desactivar: hay ${current.users_count} usuario(s) con este rol. Cámbialos de rol primero.`
            );
        }
    }

    const role = await Role.update(code, {
        name: data.name,
        description: data.description,
        isActive: data.is_active,
    });
    invalidatePermissionCache();
    return role;
}

export async function setRolePermissions(code, permissions) {
    const current = await Role.findByCode(code);
    if (!current) throw AppError.notFound('Rol no encontrado');

    // Solo permisos que la aplicación sabe respetar de verdad.
    const known = await Role.filterKnownPermissions(permissions);
    const unknown = permissions.filter((p) => !known.includes(p));
    if (unknown.length) {
        throw AppError.unprocessable('Hay permisos que no existen en el catálogo', {
            desconocidos: unknown,
        });
    }

    if (code === 'admin') {
        const missing = ADMIN_ESSENTIALS.filter((p) => !known.includes(p));
        if (missing.length) {
            throw AppError.conflict(
                'El rol de administrador no puede quedarse sin los permisos de administración.',
                { obligatorios: missing }
            );
        }
    }

    const role = await Role.replacePermissions(code, known);
    invalidatePermissionCache();
    return role;
}
