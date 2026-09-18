import { Router } from 'express';
import * as ctrl from '../controllers/deposit.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, requireAnyPermission, audit } from '../middleware/permissions.js';
import { idParam } from '../validators/common.schema.js';
import {
    createDepositSchema,
    addPaymentsSchema,
    depositCommentSchema,
    validateDepositSchema,
    listDepositsSchema,
} from '../validators/deposit.schema.js';

const router = Router();
router.use(requireAuth);

const MODULE = 'depositos';
const number = (req, payload) => payload?.data?.deposit_number ?? `D-${String(req.params.id).padStart(6, '0')}`;

/** Cifras de conciliación que se guardan en la bitácora de cada operación. */
const reconciliation = (payload) => ({
    declarado: payload?.data?.reconciliation?.monto_declarado ?? null,
    esperado: payload?.data?.reconciliation?.monto_esperado ?? null,
    diferencia: payload?.data?.reconciliation?.diferencia ?? null,
    pagos: payload?.data?.reconciliation?.pagos_incluidos ?? null,
});

router.get('/', requirePermission('deposits.view', { module: MODULE }), validate({ query: listDepositsSchema }), ctrl.list);

router.post(
    '/',
    requirePermission('deposits.create', { module: MODULE }),
    validate({ body: createDepositSchema }),
    audit('deposit.create', {
        module: MODULE,
        entity: 'deposit',
        entityId: (_req, payload) => payload?.data?.id ?? null,
        summary: (req, payload) =>
            `Registró el depósito ${number(req, payload)} por Q${req.body?.declared_amount}` +
            ` con ${payload?.data?.payments_count ?? 0} pago(s).` +
            ` Diferencia Q${payload?.data?.reconciliation?.diferencia ?? '?'}`,
        details: (req, payload) => ({
            ...reconciliation(payload),
            sucursal: payload?.data?.branch_code ?? null,
            banco: req.body?.bank ?? null,
            referencia: req.body?.reference ?? null,
            pagos_incluidos: req.body?.payment_ids ?? [],
        }),
    }),
    ctrl.create
);

router.get('/:id', requirePermission('deposits.view', { module: MODULE }), validate({ params: idParam }), ctrl.getOne);

router.post(
    '/:id/payments',
    requirePermission('deposits.create', { module: MODULE }),
    validate({ params: idParam, body: addPaymentsSchema }),
    audit('deposit.payments.add', {
        module: MODULE,
        entity: 'deposit',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) =>
            `Incluyó ${req.body?.payment_ids?.length ?? 0} pago(s) en el depósito ${number(req, payload)}.` +
            ` Diferencia Q${payload?.data?.reconciliation?.diferencia ?? '?'}`,
        details: (req, payload) => ({ ...reconciliation(payload), pagos: req.body?.payment_ids ?? [] }),
    }),
    ctrl.addPayments
);

/**
 * OBSERVAR y RECHAZAR son actos de la revisión (administración y gerencia).
 * EXPLICAR lo hace quien armó el depósito, así que también entra quien puede
 * crearlos. Ninguno de los tres cambia el estado: son historial.
 */
router.post(
    '/:id/observations',
    requirePermission('deposits.review', { module: MODULE }),
    validate({ params: idParam, body: depositCommentSchema }),
    audit('deposit.observe', {
        module: MODULE,
        entity: 'deposit',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) => `Observó el depósito ${number(req, payload)}: ${req.body?.comment}`,
        details: (req, payload) => ({ ...reconciliation(payload), comentario: req.body?.comment }),
    }),
    ctrl.observe
);

router.post(
    '/:id/explanations',
    requireAnyPermission('deposits.create', 'deposits.review', { module: MODULE }),
    validate({ params: idParam, body: depositCommentSchema }),
    audit('deposit.explain', {
        module: MODULE,
        entity: 'deposit',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) => `Explicó el depósito ${number(req, payload)}: ${req.body?.comment}`,
        details: (req) => ({ comentario: req.body?.comment }),
    }),
    ctrl.explain
);

router.post(
    '/:id/rejections',
    requirePermission('deposits.review', { module: MODULE }),
    validate({ params: idParam, body: depositCommentSchema }),
    audit('deposit.reject', {
        module: MODULE,
        entity: 'deposit',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) =>
            `Rechazó el depósito ${number(req, payload)} (evento de historial, sigue REVISADO): ${req.body?.comment}`,
        details: (req, payload) => ({ ...reconciliation(payload), motivo: req.body?.comment }),
    }),
    ctrl.reject
);

router.post(
    '/:id/validate',
    requirePermission('deposits.review', { module: MODULE }),
    validate({ params: idParam, body: validateDepositSchema }),
    audit('deposit.validate', {
        module: MODULE,
        entity: 'deposit',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) =>
            `Validó el depósito ${number(req, payload)}. Declarado Q${payload?.data?.declared_amount},` +
            ` esperado Q${payload?.data?.reconciliation?.monto_esperado}, diferencia Q${payload?.data?.reconciliation?.diferencia}`,
        details: (req, payload) => ({ ...reconciliation(payload), comentario: req.body?.comment ?? null }),
    }),
    ctrl.validateOne
);

export default router;
