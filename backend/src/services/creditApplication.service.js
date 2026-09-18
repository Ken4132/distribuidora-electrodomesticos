import { createHash } from 'node:crypto';
import { withTransaction } from '../config/db.js';
import { config } from '../config/env.js';
import * as model from '../models/creditApplication.model.js';
import { userCan } from './authorization.service.js';
import { AppError } from '../utils/AppError.js';
import { normalizeSearch } from '../utils/normalize.js';
import {
    CASH_MARKUP_PERCENT,
    centsToMoney,
    divideHalfUp,
    effectiveMinimumInstallment,
    effectiveMinimumPrice,
    moneyToCents,
    percentToHundredths,
    planMatchesPredefinedRule,
    predefinedPercentage,
    priceFromCost,
    PREDEFINED_FINANCING,
    SPECIAL_MIN_INSTALLMENTS,
    specialPercentage,
} from '../utils/creditPricing.js';

/**
 * SOLICITUDES DE CRÉDITO — Bloque 3.1
 *
 * Una solicitud NO es una venta: no mueve inventario, no genera saldo, no
 * crea cuotas activas y el enganche propuesto no es un pago.
 *
 * Todo error esperable se lanza como AppError para que llegue al cliente
 * con un código HTTP coherente (400/404/409/422) y nunca como 500.
 */

const UNIQUE_REQUEST_CONSTRAINT = 'ux_credit_applications_request';

/** Señal interna: la misma clave ya registró una solicitud (se devuelve esa). */
class ReplaySignal extends Error {}

// ---------------------------------------------------------------------
// ALCANCE
// ---------------------------------------------------------------------

/**
 * Alcance de consulta del usuario (decisión confirmada):
 *   credits.view         -> todas (Administración, Gerencia)
 *   credits.view.branch  -> su sucursal, solicitudes por verificar (Cobrador)
 *   credits.view.own     -> las que él creó (Vendedor)
 *
 * El global manda. Los dos alcances parciales se suman si un rol tiene ambos.
 * La sucursal se lee de la base de datos, nunca del token ni del request.
 */
export async function resolveViewScope(user) {
    if (!user?.id) throw AppError.unauthorized();

    if (await userCan(user, 'credits.view')) {
        return { global: true, own: false, branch: false, userId: user.id, branchId: null };
    }

    const [own, branch] = await Promise.all([
        userCan(user, 'credits.view.own'),
        userCan(user, 'credits.view.branch'),
    ]);
    if (!own && !branch) throw AppError.forbidden('Tu usuario no tiene permiso para consultar solicitudes de crédito');

    let branchId = null;
    if (branch) {
        const userBranch = await model.getUserBranch(user.id);
        branchId = userBranch?.branch_id ?? null;
    }
    return { global: false, own, branch, userId: user.id, branchId };
}

// ---------------------------------------------------------------------
// CÁLCULO DE CADA LÍNEA
// ---------------------------------------------------------------------

/**
 * Condiciones comerciales de una línea, a partir de datos de la base.
 *
 * PREDEFINIDO: plazo en {4, 5, 6, 10, 12}, plan activo del producto y
 *              porcentaje del plan idéntico a la regla vigente.
 *              Precio mínimo efectivo = MAX(costo x (1+pct), plan.minimum_price).
 *              Cuota mínima efectiva = MAX(cuota matemática del precio mínimo,
 *              plan.minimum_installment x cantidad).
 * ESPECIAL:    6 cuotas o más; porcentaje por fórmula; el precio mínimo es
 *              el que resulta de la fórmula y la cuota mínima la matemática
 *              (no hay plan configurado).
 *
 * Precios UNITARIOS; cuotas de la LÍNEA completa (precio x cantidad).
 */
