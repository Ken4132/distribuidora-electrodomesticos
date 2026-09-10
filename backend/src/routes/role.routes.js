import { Router } from 'express';
import * as ctrl from '../controllers/role.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, audit } from '../middleware/permissions.js';
import {
    roleCodeParam,
    createRoleSchema,
    updateRoleSchema,
    setRolePermissionsSchema,
} from '../validators/user.schema.js';

const router = Router();
router.use(requireAuth);

const MODULE = 'seguridad';

router.get('/', requirePermission('roles.view'), ctrl.list);
router.get('/permissions', requirePermission('roles.view'), ctrl.permissions);
router.get('/:code', requirePermission('roles.view'), validate({ params: roleCodeParam }), ctrl.getOne);

router.post(
    '/',
    requirePermission('roles.manage'),
    validate({ body: createRoleSchema }),
    audit('role.create', {
        module: MODULE,
        entity: 'role',
        summary: (req, payload) => `Creó el rol "${payload?.data?.name}" (${payload?.data?.code})`,
    }),
    ctrl.create
);

router.put(
    '/:code',
    requirePermission('roles.manage'),
    validate({ params: roleCodeParam, body: updateRoleSchema }),
    audit('role.update', {
        module: MODULE,
        entity: 'role',
        summary: (req) => `Modificó el rol "${req.params.code}"`,
    }),
    ctrl.update
);

router.put(
    '/:code/permissions',
    requirePermission('roles.manage'),
    validate({ params: roleCodeParam, body: setRolePermissionsSchema }),
    audit('role.permissions', {
        module: MODULE,
        entity: 'role',
        summary: (req, payload) =>
            `Cambió los permisos del rol "${req.params.code}": ${payload?.data?.permissions_count} permiso(s)`,
        details: (req) => ({ permisos: req.body?.permissions ?? [] }),
    }),
    ctrl.setPermissions
);

export default router;
