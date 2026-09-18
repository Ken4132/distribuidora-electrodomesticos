import * as service from '../services/deposit.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { actorFrom } from '../services/audit.service.js';
import { userCan } from '../services/authorization.service.js';

/**
 * La excepción de sucursal (pago de una venta histórica sin sucursal) depende
 * de un permiso, así que se resuelve aquí y el servicio solo recibe el sí o
 * el no ya decidido.
 */
const overrideOptions = async (req) => ({ canOverride: await userCan(req.user, 'deposits.override') });

export const list = asyncHandler(async (req, res) => {
    const result = await service.listDeposits(req.validatedQuery);
    res.json({ ok: true, ...result });
});

export const getOne = asyncHandler(async (req, res) => {
    const deposit = await service.getDeposit(req.params.id);
    res.json({ ok: true, data: deposit });
});

export const create = asyncHandler(async (req, res) => {
    const deposit = await service.createDeposit(req.body, actorFrom(req), await overrideOptions(req));
    res.status(201).json({
        ok: true,
        data: deposit,
        message: `Depósito ${deposit.deposit_number} registrado con ${deposit.payments_count} pago(s).`,
    });
});

export const addPayments = asyncHandler(async (req, res) => {
    const deposit = await service.addPaymentsToDeposit(
        req.params.id,
        req.body.payment_ids,
        actorFrom(req),
        await overrideOptions(req)
    );
    res.json({ ok: true, data: deposit, message: 'Pagos incluidos en el depósito.' });
});

export const observe = asyncHandler(async (req, res) => {
    const deposit = await service.observeDeposit(req.params.id, req.body.comment, actorFrom(req));
    res.json({ ok: true, data: deposit, message: 'Observación registrada. El depósito sigue en revisión.' });
});

export const explain = asyncHandler(async (req, res) => {
    const deposit = await service.explainDeposit(req.params.id, req.body.comment, actorFrom(req));
    res.json({ ok: true, data: deposit, message: 'Explicación registrada.' });
});

/** Rechazo: es un EVENTO del historial. El depósito NO cambia de estado. */
export const reject = asyncHandler(async (req, res) => {
    const deposit = await service.rejectDeposit(req.params.id, req.body.comment, actorFrom(req));
    res.json({
        ok: true,
        data: deposit,
        message: 'Rechazo registrado en el historial. El depósito sigue REVISADO hasta que se aclare.',
    });
});

export const validateOne = asyncHandler(async (req, res) => {
    const deposit = await service.validateDeposit(req.params.id, req.body?.comment ?? null, actorFrom(req));
    res.json({ ok: true, data: deposit, message: `Depósito ${deposit.deposit_number} validado.` });
});
