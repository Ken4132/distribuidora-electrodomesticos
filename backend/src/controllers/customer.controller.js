import * as service from '../services/customer.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
    const result = await service.listCustomers(req.validatedQuery);
    res.json({ ok: true, ...result });
});

export const getOne = asyncHandler(async (req, res) => {
    const customer = await service.getCustomer(req.params.id);
    res.json({ ok: true, data: customer });
});

export const create = asyncHandler(async (req, res) => {
    const customer = await service.createCustomer(req.body, req.user?.id);
    res.status(201).json({ ok: true, data: customer, message: 'Cliente registrado correctamente' });
});

export const update = asyncHandler(async (req, res) => {
    const customer = await service.updateCustomer(req.params.id, req.body, req.user?.id);
    res.json({ ok: true, data: customer, message: 'Cliente actualizado' });
});

export const setActive = asyncHandler(async (req, res) => {
    const customer = await service.setCustomerActive(req.params.id, req.body.is_active);
    res.json({
        ok: true,
        data: customer,
        message: req.body.is_active ? 'Cliente activado' : 'Cliente desactivado',
    });
});

export const account = asyncHandler(async (req, res) => {
    const data = await service.getCustomerAccount(req.params.id);
    res.json({ ok: true, data });
});
