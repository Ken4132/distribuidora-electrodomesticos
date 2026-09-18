import * as service from '../services/receipt.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
    const result = await service.listReceipts(req.validatedQuery);
    res.json({ ok: true, ...result });
});

export const getOne = asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.getReceipt(req.params.id) });
});

/** Recibo de un pago concreto: es la consulta que usa la pantalla de cobro. */
export const ofPayment = asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.getReceiptOfPayment(req.params.id) });
});
