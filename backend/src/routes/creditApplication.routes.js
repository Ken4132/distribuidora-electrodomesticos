import { Router } from 'express';
import * as ctrl from '../controllers/creditApplication.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, requireAnyPermission, audit } from '../middleware/permissions.js';
import {
    createCreditApplicationSchema,
    creditApplicationIdSchema,
    listCreditApplicationsSchema,
    quoteCreditApplicationSchema,
    verificationSchema,
    concludeVerificationSchema,
    modifyConditionsSchema,
    decisionSchema,
    cancelSchema,
    concretizeSchema,
    finalReviewSchema,
} from '../validators/creditApplication.schema.js';

const router = Router();
router.use(requireAuth);

const MODULE = 'creditos';

/**
 * Consultar exige AL MENOS uno de los permisos de alcance. Cuál aplica
 * (todas, sucursal por verificar o propias) lo resuelve el servicio, que
 * además filtra en el SQL: lo que no corresponde nunca sale de la base.
 */
const VIEW_PERMISSIONS = ['credits.view', 'credits.view.branch', 'credits.view.own'];

router.get(
    '/',
    requireAnyPermission(...VIEW_PERMISSIONS, { module: MODULE }),
    validate({ query: listCreditApplicationsSchema }),
    ctrl.list
);

router.post(
    '/',
    requirePermission('credits.create', { module: MODULE }),
    validate({ body: createCreditApplicationSchema }),
    audit('credit_application.create', {
        module: MODULE,
        entity: 'credit_application',
        entityId: (req, payload) => payload?.data?.id ?? null,
        summary: (req, payload) =>
            payload?.replayed
                ? `Reenvío de la solicitud de crédito #${payload?.data?.application_number} (no se creó otra)`
                : `Registró la solicitud de crédito #${payload?.data?.application_number} de ${payload?.data?.customer_full_name_snapshot} por Q${payload?.data?.total}`,
        details: (req, payload) => ({
            solicitud_id: payload?.data?.id ?? null,
            numero: payload?.data?.application_number ?? null,
            cliente_id: payload?.data?.customer_id ?? null,
            sucursal_id: payload?.data?.branch_id ?? null,
            total: payload?.data?.total ?? null,
            enganche_propuesto: payload?.data?.proposed_down_payment ?? null,
            productos: payload?.data?.items_count ?? null,
            requiere_excepcion_de_precio: payload?.data?.requires_price_exception ?? null,
            reenvio: Boolean(payload?.replayed),
        }),
    }),
    ctrl.create
);

router.get(
    '/:id',
    requireAnyPermission(...VIEW_PERMISSIONS, { module: MODULE }),
    validate({ params: creditApplicationIdSchema }),
    audit('credit_application.view', {
        module: MODULE,
        entity: 'credit_application',
        summary: (req, payload) => `Consultó la solicitud de crédito #${payload?.data?.application_number}`,
    }),
    ctrl.getOne
);

// El cálculo en vivo no guarda nada, pero revela mínimos: exige poder crear solicitudes.
router.post(
    '/quote',
    requirePermission('credits.create', { module: MODULE }),
    validate({ body: quoteCreditApplicationSchema }),
    ctrl.quote
);

// ---------------------------------------------------------------------
// BLOQUE 3.2 — verificación, modificación, decisión, cancelación
// ---------------------------------------------------------------------

const appRef = (payload, req) => `#${payload?.data?.application_number ?? req.params.id}`;

router.post(
    '/:id/verifications',
    requirePermission('credits.verify', { module: MODULE }),
    validate({ params: creditApplicationIdSchema, body: verificationSchema }),
    audit('credit_application.verify', {
        module: MODULE,
        entity: 'credit_application',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) =>
            `Registró una verificación ${req.body?.result} en la solicitud ${appRef(payload, req)}` +
            (req.body?.conclude ? ' y la envió a evaluación' : ''),
        details: (req, payload) => ({
            resultado: req.body?.result,
            recomendacion: req.body?.recommendation,
            concluida: Boolean(req.body?.conclude),
            estado: payload?.data?.status,
        }),
    }),
    ctrl.registerVerification
);

router.post(
    '/:id/verifications/conclude',
    requirePermission('credits.verify', { module: MODULE }),
    validate({ params: creditApplicationIdSchema, body: concludeVerificationSchema }),
    audit('credit_application.verification_concluded', {
        module: MODULE,
        entity: 'credit_application',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) => `Envió a evaluación la solicitud ${appRef(payload, req)}`,
    }),
    ctrl.concludeVerification
);

/**
 * Modificación de condiciones (precio, plazo, enganche, PRODUCTOS y
 * CANTIDADES). La puede hacer Administración/Gerencia (`credits.decide`) o el
 * vendedor que registró la solicitud (`credits.modify.own`). Cuál de los dos
 * alcances aplica, y si la modificación deja la solicitud pendiente de la
 * última revisión, lo decide el servicio: es el único que ve el expediente.
 */
