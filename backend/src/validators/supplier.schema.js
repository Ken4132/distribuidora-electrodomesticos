import { z } from 'zod';
import { pagination, optionalBusinessText, businessText } from './common.schema.js';
import { normalizeEmail } from '../utils/normalize.js';

/**
 * NIT de Guatemala.
 *
 * Se aceptan guiones y espacios al escribir —es como aparece impreso en una
 * factura— y se guardan solo los caracteres significativos, en mayúsculas:
 * "1234567-K" y "1234567k" son el mismo NIT.
 *
 * Se valida la FORMA, no el dígito verificador: la aritmética del DV no
 * está definida como regla del proyecto y aplicarla por cuenta propia
 * rechazaría NITs reales. La misma forma la vuelve a exigir el CHECK
 * `suppliers_nit_format` en la base.
 */
const nit = z
    .string({ required_error: 'El NIT es obligatorio', invalid_type_error: 'El NIT es obligatorio' })
    .transform((v) => v.replace(/[^0-9A-Za-z]/g, '').toUpperCase())
    .refine((v) => /^[0-9]{1,14}[0-9K]$/.test(v), {
        message: 'NIT inválido. Debe ser numérico y puede terminar en K (ej. 1234567-K)',
    });

/**
 * Teléfono: MISMA convención que clientes y sucursales. No se reformatea ni
 * se le añade prefijo; cambiar el formato invalidaría lo ya guardado.
 *
 * En el proveedor es OPCIONAL —igual que en sucursales—: exigirlo sería
 * inventar una regla que el propietario no ha definido. La identidad del
 * proveedor son el NIT y la razón social.
 */
const optionalPhone = (label) =>
    z
        .string()
        .transform((v) => v.replace(/[\s()-]/g, ''))
        .refine((v) => v === '' || /^(\+?502)?[2-7][0-9]{7}$/.test(v), {
            message: `${label} inválido. Debe ser un número de 8 dígitos (ej. 55551234)`,
        })
        .transform((v) => (v === '' ? null : v))
        .nullable()
        .optional();

// Minúsculas, NUNCA mayúsculas: la parte local de una dirección puede ser
// sensible a mayúsculas.
const email = z
    .string()
    .trim()
    .email('Correo electrónico inválido')
    .max(150)
    .or(z.literal(''))
    .transform(normalizeEmail)
    .nullable()
    .optional();

export const createSupplierSchema = z
    .object({
        nit,
        // Texto de negocio: se guarda en forma canónica (MAYÚSCULAS, sin
        // tildes, Ñ conservada) para que la búsqueda lo encuentre escriba
        // como escriba el operador.
        business_name: businessText(3, 150, 'La razón social'),
        contact_name: optionalBusinessText(150),
        phone: optionalPhone('El teléfono'),
        phone_alt: optionalPhone('El teléfono alternativo'),
        email,
        address: optionalBusinessText(500),
        municipality: optionalBusinessText(80),
        department: optionalBusinessText(80),
        notes: optionalBusinessText(1000),
    })
    .strict();

export const updateSupplierSchema = createSupplierSchema.partial().strict();

export const listSuppliersSchema = pagination.extend({
    search: z.string().trim().max(100).default(''),
    status: z.enum(['all', 'active', 'inactive']).default('all'),
});

export const setSupplierActiveSchema = z.object({ is_active: z.boolean() }).strict();
