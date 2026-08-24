import { Router } from 'express';
import * as ctrl from '../controllers/integration.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { idParam } from '../validators/common.schema.js';
import { listEventsSchema } from '../validators/integration.schema.js';

const router = Router();

// La bandeja de salida expone datos de clientes y montos, y permite reenviar
// eventos. Solo administradores.
router.use(requireAuth, requireRole('admin'));

router.get('/status', ctrl.status);
router.get('/event-types', ctrl.catalog);
router.get('/events', validate({ query: listEventsSchema }), ctrl.list);
router.get('/events/:id', validate({ params: idParam }), ctrl.getOne);
router.post('/events/:id/retry', validate({ params: idParam }), ctrl.retry);
router.post('/dispatch', ctrl.dispatchNow);
router.post('/collections/scan', ctrl.scanNow);
router.get('/collections/preview', ctrl.preview);

export default router;
