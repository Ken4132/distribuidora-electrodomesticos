import { Router } from 'express';
import * as ctrl from '../controllers/inventory.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, requireAnyPermission, audit } from '../middleware/permissions.js';
import {
    listInventorySchema,
    adjustInventorySchema,
    setMinStockSchema,
} from '../validators/inventory.schema.js';

const router = Router();
router.use(requireAuth);

const MODULE = 'inventario';

/**
 * CONSULTAR admite los dos alcances. Cuál se aplica lo decide el servicio,
 * que es el único que sabe de qué sucursal es el usuario; el middleware
 * solo deja fuera a quien no tiene ninguno de los dos permisos.
 */
const MAY_VIEW = ['inventory.view', 'inventory.view.own'];

router.get(
    '/',
    requireAnyPermission(...MAY_VIEW, { module: MODULE }),
    validate({ query: listInventorySchema }),
    ctrl.list
);

router.get('/summary', requireAnyPermission(...MAY_VIEW, { module: MODULE }), ctrl.summary);

/**
 * La consulta informativa de disponibilidad NO vive aquí.
 *
 * Está en `GET /api/products/:id/inventory`, protegida por `products.view`,
 * porque es información del catálogo y no del módulo de inventario. Tenerla
 * también bajo `/inventory` habría dejado un endpoint en este módulo que no
 * se rige por los permisos de inventario: justo la clase de contradicción
 * que la decisión sobre Cobros y Verificación pide evitar.
 *
 * Resultado: TODO lo que cuelga de `/api/inventory` exige `inventory.view`,
 * `inventory.view.own` o `inventory.manage`, sin excepciones.
 */

/**
 * El cuadre entre la existencia total y el desglose por sucursal es una
 * comprobación de integridad de toda la empresa, no de una sucursal: exige
 * el alcance global.
 */
router.get('/mismatches', requirePermission('inventory.view', { module: MODULE }), ctrl.mismatches);

router.post(
    '/adjust',
    requirePermission('inventory.manage', { module: MODULE }),
    validate({ body: adjustInventorySchema }),
    audit('inventory.adjust', {
        module: MODULE,
        entity: 'product',
        entityId: (req) => Number(req.body?.product_id) || null,
        summary: (req, payload) =>
            `Ajustó ${payload?.data?.product?.code} en ${req.body?.delta > 0 ? '+' : ''}${req.body?.delta} ` +
            `en la sucursal ${payload?.data?.branch?.name} (existencia: ${payload?.data?.quantity})`,
        details: (req) => ({
            sucursal_id: req.body?.branch_id,
            delta: req.body?.delta,
            motivo: req.body?.reason ?? null,
        }),
    }),
    ctrl.adjust
);

router.put(
    '/min-stock',
    requirePermission('inventory.manage', { module: MODULE }),
    validate({ body: setMinStockSchema }),
    audit('inventory.min_stock', {
        module: MODULE,
        entity: 'product',
        entityId: (req) => Number(req.body?.product_id) || null,
        summary: (req) =>
            `Fijó el mínimo de reposición en ${req.body?.min_stock} para el producto ${req.body?.product_id} ` +
            `en la sucursal ${req.body?.branch_id}`,
    }),
    ctrl.setMinStock
);

export default router;
