import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as ctrl from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { loginSchema } from '../validators/auth.schema.js';

const router = Router();

// Freno a los intentos de fuerza bruta sobre el login.
const loginLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Demasiados intentos. Espera unos minutos.' } },
});

router.post('/login', loginLimiter, validate({ body: loginSchema }), ctrl.login);
router.get('/me', requireAuth, ctrl.me);
router.post('/logout', requireAuth, ctrl.logout);

// La creación de usuarios vivía aquí como POST /auth/users. Se movió a su
// propio módulo (POST /api/users) al implementar REQ-0010 y REQ-0011, para
// que la administración de cuentas tenga un solo lugar y quede protegida por
// el permiso `users.manage` en vez de por un rol fijo.

export default router;
