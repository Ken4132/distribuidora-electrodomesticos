import { z } from 'zod';
import { isoDate, pagination, optionalBusinessText } from './common.schema.js';
import { centsToMoney, isMoneyString, moneyToCents } from '../utils/creditPricing.js';
import { NEW_PAYMENT_METHODS } from './payment.schema.js';

export const CREDIT_APPLICATION_STATUSES = Object.freeze([
    'SOLICITADO',
    'EN_VERIFICACION',
    'EN_EVALUACION',
    'APROBADO',
    'VENTA_CONCRETADA',
    'ACTIVO',
    'RECHAZADO',
    'CANCELADO',
    // 012: la venta concretada fue anulada. Terminal: conserva todo el
    // historial y no se reutiliza para otra venta.
    'VENTA_ANULADA',
]);

export const FINANCING_TYPES = Object.freeze(['PREDEFINIDO', 'ESPECIAL']);

/** Tipos de crédito (009). */
export const CREDIT_TYPES = Object.freeze(['NORMAL', 'EXCEPCIONAL_CONTADO']);

export const VERIFICATION_RESULTS = Object.freeze(['FAVORABLE', 'DESFAVORABLE', 'NECESITA_REVISION']);
const CHECK_ANSWERS = ['SI', 'NO', 'NO_VERIFICABLE'];

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
 * Producto de un crédito EXCEPCIONAL A PRECIO DE CONTADO.
 *
 * Precio (contado), plazo (1 pago) y tipo de financiamiento los fija el
 * backend según la regla: el cliente HTTP solo indica producto y cantidad.
 */
const exceptionalItemSchema = z
    .object({
        product_id: positiveInteger('El producto', 2_147_483_647),
        quantity: positiveInteger('La cantidad', 9999).default(1),
    })
    .strict();

const itemsArray = z
    .array(z.unknown(), { required_error: 'Debes incluir al menos un producto' })
    .min(1, 'Debes incluir al menos un producto')
    .max(20, 'Una solicitud admite como máximo 20 productos');

/**
 * Valida las líneas según el tipo de crédito y el enganche del excepcional
 * (siempre Q0). Los errores conservan la ruta `items.N.campo`.
 */
function validateItemsByType(data, ctx) {
    const schema = data.credit_type === 'EXCEPCIONAL_CONTADO' ? exceptionalItemSchema : applicationItemSchema;
    const items = [];
    data.items.forEach((raw, index) => {
        const parsed = schema.safeParse(raw);
        if (parsed.success) {
            items.push(parsed.data);
        } else {
            for (const issue of parsed.error.issues) {
                ctx.addIssue({ ...issue, path: ['items', index, ...issue.path] });
            }
        }
    });
    if (data.credit_type === 'EXCEPCIONAL_CONTADO' && data.proposed_down_payment !== '0.00') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['proposed_down_payment'],
            message: 'El crédito excepcional a precio de contado lleva enganche Q0',
        });
    }
    return items.length === data.items.length ? { ...data, items } : z.NEVER;
}

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

        credit_type: z
            .enum(CREDIT_TYPES, { errorMap: () => ({ message: 'Tipo de crédito inválido (NORMAL o EXCEPCIONAL_CONTADO)' }) })
            .default('NORMAL'),

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

        items: itemsArray,
    })
    .strict()
    .transform(validateItemsByType);

/** Cálculo en vivo de condiciones y mínimos, sin guardar nada. */
export const quoteCreditApplicationSchema = z
    .object({
        credit_type: z.enum(CREDIT_TYPES).default('NORMAL'),
        proposed_down_payment: strictMoney('El enganche propuesto').default('0.00'),
        items: itemsArray,
    })
    .strict()
    .transform(validateItemsByType);

// ---------------------------------------------------------------------
// BLOQUE 3.2 — FLUJO
// ---------------------------------------------------------------------

const checkAnswer = (label) =>
    z.enum(CHECK_ANSWERS, { errorMap: () => ({ message: `${label}: SI, NO o NO_VERIFICABLE` }) });

const coordinate = (min, max, label) =>
    z
        .number({ invalid_type_error: `${label} debe ser numérica` })
        .min(min, `${label} fuera de rango`)
        .max(max, `${label} fuera de rango`)
        .nullable()
        .optional();

