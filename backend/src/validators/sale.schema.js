import { z } from 'zod';
import { isoDate, pagination, optionalText } from './common.schema.js';
import { PAYMENT_MODE_KEYS } from '../utils/pricing.js';

const saleItem = z
    .object({
        product_id: z.coerce.number().int().positive('Producto inválido'),
        quantity: z.coerce
            .number()
            .int('La cantidad debe ser un número entero')
            .min(1, 'La cantidad mínima es 1')
            .max(9999, 'Cantidad demasiado alta'),
    })
    .strict();

export const createSaleSchema = z
    .object({
        customer_id: z.coerce.number().int().positive('Debes seleccionar un cliente'),
        payment_mode: z.enum(PAYMENT_MODE_KEYS, {
            errorMap: () => ({ message: 'Modalidad de pago inválida (contado, credito_4 o credito_8)' }),
        }),
        sale_date: isoDate.optional(),
        items: z.array(saleItem).min(1, 'La venta debe incluir al menos un producto').max(50),
        notes: optionalText(1000),
    })
    .strict();

export const quoteSaleSchema = z
    .object({
        payment_mode: z.enum(PAYMENT_MODE_KEYS),
        sale_date: isoDate.optional(),
        items: z.array(saleItem).min(1, 'Agrega al menos un producto').max(50),
    })
    .strict();

export const listSalesSchema = pagination.extend({
    search: z.string().trim().max(100).default(''),
    customerId: z.coerce.number().int().positive().optional(),
    accountStatus: z.enum(['pendiente', 'al_dia', 'vencida', 'pagada', 'anulada', '']).default(''),
    from: isoDate.optional(),
    to: isoDate.optional(),
});

export const cancelSaleSchema = z
    .object({ reason: z.string().trim().min(3, 'Indica el motivo de la anulación').max(500) })
    .strict();
