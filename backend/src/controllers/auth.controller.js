import bcrypt from 'bcryptjs';
import * as User from '../models/user.model.js';
import { signToken } from '../middleware/auth.js';
import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { permissionsFor } from '../services/authorization.service.js';
import { recordAudit, actorFrom } from '../services/audit.service.js';

export const login = asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findByUsername(username);

    // Mismo mensaje y mismo costo aproximado en ambos casos para no revelar
    // si el usuario existe.
    const hash = user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvaliduO';
    const valid = await bcrypt.compare(password, hash);

    // REQ-0016: la bitácora registra los inicios de sesión, incluidos los
    // fallidos. Un intento fallido es exactamente lo que hay que poder ver
    // cuando se investiga un acceso indebido.
    if (!user || !valid) {
        await recordAudit({
            actor: { ...actorFrom(req), username },
            action: 'login.fallido',
            module: 'seguridad',
            entity: 'user',
            entityId: user?.id ?? null,
            summary: `Intento de inicio de sesión fallido con el usuario "${username}"`,
            result: 'denegado',
        });
        throw AppError.unauthorized('Usuario o contraseña incorrectos');
    }

    if (!user.is_active) {
        await recordAudit({
            actor: { ...actorFrom(req), id: user.id, username: user.username, role: user.role },
            action: 'login.denegado',
            module: 'seguridad',
            entity: 'user',
            entityId: user.id,
            summary: `El usuario desactivado "${user.username}" intentó iniciar sesión`,
            result: 'denegado',
        });
        throw AppError.forbidden('El usuario está desactivado');
    }

    const token = signToken(user);
    const permissions = await permissionsFor(user.role);

    await User.touchLastLogin(user.id);
    await recordAudit({
        actor: { ...actorFrom(req), id: user.id, username: user.username, role: user.role },
        action: 'login.exitoso',
        module: 'seguridad',
        entity: 'user',
        entityId: user.id,
        summary: `${user.full_name} inició sesión`,
    });

    // Se relee la cuenta para devolver también el nombre del rol, que es lo
    // que se muestra en pantalla ("Ventas" en vez de "vendedor").
    const profile = await User.findById(user.id);

    res.json({
        ok: true,
        data: {
            token,
            user: {
                id: user.id,
                username: user.username,
                full_name: user.full_name,
                role: user.role,
                role_name: profile?.role_name ?? user.role,
            },
            // El frontend usa esto para no mostrar botones que el servidor
            // va a rechazar. La decisión real la sigue tomando el servidor.
            permissions,
        },
    });
});

export const me = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id);
    if (!user) throw AppError.unauthorized('Sesión inválida');
    if (!user.is_active) throw AppError.forbidden('El usuario está desactivado');

    const permissions = await permissionsFor(user.role);
    res.json({ ok: true, data: { ...user, permissions } });
});

export const logout = asyncHandler(async (req, res) => {
    await recordAudit({
        actor: actorFrom(req),
        action: 'logout',
        module: 'seguridad',
        entity: 'user',
        entityId: req.user?.id ?? null,
        summary: `${req.user?.username} cerró sesión`,
    });
    res.json({ ok: true, data: null, message: 'Sesión cerrada' });
});
