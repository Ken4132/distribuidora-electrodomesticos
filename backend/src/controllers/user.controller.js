import * as service from '../services/user.service.js';
import * as permissionService from '../services/userPermission.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
    const q = req.validatedQuery;
    const result = await service.listUsers({ ...q, branchId: q.branch_id ?? null });
    res.json({ ok: true, ...result });
});

/** Asigna o quita la sucursal del usuario (`branch_id: null` la quita). */
export const assignBranch = asyncHandler(async (req, res) => {
    const user = await service.assignBranch(req.params.id, req.body.branch_id ?? null);
    res.json({
        ok: true,
        data: user,
        message: user.branch_name
            ? `Usuario asignado a la sucursal ${user.branch_name}`
            : 'Usuario sin sucursal asignada',
    });
});

export const getOne = asyncHandler(async (req, res) => {
    const user = await service.getUser(req.params.id);
    res.json({ ok: true, data: user });
});

export const create = asyncHandler(async (req, res) => {
    const user = await service.createUser(req.body);
    res.status(201).json({ ok: true, data: user, message: `Usuario "${user.username}" creado` });
});

export const update = asyncHandler(async (req, res) => {
    const user = await service.updateUser(req.params.id, req.body, req.user?.id);
    res.json({ ok: true, data: user, message: 'Usuario actualizado' });
});

export const setActive = asyncHandler(async (req, res) => {
    const user = await service.setUserActive(req.params.id, req.body.is_active, req.user?.id);
    res.json({
        ok: true,
        data: user,
        message: req.body.is_active ? 'Usuario activado' : 'Usuario desactivado',
    });
});

/** Restablecimiento por parte de un administrador. */
export const resetPassword = asyncHandler(async (req, res) => {
    const user = await service.changePassword(req.params.id, req.body.password);
    res.json({ ok: true, data: user, message: 'Contraseña restablecida' });
});

/** Cambio de la propia contraseña: exige la actual. */
export const changeOwnPassword = asyncHandler(async (req, res) => {
    await service.changeOwnPassword(req.user.id, req.body.current_password, req.body.password);
    res.json({ ok: true, data: null, message: 'Contraseña actualizada' });
});

// ---------------------------------------------------------------------
// PERMISOS ADICIONALES POR USUARIO (012)
// ---------------------------------------------------------------------

export const permissions = asyncHandler(async (req, res) => {
    const data = await permissionService.getUserPermissions(req.params.id);
    res.json({ ok: true, data });
});

export const setPermission = asyncHandler(async (req, res) => {
    const data = await permissionService.setUserPermission(req.params.id, req.body, req.user);
    res.json({
        ok: true,
        data,
        message:
            req.body.effect === 'GRANT'
                ? `Permiso "${req.body.permission_code}" concedido a ${data.user.username}`
                : `Permiso "${req.body.permission_code}" retirado a ${data.user.username}`,
    });
});

export const clearPermission = asyncHandler(async (req, res) => {
    const data = await permissionService.clearUserPermission(
        req.params.id,
        req.body.permission_code,
        req.body.reason,
        req.user
    );
    res.json({ ok: true, data, message: 'El usuario vuelve a los permisos de su rol' });
});

export const permissionCatalog = asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: await permissionService.listPermissionCatalog() });
});
