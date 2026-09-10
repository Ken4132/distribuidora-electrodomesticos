import { Router } from 'express';
import * as ctrl from '../controllers/payment.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, requireAnyPermission, audit } from '../middleware/permissions.js';
import { idParam } from '../validators/common.schema.js';
import {
    createPaymentSchema,
    listPaymentsSchema,
    voidPaymentSchema,
    receivablesSchema,
} from '../validators/payment.schema.js';

const router = Router();
router.use(requireAuth);

const MODULE = 'pagos';

router.get('/methods', requirePermission('payments.view'), ctrl.methods);

router.get(
    '/receivables',
    requireAnyPermission('receivables.view', 'receivables.view.own', { module: MODULE }),
    validate({ query: receivablesSchema }),
    ctrl.receivables
);

router.get('/', requirePermission('payments.view'), validate({ query: listPaymentsSchema }), ctrl.list);

/**
 * REQ-0005: "Cada pago deberá quedar registrado en la bitácora del sistema
 * indicando el usuario responsable de la operación."
 */
router.post(
    '/',
    // Cualquiera de los dos alcances entra aquí; el servicio decide si ESTA
    // venta cae dentro de la cartera del usuario (regla U6).
    requireAnyPermission('payments.create', 'payments.create.own', { module: MODULE }),
    validate({ body: createPaymentSchema }),
    audit('payment.create', {
        module: MODULE,
        entity: 'payment',
        entityId: (req, payload) => payload?.data?.payments?.at(-1)?.id ?? null,
        summary: (req, payload) =>
            `Registró un pago de Q${Number(req.body?.amount).toFixed(2)} (${req.body?.method ?? 'efectivo'}) en la venta ${payload?.data?.sale?.sale_number}. Saldo: Q${payload?.data?.sale?.balance}`,
        details: (req, payload) => ({
            venta: payload?.data?.sale?.sale_number,
            monto: Number(req.body?.amount).toFixed(2),
            metodo: req.body?.method ?? 'efectivo',
            saldo_resultante: payload?.data?.sale?.balance,
        }),
    }),
    ctrl.create
);

router.get('/:id', requirePermission('payments.view'), validate({ params: idParam }), ctrl.getOne);

router.patch(
    '/:id/void',
    requirePermission('payments.void'),
    validate({ params: idParam, body: voidPaymentSchema }),
    audit('payment.void', {
        module: MODULE,
        entity: 'payment',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) =>
            `Anuló el pago #${req.params.id} de la venta ${payload?.data?.sale_number}. Motivo: ${req.body?.reason}`,
        details: (req, payload) => ({
            motivo: req.body?.reason,
            saldo_resultante: payload?.data?.balance,
        }),
    }),
    ctrl.voidOne
);

export default router;
