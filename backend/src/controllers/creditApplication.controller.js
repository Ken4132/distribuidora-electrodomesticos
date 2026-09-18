import * as service from '../services/creditApplication.service.js';
import * as workflow from '../services/creditWorkflow.service.js';
import * as creditSale from '../services/creditSale.service.js';
import { hideCostUnlessAllowed } from '../utils/visibility.js';
import { userCan } from '../services/authorization.service.js';
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
        // El historial de modificaciones guarda el campo como dato: se quitan
        // también las filas que registran cambios de costo o porcentaje.
        if (key === 'changes' && Array.isArray(val)) {
            out[key] = val.filter((c) => !RESTRICTED_FIELDS.includes(c?.field));
            continue;
        }
        out[key] = stripRestricted(val);
    }
    return out;
}

async function present(req, data) {
    return (await userCan(req.user, 'products.cost.view')) ? data : stripRestricted(data);
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

export const quote = asyncHandler(async (req, res) => {
    const data = await service.quoteCreditApplication(req.body);
    res.json({ ok: true, data: await present(req, data) });
});

// ---------------------------------------------------------------- 3.2

export const registerVerification = asyncHandler(async (req, res) => {
    const data = await workflow.registerVerification(req.params.id, req.body, req.user);
    res.status(201).json({
        ok: true,
        data: await present(req, data),
        message: req.body.conclude
            ? 'Verificación registrada y enviada a evaluación'
            : 'Verificación registrada',
    });
});

export const concludeVerification = asyncHandler(async (req, res) => {
    const data = await workflow.concludeVerification(req.params.id, req.user);
    res.json({ ok: true, data: await present(req, data), message: 'Verificación enviada a evaluación' });
});

export const modifyConditions = asyncHandler(async (req, res) => {
    const data = await workflow.modifyConditions(req.params.id, req.body, req.user);
    res.json({ ok: true, data: await present(req, data), message: 'Condiciones modificadas' });
});

export const decide = asyncHandler(async (req, res) => {
    const data = await workflow.decide(req.params.id, req.body, req.user);
    res.status(201).json({
        ok: true,
        data: await present(req, data),
        message: req.body.decision === 'APROBADO' ? 'Solicitud aprobada' : 'Solicitud rechazada',
    });
});

export const cancel = asyncHandler(async (req, res) => {
    const data = await workflow.cancel(req.params.id, req.body, req.user);
    res.json({ ok: true, data: await present(req, data), message: 'Solicitud cancelada' });
});

// ---------------------------------------------------------------- 3.3

export const concretize = asyncHandler(async (req, res) => {
    const data = await creditSale.concretize(req.params.id, req.body, req.user);
    const allowed = await userCan(req.user, 'products.cost.view');
    res.status(201).json({
        ok: true,
        data: allowed ? data : { application: stripRestricted(data.application), sale: hideCostUnlessAllowed(data.sale, false) },
        message: `Venta ${data.sale?.sale_number} concretada. Saldo: Q${data.sale?.balance}`,
    });
});

export const evaluation = asyncHandler(async (req, res) => {
    const data = await workflow.evaluationContext(req.params.id, req.user);
    res.json({ ok: true, data: await present(req, data) });
});

/** Última revisión de Administración o Gerencia sobre cambios posteriores a la aprobación. */
export const finalReview = asyncHandler(async (req, res) => {
    const data = await workflow.finalReview(req.params.id, req.body, req.user);
    res.json({
        ok: true,
        data: await present(req, data),
        message:
            req.body.result === 'CONFIRMADO'
                ? 'Cambios confirmados: la venta ya se puede concretar'
                : 'Cambios rechazados: la venta sigue bloqueada',
    });
});
