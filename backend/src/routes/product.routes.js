import { Router } from 'express';
import * as ctrl from '../controllers/product.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, audit } from '../middleware/permissions.js';
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

const MODULE = 'productos';

router.get('/', requirePermission('products.view'), validate({ query: listProductsSchema }), ctrl.list);
router.get('/categories', requirePermission('products.view'), ctrl.categories);

/**
 * RN-0001: la vista previa de precios parte del COSTO, así que exige el
 * permiso de ver costos. Sin él, un vendedor podría deducir el costo
 * probando valores hasta que el precio calculado coincidiera con el del
 * catálogo.
 */
router.get(
    '/price-preview',
    requirePermission('products.cost.view'),
    validate({ query: previewPricesSchema }),
    ctrl.previewPrices
);

router.post(
    '/',
    requirePermission('products.create'),
    validate({ body: createProductSchema }),
    audit('product.create', {
        module: MODULE,
        entity: 'product',
        summary: (req, payload) => `Registró el producto ${payload?.data?.code} — ${payload?.data?.name}`,
    }),
    ctrl.create
);

router.get('/:id', requirePermission('products.view'), validate({ params: idParam }), ctrl.getOne);

router.get(
    '/:id/stock-movements',
    requirePermission('products.view'),
    validate({ params: idParam }),
    ctrl.stockMovements
);

/**
 * Existencias del producto desglosadas por sucursal, como CONSULTA
 * INFORMATIVA.
 *
 * Va con `products.view`, no con `inventory.view`: el vendedor tiene
 * derecho a SABER que hay unidades en otra sucursal. Lo que la respuesta
 * deja claro, fila por fila, es cuáles son operativas para él —solo las de
 * su sucursal— y cuáles solo puede mirar.
 */
router.get(
    '/:id/inventory',
    requirePermission('products.view'),
    validate({ params: idParam }),
    ctrl.inventory
);

/**
 * Histórico de costos. RN-0001: el costo a lo largo del tiempo es el mismo
 * secreto que el costo actual, así que va detrás del mismo permiso.
 */
router.get(
    '/:id/cost-history',
    requirePermission('products.cost.view'),
    validate({ params: idParam }),
    ctrl.costHistory
);

router.put(
    '/:id',
    requirePermission('products.update'),
    validate({ params: idParam, body: updateProductSchema }),
    audit('product.update', {
        module: MODULE,
        entity: 'product',
        summary: (req, payload) => `Modificó el producto ${payload?.data?.code} — ${payload?.data?.name}`,
        // Se registra QUE cambió el costo, no cuánto: la bitácora la puede
        // leer cualquiera con permiso de auditoría.
        details: (req) => ({ campos: Object.keys(req.body ?? {}), tocó_costo: req.body?.cost !== undefined }),
    }),
    ctrl.update
);

router.patch(
    '/:id/status',
    requirePermission('products.status'),
    validate({ params: idParam, body: setActiveSchema }),
    audit('product.status', {
        module: MODULE,
        entity: 'product',
        summary: (req, payload) =>
            `${req.body?.is_active ? 'Activó' : 'Desactivó'} el producto ${payload?.data?.code}`,
    }),
    ctrl.setActive
);

router.post(
    '/:id/stock',
    requirePermission('products.stock'),
    validate({ params: idParam, body: adjustStockSchema }),
    audit('product.stock', {
        module: MODULE,
        entity: 'product',
        summary: (req, payload) =>
            `Ajustó el inventario de ${payload?.data?.code} en ${req.body?.delta > 0 ? '+' : ''}${req.body?.delta} (existencia: ${payload?.data?.stock})`,
        details: (req) => ({ delta: req.body?.delta, motivo: req.body?.reason ?? null }),
    }),
    ctrl.adjustStock
);

export default router;
