import { z } from 'zod';
import { pagination, optionalText } from './common.schema.js';

export const listInventorySchema = pagination.extend({
    branch_id: z.coerce.number().int().positive().optional(),
    search: z.string().trim().max(100).default(''),
    restock: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
    withStock: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
});

/**
 * Ajuste de existencias en una sucursal concreta.
 * `delta` positivo = entrada, negativo = salida. No se admite cero: un
 * movimiento que no mueve nada solo ensucia la trazabilidad.
 */
export const adjustInventorySchema = z
    .object({
        product_id: z.coerce.number().int().positive('Producto inválido'),
        branch_id: z.coerce.number().int().positive('Sucursal inválida'),
        delta: z.coerce
            .number()
            .int('La cantidad debe ser un número entero')
            .refine((n) => n !== 0, 'La cantidad no puede ser cero'),
        reason: z.string().trim().max(40).default('ajuste_manual'),
        notes: optionalText(300),
    })
    .strict();

export const setMinStockSchema = z
    .object({
        product_id: z.coerce.number().int().positive('Producto inválido'),
        branch_id: z.coerce.number().int().positive('Sucursal inválida'),
        min_stock: z.coerce.number().int().min(0, 'El mínimo no puede ser negativo'),
    })
    .strict();
