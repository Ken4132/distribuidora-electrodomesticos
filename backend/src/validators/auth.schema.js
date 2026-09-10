import { z } from 'zod';

export const loginSchema = z
    .object({
        username: z.string().trim().min(3, 'Usuario requerido').max(50),
        password: z.string().min(1, 'Contraseña requerida').max(128),
    })
    .strict();

// El esquema de creación de usuarios se movió a validators/user.schema.js
// junto con el resto de la administración de cuentas (REQ-0010).
