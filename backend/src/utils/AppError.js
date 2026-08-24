/**
 * Error de negocio controlado. Todo lo que no sea AppError se trata como
 * error interno y NO se expone al cliente.
 */
export class AppError extends Error {
    constructor(message, statusCode = 400, code = 'BAD_REQUEST', details = undefined) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        this.isOperational = true;
    }

    static badRequest(msg, details) {
        return new AppError(msg, 400, 'BAD_REQUEST', details);
    }
    static unauthorized(msg = 'No autenticado') {
        return new AppError(msg, 401, 'UNAUTHORIZED');
    }
    static forbidden(msg = 'No autorizado para esta operación') {
        return new AppError(msg, 403, 'FORBIDDEN');
    }
    static notFound(msg = 'Recurso no encontrado') {
        return new AppError(msg, 404, 'NOT_FOUND');
    }
    static conflict(msg, details) {
        return new AppError(msg, 409, 'CONFLICT', details);
    }
    static unprocessable(msg, details) {
        return new AppError(msg, 422, 'UNPROCESSABLE', details);
    }
}
