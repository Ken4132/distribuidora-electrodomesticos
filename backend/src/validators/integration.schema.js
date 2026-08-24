import { z } from 'zod';
import { pagination } from './common.schema.js';
import { ALL_EVENT_TYPES } from '../services/events.service.js';

export const listEventsSchema = pagination.extend({
    status: z.enum(['pendiente', 'enviado', 'fallido', 'descartado', '']).default(''),
    type: z.enum([...ALL_EVENT_TYPES, '']).default(''),
});
