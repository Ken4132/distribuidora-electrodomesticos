import { Router } from 'express';
import * as ctrl from '../controllers/receipt.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { idParam } from '../validators/common.schema.js';
import { listReceiptsSchema } from '../validators/receipt.schema.js';

const router = Router();
router.use(requireAuth);

/**
 * El recibo documenta un pago, así que se consulta con el MISMO permiso con
 * el que se consultan los pagos: `payments.view`. No se crea un permiso
 * nuevo ni se cambia el modelo de autorización existente.
 *
 * El aislamiento por sucursal se ofrece como FILTRO (`branchId`), no como
 * restricción: hoy `payments.view` es global —el vendedor también lo tiene,
 * en coherencia con `sales.view`— y convertirlo en un permiso con alcance
 * sería cambiar una regla del bloque 1, no cerrar el 4.3.
 */
router.get('/', requirePermission('payments.view', { module: 'pagos' }), validate({ query: listReceiptsSchema }), ctrl.list);

router.get('/:id', requirePermission('payments.view', { module: 'pagos' }), validate({ params: idParam }), ctrl.getOne);

export default router;
