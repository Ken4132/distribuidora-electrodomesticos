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
    assignBranchSchema,
    setUserPermissionSchema,
    clearUserPermissionSchema,
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

/**
 * Asignación de sucursal. Permiso propio (`branches.assign`) y no
 * `users.manage`: saber en qué local trabaja cada quien es una decisión
 * organizativa, no la misma que crear cuentas o cambiar roles. En la
 * migración 004 solo lo tiene el administrador.
 */
router.patch(
    '/:id/branch',
    requirePermission('branches.assign', { module: MODULE }),
    validate({ params: idParam, body: assignBranchSchema }),
    audit('user.branch', {
        module: MODULE,
        entity: 'user',
        summary: (req, payload) =>
            payload?.data?.branch_name
                ? `Asignó el usuario "${payload?.data?.username}" a la sucursal ${payload?.data?.branch_name}`
                : `Quitó la sucursal al usuario "${payload?.data?.username}"`,
        details: (req) => ({ sucursal_id: req.body?.branch_id ?? null }),
    }),
    ctrl.assignBranch
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


// ---------------------------------------------------------------------
// PERMISOS ADICIONALES POR USUARIO (012)
//
// Permiso propio (`users.permissions`) y no `users.manage`: conceder a un
// Cobrador la capacidad de vender no es lo mismo que crear cuentas o cambiar
// roles. En la migración 012 solo lo tiene Administración.
// ---------------------------------------------------------------------

router.get('/catalog/permissions', requirePermission('users.permissions', { module: MODULE }), ctrl.permissionCatalog);

router.get(
    '/:id/permissions',
    requirePermission('users.permissions', { module: MODULE }),
    validate({ params: idParam }),
    ctrl.permissions
);

router.put(
    '/:id/permissions',
    requirePermission('users.permissions', { module: MODULE }),
    validate({ params: idParam, body: setUserPermissionSchema }),
    audit('user.permission.set', {
        module: MODULE,
        entity: 'user',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) =>
            `${req.body?.effect === 'GRANT' ? 'Concedió' : 'Retiró'} el permiso "${req.body?.permission_code}" ` +
            `${req.body?.effect === 'GRANT' ? 'a' : 'de'} "${payload?.data?.user?.username}". Motivo: ${req.body?.reason}`,
        details: (req) => ({
            permiso: req.body?.permission_code,
            efecto: req.body?.effect,
            motivo: req.body?.reason,
        }),
    }),
    ctrl.setPermission
);

router.delete(
    '/:id/permissions',
    requirePermission('users.permissions', { module: MODULE }),
    validate({ params: idParam, body: clearUserPermissionSchema }),
    audit('user.permission.clear', {
        module: MODULE,
        entity: 'user',
        entityId: (req) => Number(req.params.id),
        summary: (req, payload) =>
            `Quitó la excepción del permiso "${req.body?.permission_code}" de "${payload?.data?.user?.username}": ` +
            `vuelve a los permisos de su rol. Motivo: ${req.body?.reason}`,
        details: (req) => ({ permiso: req.body?.permission_code, motivo: req.body?.reason }),
    }),
    ctrl.clearPermission
);

export default router;
