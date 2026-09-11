import { z } from 'zod';
import { pagination, optionalText } from './common.schema.js';

/**
 * El rol NO se valida contra una lista fija: ahora es una tabla administrable
 * (REQ-0011). Aquí solo se comprueba el formato; que el rol exista de verdad
 * lo garantiza la llave foránea users_role_fkey y se traduce a un mensaje
 * legible en el manejador de errores.
 */
const roleCode = z
    .string()
    .trim()
    .toLowerCase()
    .min(2, 'Rol inválido')
    .max(20, 'Rol inválido')
    .regex(/^[a-z][a-z0-9_]*$/, 'Rol inválido');

const username = z
    .string()
    .trim()
    .min(3, 'El usuario debe tener al menos 3 caracteres')
    .max(50)
    .regex(/^[a-zA-Z0-9._-]+$/, 'El usuario solo admite letras, números, punto, guion y guion bajo');

const password = z
    .string()
    .min(8, 'La contraseña debe tener al menos 8 caracteres')
    .max(128)
    .regex(/[A-Za-z]/, 'La contraseña debe incluir al menos una letra')
    .regex(/[0-9]/, 'La contraseña debe incluir al menos un número');

const email = z
    .string()
    .trim()
    .email('Correo electrónico inválido')
    .max(150)
    .or(z.literal(''))
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const phone = z
    .string()
    .transform((v) => v.replace(/[\s()-]/g, ''))
    .refine((v) => v === '' || /^(\+?502)?[2-7][0-9]{7}$/.test(v), { message: 'Teléfono inválido' })
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

/**
 * Sucursal del usuario. Opcional y anulable: un administrador o un perfil
 * de gerencia pueden no pertenecer a ningún local. `null` significa
 * explícitamente "sin sucursal".
 *
 * El nombre del usuario NO se normaliza como texto de negocio: es el nombre
 * de una cuenta, se copia tal cual a la bitácora y debe leerse igual que lo
 * escribió el administrador.
 */
const branchId = z.coerce.number().int().positive('Sucursal inválida').nullable().optional();

export const createUserSchema = z
    .object({
        username,
        full_name: z.string().trim().min(3, 'Nombre requerido').max(150),
        email,
        phone,
        password,
        role: roleCode.default('vendedor'),
        branch_id: branchId,
    })
    .strict();

/** Al modificar no se toca la contraseña: eso tiene su propio endpoint. */
export const updateUserSchema = z
    .object({
        full_name: z.string().trim().min(3, 'Nombre requerido').max(150).optional(),
        email,
        phone,
        role: roleCode.optional(),
        branch_id: branchId,
    })
    .strict();

/** Asignación de sucursal desde la pantalla de Usuarios. */
export const assignBranchSchema = z.object({ branch_id: branchId }).strict();

/** Restablecimiento hecho por un administrador sobre otra cuenta. */
export const changePasswordSchema = z.object({ password }).strict();

/** Cambio de la propia contraseña: hay que demostrar que se sabe la actual. */
export const changeOwnPasswordSchema = z
    .object({
        current_password: z.string().min(1, 'Indica tu contraseña actual').max(128),
        password,
    })
    .strict()
    .refine((v) => v.current_password !== v.password, {
        message: 'La contraseña nueva debe ser distinta de la actual',
        path: ['password'],
    });

export const listUsersSchema = pagination.extend({
    search: z.string().trim().max(100).default(''),
    role: z.string().trim().max(20).default(''),
    status: z.enum(['all', 'active', 'inactive']).default('all'),
    branch_id: z.coerce.number().int().positive().optional(),
});

export const setUserActiveSchema = z.object({ is_active: z.boolean() }).strict();

// ------------------------------------------------------------------ ROLES

export const roleCodeParam = z.object({ code: roleCode });

export const createRoleSchema = z
    .object({
        code: roleCode,
        name: z.string().trim().min(3, 'Nombre del rol requerido').max(60),
        description: optionalText(500),
    })
    .strict();

export const updateRoleSchema = z
    .object({
        name: z.string().trim().min(3).max(60).optional(),
        description: optionalText(500),
        is_active: z.boolean().optional(),
    })
    .strict();

export const setRolePermissionsSchema = z
    .object({
        permissions: z.array(z.string().trim().max(60)).max(200),
    })
    .strict();
