import { Router } from 'express';
import * as ctrl from '../controllers/customer.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { idParam } from '../validators/common.schema.js';
import {
    createCustomerSchema,
    updateCustomerSchema,
    listCustomersSchema,
    setActiveSchema,
} from '../validators/customer.schema.js';

const router = Router();
router.use(requireAuth);

router.get('/', validate({ query: listCustomersSchema }), ctrl.list);
router.post('/', validate({ body: createCustomerSchema }), ctrl.create);
router.get('/:id', validate({ params: idParam }), ctrl.getOne);
router.get('/:id/account', validate({ params: idParam }), ctrl.account);
router.put('/:id', validate({ params: idParam, body: updateCustomerSchema }), ctrl.update);
router.patch('/:id/status', validate({ params: idParam, body: setActiveSchema }), ctrl.setActive);

export default router;
