import * as service from '../services/creditApplication.service.js';
import { can } from '../services/authorization.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import { idempotencyKeySchema } from '../validators/creditApplication.schema.js';

/**
 * RN-0001: el costo congelado y el porcentaje de recargo (que junto con el
 * precio mínimo revela el costo) solo viajan a quien puede ver costos.
 * Se quitan en la capa de respuesta, igual que en ventas.
 */
const RESTRICTED_FIELDS = ['cost_snapshot', 'financing_percentage_snapshot'];

function stripRestricted(value) {
    if (Array.isArray(value)) return value.map(stripRestricted);
    if (!value || typeof value !== 'object' || value instanceof Date) return value;
    const out = {};
    for (const [key, val] of Object.entries(value)) {
        if (RESTRICTED_FIELDS.includes(key)) continue;
        out[key] = stripRestricted(val);
    }
    return out;
}

async function present(req, data) {
    return (await can(req.user?.role, 'products.cost.view')) ? data : stripRestricted(data);
}

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
    const idempotencyKey = readIdempotencyKey(req);
    const { application, replayed } = await service.createCreditApplication(req.body, req.user, { idempotencyKey });

    res.status(replayed ? 200 : 201).json({
        ok: true,
        data: await present(req, application),
        replayed,
        message: replayed
            ? `La solicitud #${application.application_number} ya estaba registrada (envío repetido)`
            : `Solicitud de crédito #${application.application_number} registrada`,
    });
});

export const list = asyncHandler(async (req, res) => {
    const result = await service.listCreditApplications(req.validatedQuery, req.user);
    res.json({ ok: true, data: await present(req, result.data), pagination: result.pagination });
});

export const getOne = asyncHandler(async (req, res) => {
    const application = await service.getCreditApplication(req.params.id, req.user);
    res.json({ ok: true, data: await present(req, application) });
});