router.patch(
    '/:id/conditions',
    requireAnyPermission('credits.decide', 'credits.modify.own', { module: MODULE }),
    validate({ params: creditApplicationIdSchema, body: modifyConditionsSchema }),
    audit('credit_application.modify', {
        module: MODULE,
        entity: 'credit_application',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) =>
            `Modificó las condiciones de la solicitud ${appRef(payload, req)}` +
            (payload?.data?.requires_final_review ? ' (pendiente de la última revisión de Administración o Gerencia)' : ''),
        details: (req, payload) => ({
            lineas: (req.body?.items ?? []).map((i) => i.item_id),
            lineas_agregadas: (req.body?.add_items ?? []).map((i) => i.product_id),
            lineas_retiradas: (req.body?.void_items ?? []).map((i) => i.item_id),
            enganche: req.body?.proposed_down_payment ?? null,
            comentario: req.body?.comment ?? null,
            total_resultante: payload?.data?.total ?? null,
            requiere_revision_final: payload?.data?.requires_final_review ?? null,
        }),
    }),
    ctrl.modifyConditions
);

/**
 * Última revisión: NO es una segunda decisión. Solo confirma o rechaza los
 * cambios que el vendedor hizo después de la aprobación. Cobrador no participa.
 */
router.post(
    '/:id/final-review',
    requirePermission('credits.review.final', { module: MODULE }),
    validate({ params: creditApplicationIdSchema, body: finalReviewSchema }),
    audit('credit_application.final_review', {
        module: MODULE,
        entity: 'credit_application',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) =>
            `${req.body?.result === 'CONFIRMADO' ? 'Confirmó' : 'Rechazó'} en la última revisión los cambios ` +
            `posteriores a la aprobación de la solicitud ${appRef(payload, req)}` +
            (req.body?.comment ? `. ${req.body.comment}` : ''),
        details: (req, payload) => ({
            resultado: req.body?.result,
            comentario: req.body?.comment ?? null,
            excepciones: req.body?.exceptions ?? [],
            requiere_revision_final: payload?.data?.requires_final_review ?? null,
        }),
    }),
    ctrl.finalReview
);

router.get(
    '/:id/evaluation',
    requirePermission('credits.decide', { module: MODULE }),
    validate({ params: creditApplicationIdSchema }),
    ctrl.evaluation
);

router.post(
    '/:id/decision',
    requirePermission('credits.decide', { module: MODULE }),
    validate({ params: creditApplicationIdSchema, body: decisionSchema }),
    audit('credit_application.decide', {
        module: MODULE,
        entity: 'credit_application',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) =>
            `${req.body?.decision === 'APROBADO' ? 'Aprobó' : 'Rechazó'} la solicitud ${appRef(payload, req)}` +
            (req.body?.exceptions?.length ? ` autorizando ${req.body.exceptions.length} excepción(es)` : ''),
        details: (req) => ({
            decision: req.body?.decision,
            comentario: req.body?.comment ?? null,
            excepciones: req.body?.exceptions ?? [],
        }),
    }),
    ctrl.decide
);

router.post(
    '/:id/cancel',
    requireAnyPermission('credits.cancel', 'credits.create', { module: MODULE }),
    validate({ params: creditApplicationIdSchema, body: cancelSchema }),
    audit('credit_application.cancel', {
        module: MODULE,
        entity: 'credit_application',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) => `Canceló la solicitud ${appRef(payload, req)}. Motivo: ${req.body?.reason}`,
    }),
    ctrl.cancel
);

// ---------------------------------------------------------------------
// BLOQUE 3.3 — venta concretada
// ---------------------------------------------------------------------

router.post(
    '/:id/concretize',
    requireAnyPermission('credits.concretize', 'credits.concretize.own', { module: MODULE }),
    validate({ params: creditApplicationIdSchema, body: concretizeSchema }),
    audit('credit_application.concretize', {
        module: MODULE,
        entity: 'credit_application',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) =>
            `Concretó la venta ${payload?.data?.sale?.sale_number} de la solicitud #${payload?.data?.application?.application_number ?? req.params.id}` +
            ` por Q${payload?.data?.sale?.total} con enganche real Q${req.body?.down_payment ?? '0.00'}`,
        details: (req, payload) => ({
            venta_id: payload?.data?.sale?.id ?? null,
            total: payload?.data?.sale?.total ?? null,
            enganche_real: req.body?.down_payment ?? '0.00',
            metodo: req.body?.payment_method ?? null,
            cuotas: payload?.data?.sale?.installments_count ?? null,
            saldo: payload?.data?.sale?.balance ?? null,
        }),
    }),
    ctrl.concretize
);

export default router;
