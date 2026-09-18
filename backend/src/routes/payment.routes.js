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
        entityId: (req, payload) => payload?.data?.payment?.id ?? null,
        summary: (req, payload) =>
            (payload?.replayed ? 'Reenvío de un pago ya registrado' : 'Registró un pago') +
            ` de Q${Number(req.body?.amount).toFixed(2)} (${req.body?.method ?? 'efectivo'})` +
            ` en la venta ${payload?.data?.sale?.sale_number}.` +
            ` Saldo Q${payload?.data?.payment?.balance_before ?? '?'} → Q${payload?.data?.sale?.balance}`,
        details: (req, payload) => ({
            pago_id: payload?.data?.payment?.id ?? null,
            venta: payload?.data?.sale?.sale_number,
            monto: Number(req.body?.amount).toFixed(2),
            metodo: req.body?.method ?? 'efectivo',
            referencia: req.body?.reference ?? null,
            fecha_real: payload?.data?.payment?.payment_date ?? null,
            saldo_anterior: payload?.data?.payment?.balance_before ?? null,
            saldo_resultante: payload?.data?.sale?.balance,
            estado_comprobante: payload?.data?.payment?.voucher_status ?? null,
            reenvio: Boolean(payload?.replayed),
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
            `Anuló el pago P-${String(req.params.id).padStart(6, '0')} de la venta ${payload?.data?.sale_number}.` +
            ` Saldo resultante Q${payload?.data?.balance}. Motivo: ${req.body?.reason}`,
        details: (req, payload) => ({
            pago_id: Number(req.params.id),
            venta: payload?.data?.sale_number,
            motivo: req.body?.reason,
            saldo_resultante: payload?.data?.balance,
        }),
    }),
    ctrl.voidOne
);

export default router;
