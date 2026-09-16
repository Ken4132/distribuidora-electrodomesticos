/**
 * REGLAS COMERCIALES VIGENTES DE CRÉDITO (Bloque 3)
 *
 * Fuente: instrucciones del proyecto, confirmadas por el propietario.
 *
 *   CONTADO:       costo + 30%
 *
 *   PREDEFINIDOS:  4 cuotas  -> +40%
 *                  5 cuotas  -> +50%
 *                  6 cuotas  -> +60%
 *                  10 cuotas -> +80%
 *                  12 cuotas -> +100%
 *
 *   ESPECIALES:    6 -> +60%   7 -> +65%   8 -> +70%   9 -> +75%
 *                  10 -> +80%  11 -> +90%  12 -> +100%
 *                  más de 12: +10 puntos por cada cuota adicional
 *                  (13 -> +110%, 18 -> +160%, 24 -> +220%)
 *
 * IMPORTANTE: este módulo NO sustituye a `utils/pricing.js`. Aquel contiene
 * las reglas HISTÓRICAS del módulo de ventas (+50% en 4 pagos, +70% en 8),
 * que siguen gobernando las ventas existentes y no se reinterpretan. Las
 * operaciones de crédito nuevas usan EXCLUSIVAMENTE este archivo.
 *
 * Toda la aritmética es entera (centavos y centésimas de punto porcentual)
 * con BigInt: ningún float interviene en un importe.
 */

export const CASH_MARKUP_PERCENT = 30;

export const PREDEFINED_FINANCING = Object.freeze({
    4: 40,
    5: 50,
    6: 60,
    10: 80,
    12: 100,
});

export const SPECIAL_FINANCING = Object.freeze({
    6: 60,
    7: 65,
    8: 70,
    9: 75,
    10: 80,
    11: 90,
    12: 100,
});

export const SPECIAL_MIN_INSTALLMENTS = 6;

/** Importe canónico: hasta 8 enteros y como máximo 2 decimales. */
const MONEY_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;

/** Porcentaje tal como lo devuelve NUMERIC(7,2). */
const PERCENT_PATTERN = /^\d{1,5}(\.\d{1,2})?$/;

/** ¿El texto es un importe válido con máximo dos decimales? */
export function isMoneyString(value) {
    return typeof value === 'string' && MONEY_PATTERN.test(value);
}

/** '1500.5' -> 150050n. Lanza TypeError si el formato no es válido. */
export function moneyToCents(value) {
    const text = String(value ?? '').trim();
    if (!MONEY_PATTERN.test(text)) {
        throw new TypeError(`Importe monetario inválido: ${text}`);
    }
    const [whole, decimal = ''] = text.split('.');
    return BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
}

/** 150050n -> '1500.50' */
export function centsToMoney(cents) {
    const value = BigInt(cents);
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    const decimal = String(absolute % 100n).padStart(2, '0');
    return `${negative ? '-' : ''}${absolute / 100n}.${decimal}`;
}

/** '40.00' -> 4000n (centésimas de punto porcentual). */
export function percentToHundredths(value) {
    const text = String(value ?? '').trim();
    if (!PERCENT_PATTERN.test(text)) {
        throw new TypeError(`Porcentaje inválido: ${text}`);
    }
    const [whole, decimal = ''] = text.split('.');
    return BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
}

/** División entera redondeando el medio hacia arriba (valores no negativos). */
export function divideHalfUp(numerator, denominator) {
    const n = BigInt(numerator);
    const d = BigInt(denominator);
    if (d <= 0n) throw new RangeError('El divisor debe ser positivo');
    if (n < 0n) throw new RangeError('El dividendo no puede ser negativo');
    return (n * 2n + d) / (2n * d);
}

/**
 * Precio a partir del costo y el recargo, redondeado al centavo con el medio
 * centavo hacia arriba (mismo criterio que la regla R2 del proyecto).
 *
 * @param {bigint} costCents
 * @param {bigint} percentHundredths  4000n = 40%
 * @returns {bigint} centavos
 */
export function priceFromCost(costCents, percentHundredths) {
    const cost = BigInt(costCents);
    const pct = BigInt(percentHundredths);
    return divideHalfUp(cost * (10000n + pct), 10000n);
}

/** Mayor de dos importes en centavos (BigInt). */
export function maxCents(a, b) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x > y ? x : y;
}

/**
 * PRECIO MÍNIMO UNITARIO EFECTIVO (decisión confirmada 2026-09-16).
 *
 * El mínimo configurado por Administración nunca puede quedar por debajo
 * del mínimo matemático costo x (1 + porcentaje vigente). La base de datos
 * impide configurarlo así (008); si el costo sube después de configurar el
 * plan, o el plan es anterior a 008, aquí se aplica el mayor de los dos.
 *
 * @param {bigint} mathematicalUnitCents  costo x (1 + pct)
 * @param {bigint|null} configuredUnitCents  plan.minimum_price (null en ESPECIAL)
 */
export function effectiveMinimumPrice(mathematicalUnitCents, configuredUnitCents = null) {
    if (configuredUnitCents === null || configuredUnitCents === undefined) return BigInt(mathematicalUnitCents);
    return maxCents(mathematicalUnitCents, configuredUnitCents);
}

/**
 * CUOTA MÍNIMA EFECTIVA DE UNA LÍNEA (decisión confirmada 2026-09-16).
 *
 *   MAX( cuota matemática = round(precio mínimo unitario x cantidad / cuotas),
 *        cuota mínima configurada por unidad x cantidad )
 *
 * La cuota configurada nunca puede permitir una cuota inferior a la
 * matemática. `minimum_installment` del plan se interpreta POR UNIDAD, igual
 * que `minimum_price`.
 *
 * @returns {{mathematical: bigint, configured: bigint|null, effective: bigint}}
 */
export function effectiveMinimumInstallment(minimumUnitCents, quantity, installmentsCount, configuredUnitCents = null) {
    const qty = BigInt(quantity);
    const mathematical = divideHalfUp(BigInt(minimumUnitCents) * qty, BigInt(installmentsCount));
    const configured =
        configuredUnitCents === null || configuredUnitCents === undefined ? null : BigInt(configuredUnitCents) * qty;
    return { mathematical, configured, effective: configured === null ? mathematical : maxCents(mathematical, configured) };
}

/** Recargo vigente de un plan PREDEFINIDO, o null si el plazo no es predefinido. */
export function predefinedPercentage(installmentsCount) {
    const term = Number(installmentsCount);
    return Object.prototype.hasOwnProperty.call(PREDEFINED_FINANCING, term) ? PREDEFINED_FINANCING[term] : null;
}

/**
 * ¿El porcentaje configurado en `product_financing_plans` coincide con la
 * regla vigente para ese plazo? Compara en centésimas exactas ('40.00' = 40).
 */
export function planMatchesPredefinedRule(installmentsCount, configuredPercentage) {
    const expected = predefinedPercentage(installmentsCount);
    if (expected === null) return false;
    try {
        return percentToHundredths(configuredPercentage) === BigInt(expected) * 100n;
    } catch {
        return false;
    }
}

/**
 * Recargo de un plazo ESPECIAL, o null si el plazo no admite financiamiento
 * especial (menos de 6 cuotas).
 */
export function specialPercentage(installmentsCount) {
    const term = Number(installmentsCount);
    if (!Number.isInteger(term) || term < SPECIAL_MIN_INSTALLMENTS) return null;
    if (Object.prototype.hasOwnProperty.call(SPECIAL_FINANCING, term)) return SPECIAL_FINANCING[term];
    return 100 + (term - 12) * 10;
}