export async function buildLine(item, client, creditType = 'NORMAL') {
    const product = await model.getProductForApplication(item.product_id, client);
    if (!product) {
        throw AppError.badRequest(`El producto con id ${item.product_id} no existe`);
    }
    if (!product.is_active) {
        throw AppError.unprocessable(`El producto "${product.name}" está inactivo y no puede solicitarse`);
    }

    const costCents = moneyToCents(product.cost);

    // CRÉDITO EXCEPCIONAL A PRECIO DE CONTADO (regla 13): precio público de
    // contado, un solo pago. No hay mínimo distinto del propio precio.
    if (creditType === 'EXCEPCIONAL_CONTADO') {
        const cashPercent = BigInt(CASH_MARKUP_PERCENT) * 100n;
        const unitCents = priceFromCost(costCents, cashPercent);
        const lineCents = unitCents * BigInt(item.quantity);
        return {
            product_id: product.id,
            quantity: item.quantity,
            product_code_snapshot: product.code,
            product_name_snapshot: product.name,
            cost_snapshot: centsToMoney(costCents),
            financing_type: 'CONTADO_EXCEPCIONAL',
            installments_count: 1,
            financing_percentage_snapshot: centsToMoney(cashPercent),
            minimum_price_snapshot: centsToMoney(unitCents),
            minimum_installment_snapshot: centsToMoney(lineCents),
            configured_minimum_price_snapshot: null,
            configured_minimum_installment_snapshot: null,
            proposed_price: centsToMoney(unitCents),
            proposed_installment: centsToMoney(lineCents),
            lineTotalCents: lineCents,
        };
    }

    const term = item.installments_count;
    let percentHundredths;
    let configuredMinimumUnitCents = null;
    let configuredInstallmentUnitCents = null;

    if (item.financing_type === 'PREDEFINIDO') {
        if (predefinedPercentage(term) === null) {
            throw AppError.unprocessable(
                `${term} cuotas no es un plazo predefinido. Plazos predefinidos: ${Object.keys(PREDEFINED_FINANCING).join(', ')}. Usa financiamiento ESPECIAL si corresponde.`,
                { product_id: product.id, installments_count: term }
            );
        }

        const plan = await model.getFinancingPlan(product.id, term, client);
        if (!plan) {
            throw AppError.unprocessable(
                `El producto "${product.name}" no tiene habilitado el plan predefinido de ${term} cuotas`,
                { product_id: product.id, installments_count: term }
            );
        }
        if (!planMatchesPredefinedRule(term, plan.financing_percentage)) {
            // Un plan fuera de regla (por ejemplo, histórico anterior a 007)
            // no se usa para operaciones nuevas.
            throw AppError.conflict(
                `El plan de ${term} cuotas del producto "${product.name}" está configurado con +${plan.financing_percentage}% y la regla vigente es +${predefinedPercentage(term)}%. Debe corregirlo Administración.`,
                { product_id: product.id, plan_id: plan.id, installments_count: term }
            );
        }

        percentHundredths = percentToHundredths(plan.financing_percentage);
        configuredMinimumUnitCents = moneyToCents(plan.minimum_price);
        configuredInstallmentUnitCents = moneyToCents(plan.minimum_installment);
    } else {
        const percentage = specialPercentage(term);
        if (percentage === null) {
            throw AppError.unprocessable(
                `El financiamiento especial requiere al menos ${SPECIAL_MIN_INSTALLMENTS} cuotas`,
                { product_id: product.id, installments_count: term }
            );
        }
        percentHundredths = BigInt(percentage) * 100n;
    }

    const minimumUnitCents = effectiveMinimumPrice(priceFromCost(costCents, percentHundredths), configuredMinimumUnitCents);
    const minimumInstallment = effectiveMinimumInstallment(
        minimumUnitCents,
        item.quantity,
        term,
        configuredInstallmentUnitCents
    );

    const quantity = BigInt(item.quantity);
    const unitPriceCents = moneyToCents(item.proposed_price);
    const lineTotalCents = unitPriceCents * quantity;
    const termBig = BigInt(term);

    return {
        product_id: product.id,
        quantity: item.quantity,
        product_code_snapshot: product.code,
        product_name_snapshot: product.name,
        cost_snapshot: centsToMoney(costCents),
        financing_type: item.financing_type,
        installments_count: term,
        financing_percentage_snapshot: centsToMoney(percentHundredths),
        minimum_price_snapshot: centsToMoney(minimumUnitCents),
        minimum_installment_snapshot: centsToMoney(minimumInstallment.effective),
        configured_minimum_price_snapshot:
            configuredMinimumUnitCents === null ? null : centsToMoney(configuredMinimumUnitCents),
        configured_minimum_installment_snapshot:
            configuredInstallmentUnitCents === null ? null : centsToMoney(configuredInstallmentUnitCents),
        proposed_price: centsToMoney(unitPriceCents),
        proposed_installment: centsToMoney(divideHalfUp(lineTotalCents, termBig)),
        lineTotalCents,
    };
}

// ---------------------------------------------------------------------
// CREACIÓN
// ---------------------------------------------------------------------

