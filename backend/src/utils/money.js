/**
 * Utilidades de dinero.
 *
 * Regla del proyecto: la aritmética de dinero se hace en CENTAVOS (enteros).
 * Nunca sumar/multiplicar floats de quetzales — 0.1 + 0.2 !== 0.3 en IEEE-754
 * y en un plan de 8 cuotas ese error se acumula.
 *
 * PostgreSQL devuelve NUMERIC como string; `toCents` acepta string o número.
 */

export function toCents(value) {
    if (value === null || value === undefined || value === '') return 0;
    const n = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(n)) {
        throw new TypeError(`Valor monetario inválido: ${value}`);
    }
    return Math.round(n * 100);
}

export function fromCents(cents) {
    return Math.round(cents) / 100;
}

/** Devuelve un string con 2 decimales, apto para insertar en NUMERIC(12,2). */
export function money(value) {
    return fromCents(toCents(value)).toFixed(2);
}

/** Suma una lista de valores monetarios sin perder precisión. */
export function sumMoney(values) {
    return fromCents(values.reduce((acc, v) => acc + toCents(v), 0));
}

/**
 * Reparte un total en `count` cuotas iguales.
 * El residuo de centavos se suma a la ÚLTIMA cuota, de modo que
 * la suma de las cuotas es exactamente igual al total (invariante crítica).
 *
 * @returns {number[]} montos en quetzales, longitud = count
 */
export function splitInstallments(total, count) {
    if (!Number.isInteger(count) || count < 1) {
        throw new TypeError('El número de cuotas debe ser un entero >= 1');
    }
    const totalCents = toCents(total);
    const base = Math.floor(totalCents / count);
    const remainder = totalCents - base * count;

    const parts = Array.from({ length: count }, () => base);
    parts[count - 1] += remainder;
    return parts.map(fromCents);
}
