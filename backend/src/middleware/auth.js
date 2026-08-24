import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

export function signToken(user) {
    return jwt.sign(
        { sub: String(user.id), username: user.username, role: user.role },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn }
    );
}

/** Exige un JWT válido. Deja el usuario en req.user. */
export function requireAuth(req, _res, next) {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
        return next(AppError.unauthorized('Falta el token de autenticación'));
    }

    try {
        const payload = jwt.verify(token, config.jwt.secret);
        req.user = { id: Number(payload.sub), username: payload.username, role: payload.role };
        next();
    } catch (err) {
        const msg = err.name === 'TokenExpiredError' ? 'La sesión expiró, inicia sesión de nuevo' : 'Token inválido';
        next(AppError.unauthorized(msg));
    }
}

/** Restringe una ruta a determinados roles. Usar después de requireAuth. */
export function requireRole(...roles) {
    return (req, _res, next) => {
        if (!req.user) return next(AppError.unauthorized());
        if (!roles.includes(req.user.role)) {
            return next(AppError.forbidden('Tu rol no permite esta operación'));
        }
        next();
    };
}
