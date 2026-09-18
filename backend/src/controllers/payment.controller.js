import * as service from '../services/payment.service.js';
import * as receipts from '../services/receipt.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { NEW_PAYMENT_METHODS } from '../validators/payment.schema.js';
import { idempotencyKeySchema } from '../validators/creditApplication.schema.js';
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

/**
 * Cabecera opcional contra el doble envío. Se reutiliza el MISMO validador
 * que las solicitudes de crédito: es la misma cabecera y la misma regla.
 */
function readIdempotencyKey(req) {
    const header = req.get('Idempotency-Key');
    if (header === undefined) return null;
    const parsed = idempotencyKeySchema.safeParse(header);
    if (!parsed.success) {
        throw AppError.unprocessable('Cabecera Idempotency-Key inválida', [
            { campo: 'Idempotency-Key', mensaje: parsed.error.issues[0]?.message },
        ]);
    }
    return parsed.data;
}

export const create = asyncHandler(async (req, res) => {
    // El alcance se resuelve aquí; QUÉ venta cae dentro lo decide el servicio,
    // que es el único que la lee bloqueada dentro de la transacción.
    const scope = await paymentScope(req.user);
    if (!scope) throw AppError.forbidden('Tu usuario no tiene permiso para registrar pagos');

    const idempotencyKey = readIdempotencyKey(req);
    const { replayed, ...result } = await service.createPayment(req.body, actorFrom(req), scope, { idempotencyKey });

    // Un reenvío no crea nada: devuelve 200 con el pago que ya existía.
    res.status(replayed ? 200 : 201).json({
        ok: true,
        data: result,
        replayed,
        message: replayed
            ? `Ese pago ya estaba registrado (envío repetido). Saldo pendiente: Q${Number(result.sale.balance).toFixed(2)}`
            : `Pago registrado. Saldo pendiente: Q${Number(result.sale.balance).toFixed(2)}`,
    });
});

export const voidOne = asyncHandler(async (req, res) => {
    const sale = await service.voidPayment(req.params.id, req.body.reason, actorFrom(req));
    res.json({ ok: true, data: sale, message: 'Pago anulado. El saldo de la venta vuelve a subir.' });
});

/** Recibo inmutable del pago (bloque 4.3). */
export const receipt = asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await receipts.getReceiptOfPayment(req.params.id) });
});

export const receivables = asyncHandler(async (req, res) => {
    const scope = await receivablesScope(req.user);
    if (!scope) throw AppError.forbidden('Tu rol no tiene permiso para consultar la cartera');

    const result = await service.receivables({ ...req.validatedQuery, scope });
    // El frontend usa esto para titular la pantalla ("Cobranza" o "Tu cartera").
    res.json({ ok: true, ...result, scope: scope.global ? 'global' : 'propia' });
});

/**
 * Métodos que el formulario puede ofrecer: solo los OPERATIVOS. Los históricos
 * (cheque, otro) siguen leyéndose en los pagos que ya existen, pero no se
 * proponen para registrar uno nuevo.
 */
export const methods = asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: NEW_PAYMENT_METHODS });
});
