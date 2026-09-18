import { z } from 'zod';
import { isoDate, pagination, optionalText, optionalBusinessText, moneyInput, trimmed } from './common.schema.js';
import { today } from '../utils/dates.js';

/** Los dos únicos estados del depósito. No hay más (bloque 4.2, regla DP1). */
export const DEPOSIT_STATUSES = ['REVISADO', 'VALIDADO'];

/**
 * Pagos que se incluyen en el depósito. Se exige que no vengan repetidos en
 * la misma petición: la base lo impediría igual con el UNIQUE, pero un error
 * de tecleo merece un mensaje en vez de un conflicto.
 */
const paymentIdList = (min) =>
    z
        .array(z.coerce.number().int().positive('Identificador de pago inválido'))
        .min(min, min === 0 ? undefined : 'Indica al menos un pago')
        .max(500, 'Demasiados pagos en una sola operación')
        .refine((ids) => new Set(ids).size === ids.length, 'Hay pagos repetidos en la lista');

export const createDepositSchema = z
    .object({
        /**
         * Solo lo usa quien no tiene sucursal asignada (administración). A
         * un usuario con sucursal se le impone la suya: ver el servicio.
         */
        branch_id: z.coerce.number().int().positive().optional(),
        /** Fecha en que se llevó el dinero al banco. Nunca futura. */
        deposit_date: isoDate
            .refine((value) => value <= today(), { message: 'La fecha del depósito no puede ser futura' })
            .optional(),
        bank: optionalBusinessText(80),
        account: optionalText(60),
        /** Correlativo o número de boleta del banco. */
        reference: optionalText(80),
        declared_amount: moneyInput('El monto declarado'),
        notes: optionalText(1000),
        payment_ids: paymentIdList(0).default([]),
    })
    .strict();

export const addPaymentsSchema = z.object({ payment_ids: paymentIdList(1) }).strict();

/** Observación, explicación y rechazo: los tres son eventos con comentario. */
export const depositCommentSchema = z
    .object({ comment: trimmed(5, 1000, 'El comentario') })
    .strict();

export const validateDepositSchema = z.object({ comment: optionalText(1000) }).strict();

export const listDepositsSchema = pagination.extend({
    status: z.enum([...DEPOSIT_STATUSES, '']).default(''),
    branchId: z.coerce.number().int().positive().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    /** 'true' deja solo los depósitos cuya conciliación no cuadra. */
    withDifference: z
        .enum(['true', 'false', ''])
        .default('')
        .transform((v) => (v === '' ? null : v === 'true')),
});