/** Verificación registrada por el Cobrador (checklist estructurado). */
export const verificationSchema = z
    .object({
        result: z.enum(VERIFICATION_RESULTS, { errorMap: () => ({ message: 'Resultado inválido' }) }),
        recommendation: z.enum(VERIFICATION_RESULTS, { errorMap: () => ({ message: 'Recomendación inválida' }) }),
        address_matches: checkAnswer('La dirección coincide'),
        housing_verified: checkAnswer('La vivienda'),
        residence_time_matches: checkAnswer('El tiempo de residencia'),
        employment_verified: checkAnswer('El empleo').nullable().optional(),
        labor_reference_confirmed: checkAnswer('La referencia laboral').nullable().optional(),
        personal_reference_confirmed: checkAnswer('La referencia personal').nullable().optional(),
        comments: optionalBusinessText(2000),
        latitude: coordinate(-90, 90, 'La latitud'),
        longitude: coordinate(-180, 180, 'La longitud'),
        // true = el Cobrador termina y envía la verificación a evaluación.
        conclude: z.boolean().default(false),
    })
    .strict()
    .refine((v) => (v.latitude == null) === (v.longitude == null), {
        message: 'Latitud y longitud se registran juntas',
        path: ['latitude'],
    })
    .refine((v) => !(v.conclude && v.result === 'NECESITA_REVISION'), {
        message: 'Una verificación que necesita revisión no se puede enviar a evaluación',
        path: ['conclude'],
    });

export const concludeVerificationSchema = z.object({}).strict();

/** Modificación directa de condiciones por Administración o Gerencia. */
export const modifyConditionsSchema = z
    .object({
        items: z
            .array(
                z
                    .object({
                        item_id: positiveInteger('La línea', 2_147_483_647),
                        proposed_price: strictMoney('El precio unitario propuesto', { positive: true }).optional(),
                        installments_count: positiveInteger('El número de cuotas', 120).optional(),
                        quantity: positiveInteger('La cantidad', 9999).optional(),
                        financing_type: z
                            .enum(FINANCING_TYPES, { errorMap: () => ({ message: 'Tipo de financiamiento inválido' }) })
                            .optional(),
                    })
                    .strict()
                    .refine(
                        (i) =>
                            i.proposed_price !== undefined ||
                            i.installments_count !== undefined ||
                            i.financing_type !== undefined ||
                            i.quantity !== undefined,
                        { message: 'Indica al menos un cambio para la línea' }
                    )
            )
            .max(20)
            .default([]),
        // Productos NUEVOS de la solicitud (012).
        add_items: z.array(applicationItemSchema).max(20).default([]),
        // Productos RETIRADOS (012). La línea nunca se borra: queda is_void.
        void_items: z
            .array(
                z
                    .object({
                        item_id: positiveInteger('La línea', 2_147_483_647),
                        reason: optionalBusinessText(1000),
                    })
                    .strict()
            )
            .max(20)
            .default([]),
        proposed_down_payment: strictMoney('El enganche propuesto').optional(),
        comment: optionalBusinessText(1000),
        // Solo en solicitudes APROBADAS: autorización de líneas que la
        // modificación deja bajo el mínimo.
        exceptions: z
            .array(
                z
                    .object({
                        item_id: positiveInteger('La línea', 2_147_483_647),
                        reason: optionalBusinessText(1000),
                    })
                    .strict()
            )
            .max(20)
            .default([]),
    })
    .strict()
    .refine((v) => v.exceptions.every((e) => e.reason && e.reason.length >= 5), {
        message: 'Cada autorización de excepción requiere un motivo (al menos 5 caracteres)',
        path: ['exceptions'],
    })
    .refine((v) => new Set(v.exceptions.map((e) => e.item_id)).size === v.exceptions.length, {
        message: 'Una línea no puede autorizarse dos veces',
        path: ['exceptions'],
    })
    .refine((v) => v.void_items.every((i) => i.reason && i.reason.length >= 5), {
        message: 'Retirar un producto exige el motivo (al menos 5 caracteres)',
        path: ['void_items'],
    })
    .refine((v) => new Set(v.void_items.map((i) => i.item_id)).size === v.void_items.length, {
        message: 'Una línea no puede retirarse dos veces',
        path: ['void_items'],
    })
    .refine(
        (v) => !v.items.some((i) => v.void_items.some((x) => x.item_id === i.item_id)),
        { message: 'Una línea retirada no se modifica al mismo tiempo', path: ['void_items'] }
    )
    .refine((v) => v.items.length + v.add_items.length + v.void_items.length > 0 || v.proposed_down_payment !== undefined, {
        message: 'Indica al menos un cambio',
        path: ['items'],
    })
    .refine(
        (v) =>
            v.items.length > 0 ||
            v.add_items.length > 0 ||
            v.void_items.length > 0 ||
            v.proposed_down_payment !== undefined,
        { message: 'No se indicó ningún cambio', path: ['items'] }
    );

