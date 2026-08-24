import { AppError } from '../utils/AppError.js';

/**
 * Valida body / query / params con esquemas Zod y REEMPLAZA el valor por el
 * resultado parseado (ya saneado y con tipos correctos).
 * Cualquier campo no declarado en el esquema se descarta: el cliente no
 * puede inyectar columnas que no le corresponden.
 */
export function validate({ body, query, params }) {
    return (req, _res, next) => {
        try {
            if (params) req.params = params.parse(req.params);
            if (query) req.validatedQuery = query.parse(req.query);
            if (body) req.body = body.parse(req.body);
            next();
        } catch (error) {
            if (error?.issues) {
                const details = error.issues.map((i) => ({
                    campo: i.path.join('.') || '(raíz)',
                    mensaje: i.message,
                }));
                return next(AppError.unprocessable('Datos inválidos', details));
            }
            next(error);
        }
    };
}
