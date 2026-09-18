import { z } from 'zod';
import { isoDate, pagination, trimmed, moneyInput } from './common.schema.js';
import { today } from '../utils/dates.js';

export const OVERDUE_BUCKETS = ['AL_DIA', '1_30', '31_60', '61_90', 'MAS_90'];
export const RESTRUCTURING_KINDS = ['REESTRUCTURACION', 'REGULARIZACION'];

const flag = z
    .enum(['true', 'false', ''])
    .default('')
    .transform((v) => v === 'true');

export const portfolioQuerySchema = pagination.extend({
    status: z.enum(['pendiente', 'al_dia', 'vencida', 'pagada', '']).default(''),
    bucket: z.enum([...OVERDUE_BUCKETS, '']).default(''),
    customerId: z.coerce.number().int().positive().optional(),
    branchId: z.coerce.number().int().positive().optional(),
    onlyOverdue: flag,
});

export const installmentsQuerySchema = pagination.extend({
    saleId: z.coerce.number().int().positive().optional(),
    customerId: z.coerce.number().int().positive().optional(),
    branchId: z.coerce.number().int().positive().optional(),
    status: z.enum(['pendiente', 'parcial', 'vencida', 'pagada', '']).default(''),
    bucket: z.enum([...OVERDUE_BUCKETS, '']).default(''),
    onlyOverdue: flag,
    onlyPending: flag,
    from: isoDate.optional(),
    to: isoDate.optional(),
});

export const summaryQuerySchema = z.object({
    branchId: z.coerce.number().int().positive().optional(),
});

/**
 * REESTRUCTURACIÓN / REGULARIZACIÓN.
 *
 * `kind` es OPCIONAL: lo determina el sistema a partir del tipo de crédito y
 * de los días transcurridos. Si el cliente lo manda, tiene que coincidir; así
 * la interfaz puede confirmar lo que va a hacer sin poder forzar otra cosa.
 */
export const restructureSchema = z
    .object({
        new_total: moneyInput('El nuevo total'),
        new_installments: z.coerce.number().int().min(1, 'Debe haber al menos una cuota').max(120),
        first_due_date: isoDate.refine((v) => v >= today(), {
            message: 'La primera cuota no puede vencer antes de hoy',
        }),
        reason: trimmed(10, 1000, 'El motivo'),
        kind: z.enum(RESTRUCTURING_KINDS).optional(),
    })
    .strict();
