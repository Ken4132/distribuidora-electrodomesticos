import * as service from '../services/role.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const list = asyncHandler(async (_req, res) => {
    const data = await service.listRoles();
    res.json({ ok: true, data });
});

export const permissions = asyncHandler(async (_req, res) => {
    const data = await service.listPermissions();
    res.json({ ok: true, data });
});

export const getOne = asyncHandler(async (req, res) => {
    const data = await service.getRole(req.params.code);
    res.json({ ok: true, data });
});

export const create = asyncHandler(async (req, res) => {
    const data = await service.createRole(req.body);
    res.status(201).json({ ok: true, data, message: `Rol "${data.name}" creado` });
});

export const update = asyncHandler(async (req, res) => {
    const data = await service.updateRole(req.params.code, req.body);
    res.json({ ok: true, data, message: 'Rol actualizado' });
});

export const setPermissions = asyncHandler(async (req, res) => {
    const data = await service.setRolePermissions(req.params.code, req.body.permissions);
    res.json({
        ok: true,
        data,
        message: `El rol "${data.role_name}" quedó con ${data.permissions_count} permiso(s)`,
    });
});
