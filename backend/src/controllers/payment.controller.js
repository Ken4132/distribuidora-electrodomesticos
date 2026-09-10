import * as service from '../services/payment.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { PAYMENT_METHODS } from '../validators/payment.schema.js';
import { paymentScope, receivablesScope } from '../services/scope.service.js';
import { actorFrom } from '../services/audit.service.js';
import { AppError } from '../utils/AppError.js';

export const list = asyncHandler(async (req, res) => {
    const result = await service.listPayments(req.validatedQuery);
    res.json({ ok: true, ...result });
});

export const getOne = asyncHandler(async (req, res) => {
    const payment = await service.getPayment(req.params.id);
    res.json({ ok: true, data: payment });
});

export const create = asyncHandler(async (req, res) => {
    // El alcance se resuelve aquí; QUÉ venta cae dentro lo decide el servicio,
    // que es el único que la lee bloqueada dentro de la transacción.
    const scope = await paymentScope(req.user);
    if (!scope) throw AppError.forbidden('Tu rol no tiene permiso para registrar pagos');

    const result = await service.createPayment(req.body, actorFrom(req), scope);
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
    const scope = await receivablesScope(req.user);
    if (!scope) throw AppError.forbidden('Tu rol no tiene permiso para consultar la cartera');

    const result = await service.receivables({ ...req.validatedQuery, scope });
    // El frontend usa esto para titular la pantalla ("Cobranza" o "Tu cartera").
    res.json({ ok: true, ...result, scope: scope.global ? 'global' : 'propia' });
});

export const methods = asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: PAYMENT_METHODS });
});
