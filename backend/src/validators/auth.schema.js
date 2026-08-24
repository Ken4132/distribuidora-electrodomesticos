import { z } from 'zod';

export const loginSchema = z
    .object({
        username: z.string().trim().min(3, 'Usuario requerido').max(50),
        password: z.string().min(1, 'Contraseña requerida').max(128),
    })
    .strict();

export const createUserSchema = z
    .object({
        username: z
            .string()
            .trim()
            .min(3, 'El usuario debe tener al menos 3 caracteres')
            .max(50)
            .regex(/^[a-zA-Z0-9._-]+$/, 'El usuario solo admite letras, números, punto, guion y guion bajo'),
        full_name: z.string().trim().min(3, 'Nombre requerido').max(150),
        email: z.string().trim().email('Correo inválido').max(150).optional().or(z.literal('')),
        password: z
            .string()
            .min(8, 'La contraseña debe tener al menos 8 caracteres')
            .max(128)
            .regex(/[A-Za-z]/, 'La contraseña debe incluir al menos una letra')
            .regex(/[0-9]/, 'La contraseña debe incluir al menos un número'),
        role: z.enum(['admin', 'vendedor']).default('vendedor'),
    })
    .strict();
