/**
 * GESTIÓN DE USUARIOS  (REQ-0010)
 *
 * Reglas que se protegen aquí, no en la interfaz:
 *   * El sistema nunca puede quedarse sin un administrador activo.
 *   * Nadie se quita a sí mismo el acceso por descuido (ni su rol ni su
 *     estado): tendría que pedirle a otro administrador que lo devuelva.
 *   * Las cuentas se desactivan, nunca se borran (REQ-0010 y RN-0006).
 */
import bcrypt from 'bcryptjs';
import * as User from '../models/user.model.js';
import * as Branch from '../models/branch.model.js';
import { AppError } from '../utils/AppError.js';

const BCRYPT_ROUNDS = 10;

/**
 * La sucursal referenciada tiene que existir y estar activa.
 * `undefined` significa "no se está tocando"; `null`, "quítasela".
 */
async function assertBranchAssignable(branchId) {
    if (branchId === undefined || branchId === null) return null;

    const branch = await Branch.findById(branchId);
    if (!branch) throw AppError.badRequest('La sucursal seleccionada no existe');
    if (!branch.is_active) {
        throw AppError.unprocessable(`La sucursal "${branch.name}" está desactivada`);
    }
    return branch;
}

export const listUsers = (opts) => User.list(opts);

export async function getUser(id) {
    const user = await User.findById(id);
    if (!user) throw AppError.notFound('Usuario no encontrado');
    return user;
}

export async function createUser(data) {
    const existing = await User.findByUsername(data.username);
    if (existing) throw AppError.conflict(`El usuario "${data.username}" ya está en uso`);

    await assertBranchAssignable(data.branch_id);

    const passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);
    return User.create({
        username: data.username,
        fullName: data.full_name,
        email: data.email,
        phone: data.phone,
        passwordHash,
        role: data.role,
        branchId: data.branch_id ?? null,
    });
}

export async function updateUser(id, data, actorId) {
    const current = await User.findById(id);
    if (!current) throw AppError.notFound('Usuario no encontrado');

    const changingRole = data.role && data.role !== current.role;

    if (changingRole && Number(id) === Number(actorId)) {
        throw AppError.conflict(
            'No puedes cambiar tu propio rol. Pídeselo a otro administrador.'
        );
    }

    // Si este es el último administrador activo, no puede dejar de serlo.
    if (changingRole && current.role === 'admin' && current.is_active) {
        const others = await User.countActiveAdmins(id);
        if (others === 0) {
            throw AppError.conflict(
                'Es el único administrador activo. Crea o activa otro administrador antes de cambiarle el rol.'
            );
        }
    }

    await assertBranchAssignable(data.branch_id);

    return User.update(id, {
        fullName: data.full_name,
        email: data.email,
        phone: data.phone,
        role: data.role,
        branchId: data.branch_id,
    });
}

/**
 * Asigna (o quita, con null) la sucursal de un usuario.
 * Es una operación aparte de la edición general porque es la que el
 * administrador hace más a menudo y la que conviene poder auditar con su
 * propia entrada en la bitácora.
 */
export async function assignBranch(id, branchId) {
    const current = await User.findById(id);
    if (!current) throw AppError.notFound('Usuario no encontrado');

    const branch = await assertBranchAssignable(branchId);
    const updated = await User.setBranch(id, branchId ?? null);

    return { ...updated, branch_code: branch?.code ?? null, branch_name: branch?.name ?? null };
}

export async function setUserActive(id, isActive, actorId) {
    const current = await User.findById(id);
    if (!current) throw AppError.notFound('Usuario no encontrado');

    if (!isActive) {
        if (Number(id) === Number(actorId)) {
            throw AppError.conflict('No puedes desactivar tu propia cuenta.');
        }
        if (current.role === 'admin') {
            const others = await User.countActiveAdmins(id);
            if (others === 0) {
                throw AppError.conflict(
                    'Es el único administrador activo. Si lo desactivas, nadie podría administrar el sistema.'
                );
            }
        }
    }

    if (current.is_active === isActive) {
        return current; // nada que hacer, y así la bitácora no registra un cambio que no ocurrió
    }

    return User.setActive(id, isActive);
}

export async function changePassword(id, newPassword) {
    const current = await User.findById(id);
    if (!current) throw AppError.notFound('Usuario no encontrado');

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    return User.updatePassword(id, passwordHash);
}

/**
 * Cambio de contraseña por el propio usuario: exige la contraseña actual.
 * Sin esto, una sesión abierta y olvidada permitiría a cualquiera dejar
 * fuera al dueño de la cuenta.
 */
export async function changeOwnPassword(id, currentPassword, newPassword) {
    const user = await User.findById(id);
    if (!user) throw AppError.notFound('Usuario no encontrado');

    const withHash = await User.findByUsername(user.username);
    const valid = await bcrypt.compare(currentPassword, withHash?.password_hash ?? '');
    if (!valid) throw AppError.unauthorized('La contraseña actual no es correcta');

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    return User.updatePassword(id, passwordHash);
}
