import { Router } from 'express';
import * as ctrl from '../controllers/payment.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { idParam } from '../validators/common.schema.js';
import {
    createPaymentSchema,
    listPaymentsSchema,
    voidPaymentSchema,
    receivablesSchema,
} from '../validators/payment.schema.js';

const router = Router();
router.use(requireAuth);

router.get('/methods', ctrl.methods);
router.get('/receivables', validate({ query: receivablesSchema }), ctrl.receivables);
router.get('/', validate({ query: listPaymentsSchema }), ctrl.list);
router.post('/', validate({ body: createPaymentSchema }), ctrl.create);
router.get('/:id', validate({ params: idParam }), ctrl.getOne);
router.patch(
    '/:id/void',
    requireRole('admin'),
    validate({ params: idParam, body: voidPaymentSchema }),
    ctrl.voidOne
);

export default router;