function fingerprintOf(payload) {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Prefiere el dato de la ficha del cliente; el formulario es solo respaldo. */
function fromCustomerOrForm(customerValue, formValue) {
    return customerValue ?? formValue ?? null;
}

async function replayIfDuplicate(userId, clientRequestId, fingerprint, scope) {
    const previous = await model.findByRequestKey(userId, clientRequestId);
    if (!previous) return null;
    if (previous.request_fingerprint !== fingerprint) {
        throw AppError.conflict(
            'La clave Idempotency-Key ya se usó para una solicitud con datos distintos',
            { credit_application_id: previous.id }
        );
    }
    return model.findById(previous.id, scope);
}

/**
 * Crea una solicitud de crédito.
 *
 * @param {object} payload           cuerpo ya validado y normalizado por Zod
 * @param {{id: number, role: string}} user
 * @param {{idempotencyKey?: string|null}} options
 * @returns {{application: object, replayed: boolean}}
 */
export async function createCreditApplication(payload, user, { idempotencyKey = null } = {}) {
    if (!user?.id) throw AppError.unauthorized();

    const fingerprint = fingerprintOf(payload);
    // El creador siempre puede ver lo que acaba de registrar.
    const creatorScope = { global: false, own: true, branch: false, userId: user.id, branchId: null };

    if (idempotencyKey) {
        const replay = await replayIfDuplicate(user.id, idempotencyKey, fingerprint, creatorScope);
        if (replay) return { application: replay, replayed: true };
    }

    try {
        const applicationId = await withTransaction(async (client) => {
            // Serializa las solicitudes de un mismo cliente: la regla de
            // reconfirmación depende de cuál fue su última operación.
            await model.lockCustomer(client, payload.customer_id);

            // Tras esperar el bloqueo, un envío repetido ya puede estar confirmado.
            if (idempotencyKey && (await model.findByRequestKey(user.id, idempotencyKey, client))) {
                throw new ReplaySignal();
            }

            const userBranch = await model.getUserBranch(user.id, client);
            if (!userBranch) throw AppError.unauthorized('El usuario de la sesión ya no existe');
            if (!userBranch.branch_id) {
                throw AppError.unprocessable(
                    'Tu usuario no tiene una sucursal asignada. Administración debe asignarla antes de registrar solicitudes.'
                );
            }
            if (!userBranch.branch_is_active) {
                throw AppError.unprocessable('Tu sucursal está inactiva; no se pueden registrar solicitudes en ella');
            }

            const customer = await model.getCustomerById(payload.customer_id, client);
            if (!customer) throw AppError.badRequest('El cliente seleccionado no existe');
            if (!customer.is_active) {
                throw AppError.unprocessable('El cliente está inactivo; actívalo antes de registrar una solicitud');
            }

            // CLIENTE EXISTENTE (regla 9): con operaciones previas debe haber una
            // reconfirmación de datos posterior a la última de ellas.
            const confirmation = await model.customerConfirmationState(client, customer.id);
            const isExisting = confirmation.last_operation_at !== null;
            if (isExisting && (!confirmation.confirmed_at || confirmation.confirmed_at <= confirmation.last_operation_at)) {
                throw AppError.unprocessable(
                    'El cliente ya tiene operaciones registradas: antes de una nueva solicitud debe actualizar y reconfirmar sus datos',
                    { reason: 'CUSTOMER_RECONFIRMATION_REQUIRED', customer_id: Number(customer.id) }
                );
            }

            const lines = [];
            for (const item of payload.items) {
                lines.push(await buildLine(item, client, payload.credit_type));
            }

            const totalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0n);
            const downPaymentCents = moneyToCents(payload.proposed_down_payment);
            if (downPaymentCents >= totalCents) {
                throw AppError.unprocessable(
                    `El enganche propuesto (Q${centsToMoney(downPaymentCents)}) debe ser menor que el total de la solicitud (Q${centsToMoney(totalCents)}): está incluido dentro del precio financiado`,
                    { total: centsToMoney(totalCents), proposed_down_payment: centsToMoney(downPaymentCents) }
                );
            }

            const application = {
                customer_id: customer.id,
                branch_id: userBranch.branch_id,
                created_by: user.id,

                // Datos del cliente: siempre desde su ficha.
                customer_dpi_snapshot: customer.dpi,
                customer_full_name_snapshot: customer.full_name,
                customer_phone_snapshot: customer.phone,
                customer_phone_alt_snapshot: customer.phone_alt,
                customer_email_snapshot: customer.email,
                customer_address_snapshot: customer.address,
                customer_address_ref_snapshot: customer.address_ref,
                customer_municipality_snapshot: fromCustomerOrForm(customer.municipality, payload.customer_municipality),
                customer_department_snapshot: fromCustomerOrForm(customer.department, payload.customer_department),

                // Datos declarados para esta solicitud (ya normalizados).
                housing_type_snapshot: payload.housing_type,
                residence_time_snapshot: payload.residence_time,
                employer_name_snapshot: payload.employer_name,
                employer_address_snapshot: payload.employer_address,
                employer_phone_snapshot: payload.employer_phone,
                employment_time_snapshot: payload.employment_time,
                job_position_snapshot: payload.job_position,
                monthly_income_snapshot: payload.monthly_income,
                labor_reference_name_snapshot: payload.labor_reference_name,
                labor_reference_phone_snapshot: payload.labor_reference_phone,
                labor_reference_relation_snapshot: payload.labor_reference_relation,
                personal_reference_name_snapshot: payload.personal_reference_name,
                personal_reference_phone_snapshot: payload.personal_reference_phone,
                personal_reference_relation_snapshot: payload.personal_reference_relation,
                guarantor_name_snapshot: payload.guarantor_name,
                guarantor_dpi_snapshot: payload.guarantor_dpi,
                guarantor_phone_snapshot: payload.guarantor_phone,
                guarantor_address_snapshot: payload.guarantor_address,
                guarantor_relation_snapshot: payload.guarantor_relation,

                proposed_down_payment: centsToMoney(downPaymentCents),
                client_request_id: idempotencyKey,
                request_fingerprint: idempotencyKey ? fingerprint : null,
                credit_type: payload.credit_type,
                customer_confirmation_id: isExisting ? confirmation.confirmation_id : null,
            };

            return model.createApplication(client, application, lines);
        });

        return { application: await model.findById(applicationId, creatorScope), replayed: false };
    } catch (error) {
        // Dos envíos simultáneos con la misma clave: el segundo choca con el
        // índice único (o lo detecta tras el bloqueo) y devuelve la del primero.
        if (
            idempotencyKey &&
            (error instanceof ReplaySignal || (error?.code === '23505' && error?.constraint === UNIQUE_REQUEST_CONSTRAINT))
        ) {
            const replay = await replayIfDuplicate(user.id, idempotencyKey, fingerprint, creatorScope);
            if (replay) return { application: replay, replayed: true };
        }
        throw error;
    }
}

