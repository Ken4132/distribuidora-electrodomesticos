import { Router } from 'express';
import * as ctrl from '../controllers/sale.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { idParam } from '../validators/common.schema.js';
import {
    createSaleSchema,
    quoteSaleSchema,
    listSalesSchema,
    cancelSaleSchema,
} from '../validators/sale.schema.js';

const router = Router();
router.use(requireAuth);

router.get('/payment-modes', ctrl.paymentModes);
router.get('/', validate({ query: listSalesSchema }), ctrl.list);
router.post('/quote', validate({ body: quoteSaleSchema }), ctrl.quote);
router.post('/', validate({ body: createSaleSchema }), ctrl.create);
router.get('/:id', validate({ params: idParam }), ctrl.getOne);
router.patch(
    '/:id/cancel',
    requireRole('admin'),
    validate({ params: idParam, body: cancelSaleSchema }),
    ctrl.cancel
);

export default router;
