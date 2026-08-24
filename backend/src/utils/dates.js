/**
 * Manejo de fechas.
 *
 * Regla del proyecto: las fechas de NEGOCIO (venta, pago, vencimiento) se
 * manejan como cadenas 'YYYY-MM-DD' sin hora ni zona. Así lo que se guarda
 * es exactamente lo que ve el usuario, y n8n recibe algo inequívoco.
 * Las marcas de tiempo técnicas (created_at) sí son TIMESTAMPTZ en UTC.
 */
import { config } from '../config/env.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' correspondiente a hoy en la zona horaria del negocio. */
export function today() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: config.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

export function isIsoDate(value) {
    if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Suma `n` meses a una fecha 'YYYY-MM-DD' conservando el día cuando existe.
 * Si el día no existe en el mes destino (31 -> febrero), usa el último día
 * del mes. Es el criterio habitual de cobranza y evita saltos de mes.
 */
export function addMonths(isoDate, n) {
    if (!isIsoDate(isoDate)) throw new TypeError(`Fecha inválida: ${isoDate}`);
    const [y, m, d] = isoDate.split('-').map(Number);

    const targetMonthIndex = m - 1 + n;
    const targetYear = y + Math.floor(targetMonthIndex / 12);
    const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const day = Math.min(d, lastDay);

    return [
        String(targetYear).padStart(4, '0'),
        String(targetMonth + 1).padStart(2, '0'),
        String(day).padStart(2, '0'),
    ].join('-');
}

/**
 * Calendario de vencimientos de una venta.
 *  - contado: una sola "cuota" que vence el mismo día de la venta.
 *  - crédito: una cuota por mes, la primera a 30 días (1 mes) de la venta.
 */
export function buildDueDates(saleDate, installmentsCount) {
    if (installmentsCount === 1) return [saleDate];
    return Array.from({ length: installmentsCount }, (_, i) => addMonths(saleDate, i + 1));
}
