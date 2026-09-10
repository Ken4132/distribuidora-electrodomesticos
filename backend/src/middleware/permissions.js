/**
 * Middleware de permisos y de bitácora.
 *
 * `requirePermission` sustituye a `requireRole` en las rutas: en lugar de
 * preguntar "¿eres administrador?" pregunta "¿tu rol tiene este permiso?",
 * que es lo que exige REQ-0011 y lo que permite que el administrador cambie
 * los accesos sin tocar el código.
 *
 * `audit` registra la operación DESPUÉS de que salió bien, envolviendo la
 * respuesta. Se hace aquí, en la ruta, y no dentro de cada servicio, para no
 * reescribir la firma de los servicios que ya funcionan y están probados.
 */
import { can, canAny } from '../services/authorization.service.js';
import { recordAudit, actorFrom } from '../services/audit.service.js';
import { AppError } from '../utils/AppError.js';

/**
 * Exige un permiso concreto. Usar SIEMPRE después de requireAuth.
 * Un intento denegado queda registrado en la bitácora: saber quién intentó
 * entrar donde no debía es justamente para lo que sirve una auditoría.
 */
export function requirePermission(permission, options = {}) {
    return async (req, _res, next) => {
        try {
            if (!req.user) return next(AppError.unauthorized());

            if (await can(req.user.role, permission)) return next();

            await recordAudit({
                actor: actorFrom(req),
                action: 'acceso.denegado',
                module: options.module ?? 'seguridad',
                summary: `Acceso denegado a ${req.method} ${req.originalUrl} (falta el permiso ${permission})`,
                details: { permission, method: req.method, path: req.originalUrl },
                result: 'denegado',
            });

            return next(AppError.forbidden('Tu rol no tiene permiso para esta operación'));
        } catch (error) {
            next(error);
        }
    };
}

/**
 * Exige AL MENOS UNO de varios permisos.
 *
 * Se usa donde la misma operación admite dos alcances: por ejemplo cobrar
 * puede venir de `payments.create` (cualquier venta) o de
 * `payments.create.own` (solo la cartera propia). Este middleware únicamente
 * deja fuera a quien no tiene ninguno de los dos; **cuál de los dos alcances
 * aplica lo decide el servicio**, que es el único que sabe sobre qué venta se
 * está operando.
 */
export function requireAnyPermission(...permissions) {
    const options = typeof permissions.at(-1) === 'object' ? permissions.pop() : {};

    return async (req, _res, next) => {
        try {
            if (!req.user) return next(AppError.unauthorized());

            if (await canAny(req.user.role, permissions)) return next();

            await recordAudit({
                actor: actorFrom(req),
                action: 'acceso.denegado',
                module: options.module ?? 'seguridad',
                summary: `Acceso denegado a ${req.method} ${req.originalUrl} (no tiene ninguno de: ${permissions.join(', ')})`,
                details: { permissions, method: req.method, path: req.originalUrl },
                result: 'denegado',
            });

            return next(AppError.forbidden('Tu rol no tiene permiso para esta operación'));
        } catch (error) {
            next(error);
        }
    };
}

/**
 * Registra la operación en la bitácora si la respuesta fue correcta.
 *
 * @param {string} action                  'customer.create', 'payment.void', ...
 * @param {object} options
 * @param {string} [options.module]
 * @param {string} [options.entity]
 * @param {(req, payload) => string} options.summary
 * @param {(req, payload) => number|null} [options.entityId]
 * @param {(req, payload) => object|null} [options.details]
 */
export function audit(action, options = {}) {
    const { module = null, entity = null, summary, entityId, details } = options;

    return (req, res, next) => {
        const sendJson = res.json.bind(res);

        res.json = (payload) => {
            // Se responde primero y se registra después: la bitácora no debe
            // añadir latencia ni poder romper una respuesta ya construida.
            const out = sendJson(payload);

            if (res.statusCode >= 200 && res.statusCode < 400) {
                try {
                    const id =
                        (typeof entityId === 'function' ? entityId(req, payload) : null) ??
                        payload?.data?.id ??
                        (req.params?.id ? Number(req.params.id) : null);

                    void recordAudit({
                        actor: actorFrom(req),
                        action,
                        module,
                        entity,
                        entityId: Number.isFinite(id) ? id : null,
                        summary: typeof summary === 'function' ? summary(req, payload) : String(summary ?? action),
                        details: typeof details === 'function' ? details(req, payload) : null,
                    });
                } catch (error) {
                    console.error(`[bitacora] Error preparando la entrada "${action}":`, error.message);
                }
            }

            return out;
        };

        next();
    };
}
