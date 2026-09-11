import { z } from 'zod';
import { optionalText, businessText, optionalBusinessText } from './common.schema.js';

/**
 * Código de sucursal: identificador técnico corto, en mayúsculas. NO se le
 * quitan tildes con la normalización de negocio porque el formato ya solo
 * admite letras sin acento, números, guion y guion bajo.
 */
const code = z
    .string({ required_error: 'El código es obligatorio' })
    .trim()
    .min(2, 'El código debe tener al menos 2 caracteres')
    .max(20, 'El código no puede exceder 20 caracteres')
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z0-9_-]+$/.test(v), 'El código solo admite letras, números, guion y guion bajo');

const phone = z
    .string()
    .transform((v) => v.replace(/[\s()-]/g, ''))
    .refine((v) => v === '' || /^(\+?502)?[2-7][0-9]{7}$/.test(v), { message: 'Teléfono inválido' })
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const createBranchSchema = z
    .object({
        code,
        name: businessText(3, 120, 'El nombre de la sucursal'),
        address: optionalBusinessText(500),
        phone,
        // `notes` es prosa: no se normaliza.
        notes: optionalText(1000),
    })
    .strict();

export const updateBranchSchema = createBranchSchema.partial().strict();

export const listBranchesSchema = z.object({
    search: z.string().trim().max(100).default(''),
    status: z.enum(['all', 'active', 'inactive']).default('all'),
});
