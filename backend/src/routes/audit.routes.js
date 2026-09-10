import { Router } from 'express';
import * as ctrl from '../controllers/audit.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { listAuditSchema } from '../validators/audit.schema.js';

const router = Router();

/**
 * REQ-0016: "La bitácora únicamente podrá ser consultada por el administrador
 * del sistema." Aquí se traduce al permiso `audit.view`, que de fábrica solo
 * tiene el rol de administrador.
 *
 * La bitácora es de solo lectura desde la API: no hay POST, PUT ni DELETE.
 * Las entradas las escribe el propio sistema, y la base de datos impide
 * modificarlas (migración 003, RN-0006).
 */
router.use(requireAuth, requirePermission('audit.view', { module: 'seguridad' }));

router.get('/', validate({ query: listAuditSchema }), ctrl.list);
router.get('/filters', ctrl.filters);

export default router;