/** Decisión única de Administración o Gerencia. */
export const decisionSchema = z
    .object({
        decision: z.enum(['APROBADO', 'RECHAZADO'], { errorMap: () => ({ message: 'Decisión inválida (APROBADO o RECHAZADO)' }) }),
        comment: optionalBusinessText(2000),
        exceptions: z
            .array(
                z
                    .object({
                        item_id: positiveInteger('La línea', 2_147_483_647),
                        reason: optionalBusinessText(1000),
                    })
                    .strict()
            )
            .max(20)
            .default([]),
    })
    .strict()
    .refine((v) => v.decision !== 'RECHAZADO' || (v.comment && v.comment.length >= 5), {
        message: 'El rechazo requiere la razón (al menos 5 caracteres)',
        path: ['comment'],
    })
    .refine((v) => v.exceptions.every((e) => e.reason && e.reason.length >= 5), {
        message: 'Cada autorización de excepción requiere un motivo (al menos 5 caracteres)',
        path: ['exceptions'],
    })
    .refine((v) => new Set(v.exceptions.map((e) => e.item_id)).size === v.exceptions.length, {
        message: 'Una línea no puede autorizarse dos veces',
        path: ['exceptions'],
    });

/** Concreción de la venta (3.3): enganche REAL y cómo se pagó. */
export const concretizeSchema = z
    .object({
        down_payment: strictMoney('El enganche real').default('0.00'),
        payment_method: z
            .enum(NEW_PAYMENT_METHODS, {
                errorMap: () => ({ message: `Método de pago inválido (${NEW_PAYMENT_METHODS.join(', ')})` }),
            })
            .optional(),
        payment_reference: z.string().trim().max(80).optional().nullable(),
        notes: optionalBusinessText(1000),
    })
    .strict();

/**
 * ÚLTIMA REVISIÓN de Administración o Gerencia (012).
 *
 * Solo aparece cuando el vendedor modificó las condiciones DESPUÉS de la
 * aprobación. No es una segunda decisión: confirma o rechaza esos cambios.
 * `exceptions` autoriza, con motivo, las líneas que quedaron bajo el mínimo.
 */
export const finalReviewSchema = z
    .object({
        result: z.enum(['CONFIRMADO', 'RECHAZADO'], {
            errorMap: () => ({ message: 'El resultado debe ser CONFIRMADO o RECHAZADO' }),
        }),
        comment: optionalBusinessText(2000),
        exceptions: z
            .array(
                z
                    .object({
                        item_id: positiveInteger('La línea', 2_147_483_647),
                        reason: optionalBusinessText(1000),
                    })
                    .strict()
            )
            .max(20)
            .default([]),
    })
    .strict()
    .refine((v) => v.result !== 'RECHAZADO' || (v.comment && v.comment.length >= 5), {
        message: 'Rechazar los cambios exige la razón (al menos 5 caracteres)',
        path: ['comment'],
    })
    .refine((v) => v.result !== 'RECHAZADO' || v.exceptions.length === 0, {
        message: 'Un rechazo no lleva autorizaciónes de excepción',
        path: ['exceptions'],
    })
    .refine((v) => v.exceptions.every((e) => e.reason && e.reason.length >= 5), {
        message: 'Cada autorización de excepción requiere un motivo (al menos 5 caracteres)',
        path: ['exceptions'],
    })
    .refine((v) => new Set(v.exceptions.map((e) => e.item_id)).size === v.exceptions.length, {
        message: 'Una línea no puede autorizarse dos veces',
        path: ['exceptions'],
    });


export const cancelSchema = z
    .object({
        reason: optionalBusinessText(1000),
    })
    .strict()
    .refine((v) => v.reason && v.reason.length >= 5, {
        message: 'Indica el motivo de la cancelación (al menos 5 caracteres)',
        path: ['reason'],
    });

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
        credit_type: z.enum(CREDIT_TYPES, { errorMap: () => ({ message: 'Tipo de crédito inválido' }) }).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        search: z.string().trim().max(100).default(''),
    })
    .strict()
    .refine((q) => !q.from || !q.to || q.from <= q.to, {
        message: 'La fecha inicial no puede ser posterior a la final',
        path: ['from'],
    });
