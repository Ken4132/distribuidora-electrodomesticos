import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as ctrl from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { loginSchema, createUserSchema } from '../validators/auth.schema.js';

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
router.post('/users', requireAuth, requireRole('admin'), validate({ body: createUserSchema }), ctrl.createUser);

export default router;
