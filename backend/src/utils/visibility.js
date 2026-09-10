/**
 * RN-0001 y RN-0002 de la tesis:
 *
 *   "Únicamente el administrador podrá visualizar y modificar los costos
 *    de los productos."
 *   "Los vendedores únicamente podrán visualizar los precios de venta
 *    autorizados."
 *
 * El costo se quita en la capa de respuesta, no en el SQL, por dos razones:
 *   1. El servicio de ventas SÍ necesita el costo para congelarlo en
 *      sale_items; quitarlo de la consulta rompería la trazabilidad.
 *   2. Un solo punto de salida es más fácil de auditar que seis consultas
 *      con un WHERE condicional.
 *
 * Regla: si el permiso `products.cost.view` no está, el campo no viaja.
 * Nunca se envía en cero ni en blanco — se elimina, para que el frontend no
 * pueda confundir "no autorizado" con "costo cero".
 */

const COST_FIELDS = ['cost', 'unit_cost'];

function stripFrom(value) {
    if (Array.isArray(value)) return value.map(stripFrom);
    if (!value || typeof value !== 'object') return value;

    const out = {};
    for (const [key, val] of Object.entries(value)) {
        if (COST_FIELDS.includes(key)) continue;
        out[key] = val && typeof val === 'object' ? stripFrom(val) : val;
    }
    return out;
}

/**
 * Devuelve el mismo dato sin los campos de costo cuando no hay permiso.
 * Con permiso devuelve el objeto original, sin copiarlo.
 */
export function hideCostUnlessAllowed(data, allowed) {
    if (allowed) return data;
    return stripFrom(data);
}
