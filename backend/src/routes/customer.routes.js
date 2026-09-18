import { Router } from 'express';
import * as ctrl from '../controllers/customer.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, audit } from '../middleware/permissions.js';
import { idParam } from '../validators/common.schema.js';
import {
    createCustomerSchema,
    updateCustomerSchema,
    listCustomersSchema,
    setActiveSchema,
    confirmCustomerSchema,
} from '../validators/customer.schema.js';

const router = Router();
router.use(requireAuth);

const MODULE = 'clientes';

router.get('/', requirePermission('customers.view'), validate({ query: listCustomersSchema }), ctrl.list);

router.post(
    '/',
    requirePermission('customers.create'),
    validate({ body: createCustomerSchema }),
    audit('customer.create', {
        module: MODULE,
        entity: 'customer',
        summary: (req, payload) => `Registró al cliente ${payload?.data?.full_name} (DPI ${payload?.data?.dpi})`,
    }),
    ctrl.create
);

router.get('/:id', requirePermission('customers.view'), validate({ params: idParam }), ctrl.getOne);

router.get(
    '/:id/account',
    requirePermission('customers.view'),
    validate({ params: idParam }),
    ctrl.account
);

router.put(
    '/:id',
    requirePermission('customers.update'),
    validate({ params: idParam, body: updateCustomerSchema }),
    audit('customer.update', {
        module: MODULE,
        entity: 'customer',
        summary: (req, payload) => `Modificó al cliente ${payload?.data?.full_name}`,
        details: (req) => ({ campos: Object.keys(req.body ?? {}) }),
    }),
    ctrl.update
);

/**
 * Reconfirmación de datos (regla 9): obligatoria antes de una nueva solicitud
 * de crédito de un cliente que ya tiene operaciones.
 */
router.get(
    '/:id/confirmations',
    requirePermission('customers.view'),
    validate({ params: idParam }),
    ctrl.listConfirmations
);

router.post(
    '/:id/confirmations',
    requirePermission('customers.update'),
    validate({ params: idParam, body: confirmCustomerSchema }),
    audit('customer.confirm', {
        module: MODULE,
        entity: 'customer',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) =>
            `Reconfirmó los datos del cliente ${payload?.data?.customer?.full_name}` +
            (payload?.data?.confirmation?.changed_fields?.length
                ? ` (cambió: ${payload.data.confirmation.changed_fields.join(', ')})`
                : ' (sin cambios)'),
        details: (req, payload) => ({
            confirmacion_id: payload?.data?.confirmation?.id ?? null,
            campos_modificados: payload?.data?.confirmation?.changed_fields ?? [],
        }),
    }),
    ctrl.confirm
);

router.patch(
    '/:id/status',
    requirePermission('customers.status'),
    validate({ params: idParam, body: setActiveSchema }),
    audit('customer.status', {
        module: MODULE,
        entity: 'customer',
        summary: (req, payload) =>
            `${req.body?.is_active ? 'Activó' : 'Desactivó'} al cliente ${payload?.data?.full_name}`,
    }),
    ctrl.setActive
);

export default router;
