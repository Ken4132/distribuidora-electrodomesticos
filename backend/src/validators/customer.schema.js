import { z } from 'zod';
import { pagination, businessText, optionalBusinessText } from './common.schema.js';
import { normalizeEmail } from '../utils/normalize.js';

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

// El correo se normaliza a minúsculas, NUNCA a mayúsculas: la parte local
// de una dirección puede ser sensible a mayúsculas.
const email = z
    .string()
    .trim()
    .email('Correo electrónico inválido')
    .max(150)
    .or(z.literal(''))
    .transform(normalizeEmail)
    .nullable()
    .optional();

const coordinate = (min, max, label) =>
    z.coerce.number().min(min, `${label} fuera de rango`).max(max, `${label} fuera de rango`).nullable().optional();

export const createCustomerSchema = z
    .object({
        dpi,
        // Texto de negocio: se guarda en su forma canónica (MAYÚSCULAS, sin
        // tildes, espacios colapsados). Así "José López", "JOSE LOPEZ" y
        // "  josé   lópez " son el mismo cliente y la búsqueda los encuentra
        // escriba como escriba el operador.
        full_name: businessText(3, 150, 'El nombre completo'),
        phone,
        phone_alt: optionalPhone,
        email,
        address: businessText(5, 500, 'La dirección'),
        address_ref: optionalBusinessText(500),
        municipality: optionalBusinessText(80),
        department: optionalBusinessText(80),
        latitude: coordinate(-90, 90, 'Latitud'),
        longitude: coordinate(-180, 180, 'Longitud'),
        // Las observaciones también son un dato de negocio escrito por el
        // usuario: se normalizan igual que el resto (decisión del
        // propietario, 2026-09-11).
        notes: optionalBusinessText(1000),
    })
    .strict();

export const updateCustomerSchema = createCustomerSchema.partial().strict();

export const listCustomersSchema = pagination.extend({
    search: z.string().trim().max(100).default(''),
    status: z.enum(['all', 'active', 'inactive']).default('all'),
});

export const setActiveSchema = z.object({ is_active: z.boolean() }).strict();
