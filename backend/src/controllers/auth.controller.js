import bcrypt from 'bcryptjs';
import * as User from '../models/user.model.js';
import { signToken } from '../middleware/auth.js';
import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const login = asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findByUsername(username);

    // Mismo mensaje y mismo costo aproximado en ambos casos para no revelar
    // si el usuario existe.
    const hash = user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvaliduO';
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid) throw AppError.unauthorized('Usuario o contraseña incorrectos');
    if (!user.is_active) throw AppError.forbidden('El usuario está desactivado');

    const token = signToken(user);
    res.json({
        ok: true,
        data: {
            token,
            user: {
                id: user.id,
                username: user.username,
                full_name: user.full_name,
                role: user.role,
            },
        },
    });
});

export const me = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id);
    if (!user) throw AppError.unauthorized('Sesión inválida');
    res.json({ ok: true, data: user });
});

export const createUser = asyncHandler(async (req, res) => {
    const { username, full_name, email, password, role } = req.body;
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, fullName: full_name, email, passwordHash, role });
    res.status(201).json({ ok: true, data: user });
});
