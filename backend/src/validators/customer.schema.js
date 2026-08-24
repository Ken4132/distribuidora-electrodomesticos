import { z } from 'zod';
import { trimmed, optionalText, pagination } from './common.schema.js';

/** DPI de Guatemala: 13 dígitos. Se aceptan espacios/guiones y se normalizan. */
const dpi = z
    .string({ required_error: 'El DPI es obligatorio' })
    .transform((v) => v.replace(/[\s-]/g, ''))
    .refine((v) => /^[0-9]{13}$/.test(v), { message: 'El DPI debe tener exactamente 13 dígitos' });

/** Teléfono de Guatemala: 8 dígitos, con o sin código de país. */
const phone = z
    .string({ required_error: 'El teléfono es obligatorio' })
    .transform((v) => v.replace(/[\s()-]/g, ''))
    .refine((v) => /^(\+?502)?[2-7][0-9]{7}$/.test(v), {
        message: 'Teléfono inválido. Debe ser un número de 8 dígitos (ej. 55551234)',
    });

const optionalPhone = z
    .string()
    .transform((v) => v.replace(/[\s()-]/g, ''))
    .refine((v) => v === '' || /^(\+?502)?[2-7][0-9]{7}$/.test(v), { message: 'Teléfono alternativo inválido' })
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const email = z
    .string()
    .trim()
    .email('Correo electrónico inválido')
    .max(150)
    .or(z.literal(''))
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const coordinate = (min, max, label) =>
    z.coerce.number().min(min, `${label} fuera de rango`).max(max, `${label} fuera de rango`).nullable().optional();

export const createCustomerSchema = z
    .object({
        dpi,
        full_name: trimmed(3, 150, 'El nombre completo'),
        phone,
        phone_alt: optionalPhone,
        email,
        address: trimmed(5, 500, 'La dirección'),
        address_ref: optionalText(500),
        latitude: coordinate(-90, 90, 'Latitud'),
        longitude: coordinate(-180, 180, 'Longitud'),
        notes: optionalText(1000),
    })
    .strict();

export const updateCustomerSchema = createCustomerSchema.partial().strict();

export const listCustomersSchema = pagination.extend({
    search: z.string().trim().max(100).default(''),
    status: z.enum(['all', 'active', 'inactive']).default('all'),
});

export const setActiveSchema = z.object({ is_active: z.boolean() }).strict();
