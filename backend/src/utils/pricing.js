/**
 * REGLAS COMERCIALES DE PRECIO — definidas por el negocio.
 *
 *   contado     -> costo + 30%   (1 pago)
 *   credito_4   -> costo + 50%   (4 pagos)   HISTÓRICO
 *   credito_8   -> costo + 70%   (8 pagos)   HISTÓRICO
 *
 * Los dos modos de crédito de este módulo son HISTÓRICOS: gobiernan las ventas
 * ya registradas y no se reinterpretan, pero desde el bloque 3.3 ninguna venta
 * NUEVA se registra con ellos. Un crédito nuevo nace siempre de una solicitud
 * aprobada y usa las reglas vigentes de `utils/creditPricing.js`.
 *
 * NO modificar estos porcentajes sin autorización expresa del propietario
 * del negocio. La base de datos también los aplica en columnas generadas
 * (products.price_cash / price_credit_4 / price_credit_8); este módulo es
 * la contraparte en la aplicación y debe mantenerse sincronizado.
 */
import { toCents, fromCents } from './money.js';

export const PAYMENT_MODES = Object.freeze({
    contado: { key: 'contado', label: 'Contado', markup: 0.3, installments: 1, priceField: 'price_cash', legacy: false },
    credito_4: { key: 'credito_4', label: 'Crédito 4 pagos', markup: 0.5, installments: 4, priceField: 'price_credit_4', legacy: true },
    credito_8: { key: 'credito_8', label: 'Crédito 8 pagos', markup: 0.7, installments: 8, priceField: 'price_credit_8', legacy: true },
});

export const PAYMENT_MODE_KEYS = Object.keys(PAYMENT_MODES);

/**
 * Modalidades admitidas en una venta NUEVA por `POST /sales`.
 *
 * Desde el bloque 3.3 toda venta a crédito nace de una solicitud APROBADA y se
 * registra con `POST /credit-applications/:id/concretize` (modalidad
 * `credito`). `credito_4` y `credito_8` se conservan ÚNICAMENTE para las
 * ventas históricas: siguen leyéndose, calculándose y cobrándose igual que
 * siempre, pero ya no se pueden registrar ventas nuevas con ellas.
 */
export const NEW_SALE_PAYMENT_MODE_KEYS = Object.freeze(
    PAYMENT_MODE_KEYS.filter((key) => !PAYMENT_MODES[key].legacy)
);

/** ¿La modalidad quedó solo para históricos? */
export function isLegacyPaymentMode(mode) {
    return Boolean(PAYMENT_MODES[mode]?.legacy);
}

export function isValidPaymentMode(mode) {
    return Object.prototype.hasOwnProperty.call(PAYMENT_MODES, mode);
}

export function installmentsFor(mode) {
    const m = PAYMENT_MODES[mode];
    if (!m) throw new Error(`Modalidad de pago desconocida: ${mode}`);
    return m.installments;
}

/** Precio unitario para un costo dado y una modalidad. Redondeo a 2 decimales. */
export function priceFor(cost, mode) {
    const m = PAYMENT_MODES[mode];
    if (!m) throw new Error(`Modalidad de pago desconocida: ${mode}`);
    return fromCents(Math.round(toCents(cost) * (1 + m.markup)));
}

/** Devuelve los tres precios calculados a partir del costo. */
export function priceTable(cost) {
    return {
        contado: priceFor(cost, 'contado'),
        credito_4: priceFor(cost, 'credito_4'),
        credito_8: priceFor(cost, 'credito_8'),
    };
}

/** Nombre de la columna de precio del producto según la modalidad. */
export function priceFieldFor(mode) {
    const m = PAYMENT_MODES[mode];
    if (!m) throw new Error(`Modalidad de pago desconocida: ${mode}`);
    return m.priceField;
}
