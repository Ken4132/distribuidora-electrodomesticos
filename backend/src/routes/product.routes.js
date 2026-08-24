import { Router } from 'express';
import * as ctrl from '../controllers/product.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { idParam } from '../validators/common.schema.js';
import { setActiveSchema } from '../validators/customer.schema.js';
import {
    createProductSchema,
    updateProductSchema,
    listProductsSchema,
    adjustStockSchema,
    previewPricesSchema,
} from '../validators/product.schema.js';

const router = Router();
router.use(requireAuth);

router.get('/', validate({ query: listProductsSchema }), ctrl.list);
router.post('/', validate({ body: createProductSchema }), ctrl.create);
router.get('/categories', ctrl.categories);
router.get('/price-preview', validate({ query: previewPricesSchema }), ctrl.previewPrices);
router.get('/:id', validate({ params: idParam }), ctrl.getOne);
router.get('/:id/stock-movements', validate({ params: idParam }), ctrl.stockMovements);
router.put('/:id', validate({ params: idParam, body: updateProductSchema }), ctrl.update);
router.patch('/:id/status', validate({ params: idParam, body: setActiveSchema }), ctrl.setActive);
router.post('/:id/stock', validate({ params: idParam, body: adjustStockSchema }), ctrl.adjustStock);

export default router;
