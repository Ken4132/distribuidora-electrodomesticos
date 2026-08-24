import { z } from 'zod';
import { isoDate, pagination, optionalText } from './common.schema.js';

export const PAYMENT_METHODS = ['efectivo', 'transferencia', 'deposito', 'tarjeta', 'cheque', 'otro'];

export const createPaymentSchema = z
    .object({
        sale_id: z.coerce.number().int().positive('Debes seleccionar una venta'),
        amount: z.coerce
            .number({ invalid_type_error: 'El monto debe ser numérico' })
            .positive('El monto debe ser mayor a cero')
            .max(99_999_999, 'Monto demasiado alto'),
        payment_date: isoDate.optional(),
        method: z.enum(PAYMENT_METHODS).default('efectivo'),
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
    .object({ reason: z.string().trim().min(3, 'Indica el motivo de la anulación').max(500) })
    .strict();

export const receivablesSchema = pagination.extend({
    status: z.enum(['pendiente', 'al_dia', 'vencida', '']).default(''),
    customerId: z.coerce.number().int().positive().optional(),
});
