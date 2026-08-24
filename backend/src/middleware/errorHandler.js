import { AppError } from '../utils/AppError.js';
import { config } from '../config/env.js';

export function notFoundHandler(req, res) {
    res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: `Ruta no encontrada: ${req.method} ${req.originalUrl}` },
    });
}

/** Traduce errores de PostgreSQL a mensajes de negocio comprensibles. */
function translatePgError(err) {
    switch (err.code) {
        case '23505': {
            // unique_violation
            if (err.constraint === 'ux_customers_dpi')
                return AppError.conflict('Ya existe un cliente registrado con ese DPI');
            if (err.constraint === 'ux_products_code')
                return AppError.conflict('Ya existe un producto con ese código');
            if (err.constraint === 'users_username_key')
                return AppError.conflict('Ese nombre de usuario ya está en uso');
            return AppError.conflict('El registro ya existe (valor duplicado)');
        }
        case '23503': // foreign_key_violation
            return AppError.badRequest('Referencia inválida: el registro relacionado no existe');
        case '23514': {
            // check_violation
            if (err.constraint === 'customers_dpi_format')
                return AppError.unprocessable('El DPI debe contener exactamente 13 dígitos');
            if (err.constraint === 'products_stock_check')
                return AppError.unprocessable('El stock no puede quedar negativo');
            return AppError.unprocessable('Los datos no cumplen una regla de validación de la base de datos');
        }
        case '22P02': // invalid_text_representation
            return AppError.badRequest('Formato de dato inválido');
        case '23502': // not_null_violation
            return AppError.unprocessable(`El campo "${err.column}" es obligatorio`);
        default:
            return null;
    }
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
    let error = err;

    if (!(error instanceof AppError) && error?.code) {
        error = translatePgError(err) ?? err;
    }

    if (error instanceof AppError) {
        return res.status(error.statusCode).json({
            ok: false,
            error: { code: error.code, message: error.message, details: error.details },
        });
    }

    // Error no controlado: se registra completo en servidor, se oculta al cliente.
    console.error('[error]', req.method, req.originalUrl, '\n', err);
    return res.status(500).json({
        ok: false,
        error: {
            code: 'INTERNAL_ERROR',
            message: 'Ocurrió un error interno. Intenta de nuevo.',
            ...(config.isProd ? {} : { debug: err.message }),
        },
    });
}
