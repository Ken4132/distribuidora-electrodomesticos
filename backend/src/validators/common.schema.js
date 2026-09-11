import { z } from 'zod';
import { isIsoDate } from '../utils/dates.js';
import { normalizeText, normalizeOptionalText } from '../utils/normalize.js';

export const idParam = z.object({
    id: z.coerce.number().int().positive({ message: 'Identificador inválido' }),
});

export const isoDate = z
    .string()
    .refine(isIsoDate, { message: 'La fecha debe tener formato YYYY-MM-DD y ser válida' });

export const pagination = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** Texto obligatorio, recortado, con longitud máxima. */
export const trimmed = (min, max, label) =>
    z
        .string({ required_error: `${label} es obligatorio`, invalid_type_error: `${label} es obligatorio` })
        .trim()
        .min(min, `${label} debe tener al menos ${min} caracteres`)
        .max(max, `${label} no puede exceder ${max} caracteres`);

/** Texto opcional: '' se convierte en null para no guardar cadenas vacías. */
export const optionalText = (max) =>
    z
        .string()
        .trim()
        .max(max)
        .transform((v) => (v === '' ? null : v))
        .nullable()
        .optional();

/**
 * TEXTO DE NEGOCIO obligatorio: nombre de cliente, dirección, nombre de
 * producto, categoría, marca, nombre de sucursal.
 *
 * Se normaliza ANTES de validar la longitud, para que lo que se mide sea
 * exactamente lo que se va a guardar (colapsar espacios puede acortar el
 * texto).
 *
 * NO usar para nombres de usuario, contraseñas, códigos de permiso, códigos
 * de rol ni observaciones: ver utils/normalize.js.
 */
export const businessText = (min, max, label) =>
    z
        .string({ required_error: `${label} es obligatorio`, invalid_type_error: `${label} es obligatorio` })
        .transform((v) => normalizeText(v) ?? '')
        .refine((v) => v.length >= min, `${label} debe tener al menos ${min} caracteres`)
        .refine((v) => v.length <= max, `${label} no puede exceder ${max} caracteres`);

/** Texto de negocio opcional: en blanco se guarda como null. */
export const optionalBusinessText = (max) =>
    z
        .string()
        .transform(normalizeOptionalText)
        .refine((v) => v === null || v.length <= max, `No puede exceder ${max} caracteres`)
        .nullable()
        .optional();

export const moneyInput = (label) =>
    z.coerce
        .number({ invalid_type_error: `${label} debe ser numérico` })
        .nonnegative(`${label} no puede ser negativo`)
        .max(99_999_999, `${label} excede el máximo permitido`)
        .refine((n) => Number.isFinite(n), `${label} inválido`);
