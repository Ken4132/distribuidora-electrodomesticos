import { z } from 'zod';
import { isoDate, pagination, optionalText } from './common.schema.js';
import { NEW_SALE_PAYMENT_MODE_KEYS, PAYMENT_MODE_KEYS } from '../utils/pricing.js';

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
        // Solo `contado`: una venta a crédito NUEVA nace de una solicitud
        // aprobada (POST /credit-applications/:id/concretize). credito_4 y
        // credito_8 quedan solo para las ventas históricas.
        payment_mode: z.enum(NEW_SALE_PAYMENT_MODE_KEYS, {
            errorMap: () => ({
                message:
                    'Una venta nueva solo puede registrarse al contado. Las ventas a crédito se registran concretando una solicitud de crédito aprobada.',
            }),
        }),
        sale_date: isoDate.optional(),
        items: z.array(saleItem).min(1, 'La venta debe incluir al menos un producto').max(50),
        notes: optionalText(1000),
    })
    .strict();

export const quoteSaleSchema = z
    .object({
        // El cálculo en vivo NO registra nada. Se deja abierto a las tres
        // modalidades porque es lo que permite comprobar la regla de precios
        // histórica (R1) de credito_4 y credito_8 sin crear ventas nuevas.
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
    .object({ reason: z.string().trim().min(5, 'Indica el motivo de la anulación (al menos 5 caracteres)').max(500) })
    .strict();
