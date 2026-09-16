import { z } from 'zod';
import { isoDate, pagination, optionalBusinessText } from './common.schema.js';
import { centsToMoney, isMoneyString, moneyToCents } from '../utils/creditPricing.js';

export const CREDIT_APPLICATION_STATUSES = Object.freeze([
    'SOLICITADO',
    'EN_VERIFICACION',
    'EN_EVALUACION',
    'APROBADO',
    'VENTA_CONCRETADA',
    'ACTIVO',
    'RECHAZADO',
    'CANCELADO',
]);

export const FINANCING_TYPES = Object.freeze(['PREDEFINIDO', 'ESPECIAL']);

/**
 * Importe monetario ESTRICTO: número o texto con máximo 2 decimales.
 *
 * Se valida la representación exacta, no el valor en coma flotante:
 * 1500.555 se rechaza en lugar de redondearse en silencio, y 0.1 + 0.2
 * (0.30000000000000004) también. La salida es un texto canónico '1500.50'
 * que el servicio convierte a centavos enteros.
 */
const strictMoney = (label, { positive = false } = {}) =>
    z
        .union([z.number(), z.string()], {
            errorMap: () => ({ message: `${label} debe ser un importe numérico` }),
        })
        .transform((value, ctx) => {
            const text = typeof value === 'number' ? String(value) : value.trim();
            if (!isMoneyString(text)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `${label} debe ser un importe no negativo, con máximo 2 decimales y hasta 99,999,999.99`,
                });
                return z.NEVER;
            }
            const cents = moneyToCents(text);
            if (positive && cents <= 0n) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} debe ser mayor a cero` });
                return z.NEVER;
            }
            return centsToMoney(cents);
        });

/** Teléfono de Guatemala: mismo formato que clientes y usuarios. */
const optionalPhone = (label) =>
    z
        .string()
        .transform((v) => v.replace(/[\s()-]/g, ''))
        .refine((v) => v === '' || /^(\+?502)?[2-7][0-9]{7}$/.test(v), { message: `${label} inválido` })
        .transform((v) => (v === '' ? null : v))
        .nullable()
        .optional();

/** DPI opcional (fiador): 13 dígitos, se aceptan espacios y guiones. */
const optionalDpi = z
    .string()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .refine((v) => v === '' || /^[0-9]{13}$/.test(v), { message: 'El DPI del fiador debe tener exactamente 13 dígitos' })
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const positiveInteger = (label, max) =>
    z
        .number({ invalid_type_error: `${label} debe ser un número entero`, required_error: `${label} es obligatorio` })
        .int(`${label} debe ser un número entero`)
        .positive(`${label} debe ser mayor a cero`)
        .max(max, `${label} no puede exceder ${max}`);

/**
 * Producto solicitado.
 *
 * `proposed_price` es PRECIO UNITARIO (decisión confirmada). El total de la
 * línea es precio unitario x cantidad.
 *
 * Costo, precio mínimo, porcentaje y cuotas NO vienen del cliente HTTP: el
 * backend los obtiene de PostgreSQL. El enganche NO va por línea: pertenece
 * al total de la solicitud.
 */
const applicationItemSchema = z
    .object({
        product_id: positiveInteger('El producto', 2_147_483_647),
        quantity: positiveInteger('La cantidad', 9999).default(1),
        financing_type: z.enum(FINANCING_TYPES, {
            errorMap: () => ({ message: 'Tipo de financiamiento inválido (PREDEFINIDO o ESPECIAL)' }),
        }),
        installments_count: positiveInteger('El número de cuotas', 120),
        proposed_price: strictMoney('El precio unitario propuesto', { positive: true }),
    })
    .strict();

/**
 * Solicitud de crédito.
 *
 * Los textos de negocio se normalizan aquí (MAYÚSCULAS, sin tildes, conserva
 * la Ñ). Municipio y departamento se aceptan solo como respaldo: si la ficha
 * del cliente ya los tiene, el servicio usa los de la ficha.
 */
export const createCreditApplicationSchema = z
    .object({
        customer_id: positiveInteger('El cliente', 2_147_483_647),

        customer_municipality: optionalBusinessText(120),
        customer_department: optionalBusinessText(120),
        housing_type: optionalBusinessText(100),
        residence_time: optionalBusinessText(100),

        employer_name: optionalBusinessText(200),
        employer_address: optionalBusinessText(500),
        employer_phone: optionalPhone('El teléfono del empleador'),
        employment_time: optionalBusinessText(100),
        job_position: optionalBusinessText(150),
        monthly_income: strictMoney('El ingreso mensual').nullable().optional(),

        labor_reference_name: optionalBusinessText(200),
        labor_reference_phone: optionalPhone('El teléfono de la referencia laboral'),
        labor_reference_relation: optionalBusinessText(100),

        personal_reference_name: optionalBusinessText(200),
        personal_reference_phone: optionalPhone('El teléfono de la referencia personal'),
        personal_reference_relation: optionalBusinessText(100),

        guarantor_name: optionalBusinessText(200),
        guarantor_dpi: optionalDpi,
        guarantor_phone: optionalPhone('El teléfono del fiador'),
        guarantor_address: optionalBusinessText(500),
        guarantor_relation: optionalBusinessText(100),

        // Enganche PROPUESTO del total de la solicitud. Incluido dentro del
        // precio financiado; no es un pago.
        proposed_down_payment: strictMoney('El enganche propuesto').default('0.00'),

        items: z
            .array(applicationItemSchema, { required_error: 'Debes incluir al menos un producto' })
            .min(1, 'Debes incluir al menos un producto')
            .max(20, 'Una solicitud admite como máximo 20 productos'),
    })
    .strict();

export const creditApplicationIdSchema = z.object({
    id: z.coerce.number().int().positive({ message: 'Identificador inválido' }),
});

/** Cabecera opcional contra doble envío. */
export const idempotencyKeySchema = z
    .string()
    .trim()
    .min(8, 'Idempotency-Key debe tener entre 8 y 100 caracteres')
    .max(100, 'Idempotency-Key debe tener entre 8 y 100 caracteres')
    .regex(/^[A-Za-z0-9_-]+$/, 'Idempotency-Key solo admite letras, números, guion y guion bajo');

const statusList = z
    .string()
    .trim()
    .transform((v) => v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
    .refine((list) => list.every((s) => CREDIT_APPLICATION_STATUSES.includes(s)), {
        message: `Estado inválido. Valores: ${CREDIT_APPLICATION_STATUSES.join(', ')}`,
    });

export const listCreditApplicationsSchema = pagination
    .extend({
        status: statusList.optional(),
        branch_id: z.coerce.number().int().positive('Sucursal inválida').optional(),
        customer_id: z.coerce.number().int().positive('Cliente inválido').optional(),
        created_by: z.coerce.number().int().positive('Usuario inválido').optional(),
        financing_type: z
            .string()
            .trim()
            .toUpperCase()
            .pipe(z.enum(FINANCING_TYPES, { errorMap: () => ({ message: 'Tipo de financiamiento inválido' }) }))
            .optional(),
        requires_price_exception: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        search: z.string().trim().max(100).default(''),
    })
    .strict()
    .refine((q) => !q.from || !q.to || q.from <= q.to, {
        message: 'La fecha inicial no puede ser posterior a la final',
        path: ['from'],
    });
