import * as service from '../services/branch.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
    const data = await service.listBranches(req.validatedQuery);
    res.json({ ok: true, data });
});

export const getOne = asyncHandler(async (req, res) => {
    const data = await service.getBranch(req.params.id);
    res.json({ ok: true, data });
});

export const create = asyncHandler(async (req, res) => {
    const data = await service.createBranch(req.body, req.user?.id);
    res.status(201).json({ ok: true, data, message: 'Sucursal registrada correctamente' });
});

export const update = asyncHandler(async (req, res) => {
    const data = await service.updateBranch(req.params.id, req.body);
    res.json({ ok: true, data, message: 'Sucursal actualizada' });
});

export const setActive = asyncHandler(async (req, res) => {
    const data = await service.setBranchActive(req.params.id, req.body.is_active);
    res.json({ ok: true, data, message: req.body.is_active ? 'Sucursal activada' : 'Sucursal desactivada' });
});

export const makeDefault = asyncHandler(async (req, res) => {
    const data = await service.makeDefault(req.params.id);
    res.json({
        ok: true,
        data,
        message: `"${data.name}" es ahora la sucursal predeterminada. Las operaciones que no declaren sucursal se imputarán a ella.`,
    });
});
