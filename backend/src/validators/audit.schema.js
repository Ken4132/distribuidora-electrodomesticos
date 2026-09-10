import { z } from 'zod';
import { isoDate, pagination } from './common.schema.js';

export const listAuditSchema = pagination.extend({
    search: z.string().trim().max(100).default(''),
    action: z.string().trim().max(60).default(''),
    module: z.string().trim().max(30).default(''),
    entity: z.string().trim().max(40).default(''),
    userId: z.coerce.number().int().positive().optional(),
    result: z.enum(['ok', 'denegado', 'error', '']).default(''),
    from: isoDate.optional(),
    to: isoDate.optional(),
});
