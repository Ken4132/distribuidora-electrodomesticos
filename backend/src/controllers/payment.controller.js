import * as service from '../services/payment.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { PAYMENT_METHODS } from '../validators/payment.schema.js';

export const list = asyncHandler(async (req, res) => {
    const result = await service.listPayments(req.validatedQuery);
    res.json({ ok: true, ...result });
});

export const getOne = asyncHandler(async (req, res) => {
    const payment = await service.getPayment(req.params.id);
    res.json({ ok: true, data: payment });
});

export const create = asyncHandler(async (req, res) => {
    const result = await service.createPayment(req.body, req.user?.id);
    res.status(201).json({
        ok: true,
        data: result,
        message: `Pago registrado. Saldo pendiente: Q${Number(result.sale.balance).toFixed(2)}`,
    });
});

export const voidOne = asyncHandler(async (req, res) => {
    const sale = await service.voidPayment(req.params.id, req.body.reason);
    res.json({ ok: true, data: sale, message: 'Pago anulado' });
});

export const receivables = asyncHandler(async (req, res) => {
    const result = await service.receivables(req.validatedQuery);
    res.json({ ok: true, ...result });
});

export const methods = asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: PAYMENT_METHODS });
});
