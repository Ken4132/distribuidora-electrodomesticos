import { z } from 'zod';
import { optionalText, businessText } from './common.schema.js';

/**
 * El nombre se valida COMO SE VA A GUARDAR: `businessText` lo normaliza
 * antes de medirlo. Por eso "  cama  " y "CAMA" llegan al servicio como el
 * mismo valor, y el índice único sobre la forma normalizada de la base de
 * datos no tiene que rechazar nada que la aplicación no haya avisado ya.
 */
export const createTaxonomySchema = z
    .object({
        name: businessText(2, 80, 'El nombre'),
        // Prosa: no se normaliza.
        description: optionalText(500),
    })
    .strict();

export const updateTaxonomySchema = createTaxonomySchema.partial().strict();

export const listTaxonomySchema = z.object({
    search: z.string().trim().max(100).default(''),
    status: z.enum(['all', 'active', 'inactive']).default('all'),
});
