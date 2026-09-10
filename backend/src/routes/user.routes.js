import { Router } from 'express';
import * as ctrl from '../controllers/user.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, audit } from '../middleware/permissions.js';
import { idParam } from '../validators/common.schema.js';
import {
    createUserSchema,
    updateUserSchema,
    listUsersSchema,
    setUserActiveSchema,
    changePasswordSchema,
    changeOwnPasswordSchema,
} from '../validators/user.schema.js';

const router = Router();
router.use(requireAuth);

const MODULE = 'seguridad';

/**
 * Cambiar la propia contraseña no requiere permiso de administración: es una
 * acción sobre la cuenta de quien la ejecuta. Va antes de "/:id" para que
 * "me" no se confunda con un identificador.
 */
router.post(
    '/me/password',
    validate({ body: changeOwnPasswordSchema }),
    audit('user.password.self', {
        module: MODULE,
        entity: 'user',
        entityId: (req) => req.user?.id ?? null,
        summary: (req) => `${req.user?.username} cambió su propia contraseña`,
    }),
    ctrl.changeOwnPassword
);

router.get('/', requirePermission('users.view'), validate({ query: listUsersSchema }), ctrl.list);

router.post(
    '/',
    requirePermission('users.manage'),
    validate({ body: createUserSchema }),
    audit('user.create', {
        module: MODULE,
        entity: 'user',
        summary: (req, payload) =>
            `Creó el usuario "${payload?.data?.username}" con rol ${payload?.data?.role}`,
        details: (req, payload) => ({ username: payload?.data?.username, role: payload?.data?.role }),
    }),
    ctrl.create
);

router.get('/:id', requirePermission('users.view'), validate({ params: idParam }), ctrl.getOne);

router.put(
    '/:id',
    requirePermission('users.manage'),
    validate({ params: idParam, body: updateUserSchema }),
    audit('user.update', {
        module: MODULE,
        entity: 'user',
        summary: (req, payload) => `Modificó el usuario "${payload?.data?.username}"`,
        details: (req) => ({ cambios: Object.keys(req.body ?? {}) }),
    }),
    ctrl.update
);

router.patch(
    '/:id/status',
    requirePermission('users.manage'),
    validate({ params: idParam, body: setUserActiveSchema }),
    audit('user.status', {
        module: MODULE,
        entity: 'user',
        summary: (req, payload) =>
            `${req.body?.is_active ? 'Activó' : 'Desactivó'} el usuario "${payload?.data?.username}"`,
    }),
    ctrl.setActive
);

router.post(
    '/:id/password',
    requirePermission('users.manage'),
    validate({ params: idParam, body: changePasswordSchema }),
    audit('user.password.reset', {
        module: MODULE,
        entity: 'user',
        summary: (req, payload) => `Restableció la contraseña de "${payload?.data?.username}"`,
    }),
    ctrl.resetPassword
);

export default router;
