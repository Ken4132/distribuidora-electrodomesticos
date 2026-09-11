import { z } from 'zod';
import { optionalText, pagination, moneyInput, businessText, optionalBusinessText } from './common.schema.js';

const code = z
    .string({ required_error: 'El código es obligatorio' })
    .trim()
    .min(2, 'El código debe tener al menos 2 caracteres')
    .max(40, 'El código no puede exceder 40 caracteres')
    .regex(/^[A-Za-z0-9._-]+$/, 'El código solo admite letras, números, punto, guion y guion bajo')
    .transform((v) => v.toUpperCase());

export const createProductSchema = z
    .object({
        code,
        name: businessText(2, 150, 'El nombre'),
        // La descripción es un dato de negocio escrito por el usuario y se
        // normaliza como el resto (decisión del propietario, 2026-09-11).
        description: optionalBusinessText(1000),
        category: businessText(2, 80, 'La categoría').default('GENERAL'),
        brand: optionalBusinessText(80),
        model: optionalBusinessText(80),
        cost: moneyInput('El costo'),
        stock: z.coerce.number().int().min(0, 'El stock no puede ser negativo').default(0),
        min_stock: z.coerce.number().int().min(0, 'El stock mínimo no puede ser negativo').default(0),
        // Taxonomía como entidad. Si viene, manda sobre el texto: el backend
        // escribe en `category` / `brand` el nombre de la entidad.
        category_id: z.coerce.number().int().positive().nullable().optional(),
        brand_id: z.coerce.number().int().positive().nullable().optional(),
        // Motivo del costo inicial, para el histórico.
        cost_notes: optionalText(300),
    })
    .strict();

export const updateProductSchema = createProductSchema.omit({ stock: true }).partial().strict();

export const listProductsSchema = pagination.extend({
    search: z.string().trim().max(100).default(''),
    category: z.string().trim().max(80).default(''),
    // Navegación CATEGORÍA -> MARCA -> PRODUCTOS.
    category_id: z.coerce.number().int().positive().optional(),
    brand_id: z.coerce.number().int().positive().optional(),
    status: z.enum(['all', 'active', 'inactive']).default('all'),
    lowStock: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
});

export const adjustStockSchema = z
    .object({
        delta: z.coerce
            .number()
            .int('La cantidad debe ser un número entero')
            .refine((n) => n !== 0, 'La cantidad no puede ser cero'),
        reason: z.string().trim().max(40).default('ajuste_manual'),
    })
    .strict();

export const previewPricesSchema = z.object({ cost: moneyInput('El costo') });
