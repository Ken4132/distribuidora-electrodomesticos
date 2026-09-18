import { z } from 'zod';
import { isoDate, pagination, optionalText } from './common.schema.js';
import { today } from '../utils/dates.js';

/**
 * MÉTODOS DE PAGO.
 *
 * `PAYMENT_METHODS` es el catálogo COMPLETO, incluidos los históricos: sirve
 * para leer, listar y filtrar pagos ya registrados.
 *
 * `NEW_PAYMENT_METHODS` son los operativos, los únicos con los que se puede
 * registrar un pago NUEVO (decisión del propietario, 2026-09-18). `cheque` y
 * `otro` se retiraron: el cheque casi no se usa y "otro" era un comodín. Los
 * pagos que ya existen con esos métodos no se tocan ni se convierten.
 */
export const NEW_PAYMENT_METHODS = ['efectivo', 'transferencia', 'deposito', 'remesa', 'tarjeta'];

/** Solo quedan en pagos históricos. */
export const LEGACY_PAYMENT_METHODS = ['cheque', 'otro'];

export const PAYMENT_METHODS = [...NEW_PAYMENT_METHODS, ...LEGACY_PAYMENT_METHODS];

export const createPaymentSchema = z
    .object({
        sale_id: z.coerce.number().int().positive('Debes seleccionar una venta'),
        amount: z.coerce
            .number({ invalid_type_error: 'El monto debe ser numérico' })
            .positive('El monto debe ser mayor a cero')
            .max(99_999_999, 'Monto demasiado alto'),
        /**
         * Fecha ECONÓMICA del pago (regla PG1). Puede ser anterior a la de
         * registro —un cobro que se documenta tarde— pero nunca futura. Que no
         * sea anterior a la venta se comprueba en el servicio, que es quien lee
         * la venta bloqueada. La base lo vuelve a impedir con un trigger.
         */
        payment_date: isoDate
            .refine((value) => value <= today(), { message: 'La fecha del pago no puede ser futura' })
            .optional(),
        method: z
            .enum(NEW_PAYMENT_METHODS, {
                errorMap: () => ({
                    message: `Método de pago inválido. Métodos operativos: ${NEW_PAYMENT_METHODS.join(', ')}`,
                }),
            })
            .default('efectivo'),
        reference: optionalText(80),
        notes: optionalText(1000),
    })
    .strict();

export const listPaymentsSchema = pagination.extend({
    customerId: z.coerce.number().int().positive().optional(),
    saleId: z.coerce.number().int().positive().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
});

export const voidPaymentSchema = z
    .object({ reason: z.string().trim().min(5, 'Indica el motivo de la anulación (al menos 5 caracteres)').max(500) })
    .strict();

export const receivablesSchema = pagination.extend({
    status: z.enum(['pendiente', 'al_dia', 'vencida', '']).default(''),
    customerId: z.coerce.number().int().positive().optional(),
});
