import { Router } from 'express';
import * as ctrl from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiters } from '../middleware/rateLimit.js';
import { loginSchema } from '../validators/auth.schema.js';

const router = Router();

/**
 * Freno a la fuerza bruta sobre el login. Dos limitadores a la vez:
 * por IP + usuario (principal) y por IP (global, más alto). Ambos cuentan
 * SOLO los intentos fallidos. Ver middleware/rateLimit.js.
 *
 * Van ANTES de `validate`: un cuerpo mal formado también es un intento y
 * también cuenta; si no, bastaría con enviar basura para no gastar contador.
 */
router.post('/login', ...loginLimiters, validate({ body: loginSchema }), ctrl.login);
router.get('/me', requireAuth, ctrl.me);
router.post('/logout', requireAuth, ctrl.logout);

// La creación de usuarios vivía aquí como POST /auth/users. Se movió a su
// propio módulo (POST /api/users) al implementar REQ-0010 y REQ-0011, para
// que la administración de cuentas tenga un solo lugar y quede protegida por
// el permiso `users.manage` en vez de por un rol fijo.

export default router;
