/** Envuelve un controlador async para que sus rechazos lleguen al errorHandler. */
export const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
