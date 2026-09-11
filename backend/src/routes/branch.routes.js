import { Router } from 'express';
import * as ctrl from '../controllers/branch.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, audit } from '../middleware/permissions.js';
import { idParam } from '../validators/common.schema.js';
import { setActiveSchema } from '../validators/customer.schema.js';
import { createBranchSchema, updateBranchSchema, listBranchesSchema } from '../validators/branch.schema.js';

const router = Router();
router.use(requireAuth);

const MODULE = 'sucursales';

router.get('/', requirePermission('branches.view', { module: MODULE }), validate({ query: listBranchesSchema }), ctrl.list);

router.post(
    '/',
    requirePermission('branches.manage', { module: MODULE }),
    validate({ body: createBranchSchema }),
    audit('branch.create', {
        module: MODULE,
        entity: 'branch',
        summary: (req, payload) => `Registró la sucursal ${payload?.data?.code} — ${payload?.data?.name}`,
    }),
    ctrl.create
);

router.get(
    '/:id',
    requirePermission('branches.view', { module: MODULE }),
    validate({ params: idParam }),
    ctrl.getOne
);

router.put(
    '/:id',
    requirePermission('branches.manage', { module: MODULE }),
    validate({ params: idParam, body: updateBranchSchema }),
    audit('branch.update', {
        module: MODULE,
        entity: 'branch',
        summary: (req, payload) => `Modificó la sucursal ${payload?.data?.code} — ${payload?.data?.name}`,
        details: (req) => ({ campos: Object.keys(req.body ?? {}) }),
    }),
    ctrl.update
);

router.patch(
    '/:id/status',
    requirePermission('branches.manage', { module: MODULE }),
    validate({ params: idParam, body: setActiveSchema }),
    audit('branch.status', {
        module: MODULE,
        entity: 'branch',
        summary: (req, payload) =>
            `${req.body?.is_active ? 'Activó' : 'Desactivó'} la sucursal ${payload?.data?.code}`,
    }),
    ctrl.setActive
);

/**
 * Cambiar la sucursal predeterminada tiene efecto operativo inmediato: a
 * partir de ahí, toda venta y todo ajuste sin sucursal descuentan de ella.
 * Por eso queda en la bitácora con su propia acción.
 */
router.patch(
    '/:id/default',
    requirePermission('branches.manage', { module: MODULE }),
    validate({ params: idParam }),
    audit('branch.default', {
        module: MODULE,
        entity: 'branch',
        summary: (req, payload) =>
            `Estableció ${payload?.data?.code} — ${payload?.data?.name} como sucursal predeterminada`,
    }),
    ctrl.makeDefault
);

export default router;