/**
 * Cálculo de condiciones y mínimos SIN guardar: el formulario muestra lo
 * mismo que registrará el backend.
 */
export async function quoteCreditApplication(payload) {
    return withTransaction(async (client) => {
        const lines = [];
        for (const item of payload.items) {
            lines.push(await buildLine(item, client, payload.credit_type));
        }
        const totalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0n);
        const downPaymentCents = moneyToCents(payload.proposed_down_payment);
        const terms = new Set(lines.map((l) => l.installments_count));
        return {
            credit_type: payload.credit_type,
            items: lines.map(({ lineTotalCents, ...line }) => ({
                ...line,
                line_total: centsToMoney(lineTotalCents),
                requires_price_exception: moneyToCents(line.proposed_price) < moneyToCents(line.minimum_price_snapshot),
                requires_installment_exception:
                    moneyToCents(line.proposed_installment) < moneyToCents(line.minimum_installment_snapshot),
            })),
            total: centsToMoney(totalCents),
            proposed_down_payment: centsToMoney(downPaymentCents),
            financed_amount: centsToMoney(totalCents - downPaymentCents),
            down_payment_valid: downPaymentCents < totalCents,
            installments_count: terms.size === 1 ? [...terms][0] : null,
        };
    });
}

// ---------------------------------------------------------------------
// CONSULTA
// ---------------------------------------------------------------------

/** Escapa los comodines de LIKE para buscar el texto literal. */
function escapeLike(text) {
    return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function listCreditApplications(filters, user) {
    const scope = await resolveViewScope(user);
    const raw = filters.search ?? '';
    const search = raw
        ? { normalized: escapeLike(normalizeSearch(raw)), digits: raw.replace(/[^0-9]/g, '') }
        : null;
    return model.list({ ...filters, search }, scope, config.timezone);
}

export async function getCreditApplication(applicationId, user) {
    const scope = await resolveViewScope(user);
    const application = await model.findById(applicationId, scope);
    if (!application) throw AppError.notFound('Solicitud de crédito no encontrada');
    return application;
}
