import * as service from '../services/customer.service.js';
import * as confirmations from '../services/customerConfirmation.service.js';
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

export const confirm = asyncHandler(async (req, res) => {
    const data = await confirmations.confirmCustomerData(req.params.id, req.body, req.user?.id);
    res.status(201).json({
        ok: true,
        data,
        message: data.confirmation.changed_fields.length
            ? `Datos actualizados y reconfirmados (${data.confirmation.changed_fields.length} campo(s) modificado(s))`
            : 'Datos reconfirmados sin cambios',
    });
});

export const listConfirmations = asyncHandler(async (req, res) => {
    const data = await confirmations.listConfirmations(req.params.id);
    res.json({ ok: true, data });
});

export const account = asyncHandler(async (req, res) => {
    const data = await service.getCustomerAccount(req.params.id);
    res.json({ ok: true, data });
});
