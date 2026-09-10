import { Router } from 'express';
import * as ctrl from '../controllers/sale.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, audit } from '../middleware/permissions.js';
import { idParam } from '../validators/common.schema.js';
import {
    createSaleSchema,
    quoteSaleSchema,
    listSalesSchema,
    cancelSaleSchema,
} from '../validators/sale.schema.js';

const router = Router();
router.use(requireAuth);

const MODULE = 'ventas';

router.get('/payment-modes', requirePermission('sales.view'), ctrl.paymentModes);
router.get('/', requirePermission('sales.view'), validate({ query: listSalesSchema }), ctrl.list);

// El cálculo en vivo no persiste nada, pero revela precios: exige poder
// registrar ventas, igual que el formulario que lo usa.
router.post('/quote', requirePermission('sales.create'), validate({ body: quoteSaleSchema }), ctrl.quote);

router.post(
    '/',
    requirePermission('sales.create'),
    validate({ body: createSaleSchema }),
    audit('sale.create', {
        module: MODULE,
        entity: 'sale',
        summary: (req, payload) =>
            `Registró la venta ${payload?.data?.sale_number} a ${payload?.data?.customer_name} por Q${payload?.data?.total} (${payload?.data?.payment_mode})`,
        details: (req, payload) => ({
            modalidad: payload?.data?.payment_mode,
            total: payload?.data?.total,
            cuotas: payload?.data?.installments_count,
        }),
    }),
    ctrl.create
);

router.get('/:id', requirePermission('sales.view'), validate({ params: idParam }), ctrl.getOne);

router.patch(
    '/:id/cancel',
    requirePermission('sales.cancel'),
    validate({ params: idParam, body: cancelSaleSchema }),
    audit('sale.cancel', {
        module: MODULE,
        entity: 'sale',
        summary: (req, payload) =>
            `Anuló la venta ${payload?.data?.sale_number}. Motivo: ${req.body?.reason}`,
        details: (req) => ({ motivo: req.body?.reason }),
    }),
    ctrl.cancel
);

export default router;
