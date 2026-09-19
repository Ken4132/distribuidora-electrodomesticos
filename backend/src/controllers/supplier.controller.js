import * as service from '../services/supplier.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
    const { data, pagination } = await service.listSuppliers(req.validatedQuery);
    res.json({ ok: true, data, pagination });
});

export const getOne = asyncHandler(async (req, res) => {
    const data = await service.getSupplier(req.params.id);
    res.json({ ok: true, data });
});

export const create = asyncHandler(async (req, res) => {
    const data = await service.createSupplier(req.body, req.user?.id);
    res.status(201).json({ ok: true, data, message: 'Proveedor registrado correctamente' });
});

export const update = asyncHandler(async (req, res) => {
    const data = await service.updateSupplier(req.params.id, req.body);
    res.json({ ok: true, data, message: 'Proveedor actualizado' });
});

export const setActive = asyncHandler(async (req, res) => {
    const data = await service.setSupplierActive(req.params.id, req.body.is_active);
    res.json({
        ok: true,
        data,
        message: req.body.is_active ? 'Proveedor reactivado' : 'Proveedor desactivado',
    });
});
