import { z } from 'zod';
import { isoDate, pagination } from './common.schema.js';

export const listReceiptsSchema = pagination.extend({
    customerId: z.coerce.number().int().positive().optional(),
    saleId: z.coerce.number().int().positive().optional(),
    branchId: z.coerce.number().int().positive().optional(),
    /** Estado VIVO del pago documentado, no del recibo: el recibo no cambia. */
    paymentStatus: z.enum(['aplicado', 'anulado', '']).default(''),
    from: isoDate.optional(),
    to: isoDate.optional(),
});
