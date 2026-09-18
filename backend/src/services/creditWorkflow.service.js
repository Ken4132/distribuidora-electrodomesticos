import { query, withTransaction } from '../config/db.js';
import * as model from '../models/creditApplication.model.js';
import * as flow from '../models/creditWorkflow.model.js';
import { userCan } from './authorization.service.js';
import { buildLine, resolveViewScope } from './creditApplication.service.js';
import { AppError } from '../utils/AppError.js';
import { moneyToCents } from '../utils/creditPricing.js';

/**
 * FLUJO DE CRÉDITO — Bloque 3.2
 *
 *   SOLICITADO --(1ª verificación)--> EN_VERIFICACION --(Cobrador concluye)--> EN_EVALUACION
 *   EN_EVALUACION --(Admin/Gerencia)--> APROBADO | RECHAZADO
 *   Antes de la decisión: CANCELADO (vendedor creador o Administración).
 *   APROBADO: CANCELADO solo por Administración.
 *
 *   Crédito EXCEPCIONAL_CONTADO: decisión directa de Admin/Gerencia (sin
 *   verificación obligatoria).
 *
 * Toda operación bloquea la solicitud (FOR UPDATE) y valida el estado sobre
 * la fila bloqueada. Estados, verificaciones, decisiones, excepciones y
 * modificaciones quedan en tablas de solo inserción.
 */

export const PRE_DECISION_STATUSES = Object.freeze(['SOLICITADO', 'EN_VERIFICACION', 'EN_EVALUACION']);

async function loadLocked(client, applicationId) {
    const application = await flow.lockApplication(client, applicationId);
    if (!application) throw AppError.notFound('Solicitud de crédito no encontrada');
    return application;
}

/**
 * La operación debe caer dentro de lo que el usuario puede CONSULTAR: nadie
 * actúa sobre un expediente que no puede ver. Fuera de alcance = 404.
 */
async function assertVisible(user, applicationId, client) {
    const scope = await resolveViewScope(user);
    const visible = await model.findById(applicationId, scope, client);
    if (!visible) throw AppError.notFound('Solicitud de crédito no encontrada');
    return scope;
}

async function changeStatus(client, application, toStatus, userId, reason = null, extra = {}) {
    await flow.updateStatus(client, application.id, toStatus, extra);
    await model.insertStatusHistory(client, {
        applicationId: application.id,
        fromStatus: application.status,
        toStatus,
        userId,
        reason,
    });
    application.status = toStatus;
}

/**
 * Expediente tras la operación. Si la operación sacó la solicitud del alcance
 * del usuario (p. ej. el Cobrador la envía a evaluación y deja de verla), se
 * devuelve solo el resumen del estado resultante.
 */
async function detail(applicationId, user) {
    const scope = await resolveViewScope(user);
    const full = await model.findById(applicationId, scope);
    if (full) return full;
    const { rows } = await query(
        'SELECT id, application_number, status, credit_type, updated_at FROM credit_applications WHERE id = $1',
        [applicationId]
    );
    return rows[0] ? { ...rows[0], out_of_scope: true } : null;
}

// ---------------------------------------------------------------------
// VERIFICACIÓN (Cobrador)
// ---------------------------------------------------------------------

export async function registerVerification(applicationId, input, user) {
    await withTransaction(async (client) => {
        const application = await loadLocked(client, applicationId);
        await assertVisible(user, applicationId, client);

        if (!['SOLICITADO', 'EN_VERIFICACION'].includes(application.status)) {
            throw AppError.conflict(`No se puede verificar una solicitud en estado ${application.status}`);
        }

        await flow.insertVerification(client, {
            ...input,
            credit_application_id: application.id,
            verified_by: user.id,
        });

        if (application.status === 'SOLICITADO') {
            await changeStatus(client, application, 'EN_VERIFICACION', user.id, 'Primera verificación registrada');
        }

        if (input.conclude) {
            await changeStatus(client, application, 'EN_EVALUACION', user.id, `Verificación concluida: ${input.result}`, {
                verification_concluded_at: new Date(),
                verification_concluded_by: user.id,
            });
        }
    });
    return detail(applicationId, user);
}

/** El Cobrador envía a evaluación usando la última verificación registrada. */
export async function concludeVerification(applicationId, user) {
    await withTransaction(async (client) => {
        const application = await loadLocked(client, applicationId);
        await assertVisible(user, applicationId, client);

        if (application.status !== 'EN_VERIFICACION') {
            throw AppError.conflict(`Solo se concluye una verificación en curso (estado actual: ${application.status})`);
        }
        const last = await flow.latestVerification(client, application.id);
        if (!last) throw AppError.unprocessable('Registra una verificación antes de enviarla a evaluación');
        if (last.result === 'NECESITA_REVISION') {
            throw AppError.unprocessable(
                'La última verificación necesita revisión: la solicitud permanece en verificación hasta registrar una concluyente'
            );
        }
        await changeStatus(client, application, 'EN_EVALUACION', user.id, `Verificación concluida: ${last.result}`, {
            verification_concluded_at: new Date(),
            verification_concluded_by: user.id,
        });
    });
    return detail(applicationId, user);
}

// ---------------------------------------------------------------------
// MODIFICACIÓN DE CONDICIONES
//
// QUIÉN y QUÉ EFECTO tiene (decisiones del propietario, 2026-09-17):
//
//   * Administración o Gerencia (`credits.decide`): precio, plazo, tipo de
//     plan, enganche, PRODUCTOS y CANTIDADES. Si la solicitud ya estaba
//     APROBADA sigue APROBADA y la modificación se considera aprobada de
//     inmediato: no hay segunda decisión ni verificación nueva.
//   * El vendedor que la registró (`credits.modify.own`): lo mismo, pero si
//     la solicitud ya estaba APROBADA la aprobación anterior deja de bastar:
//     queda `requires_final_review = true` y no se puede concretar hasta que
//     Administración o Gerencia hagan la última revisión.
//
// Las líneas NUNCA se borran: se retiran con `is_void` y se conservan.
// ---------------------------------------------------------------------

const CONDITION_FIELDS = [
    'quantity',
    'financing_type',
    'installments_count',
    'proposed_price',
    'financing_percentage_snapshot',
    'minimum_price_snapshot',
    'minimum_installment_snapshot',
    'proposed_installment',
    'cost_snapshot',
    'configured_minimum_price_snapshot',
    'configured_minimum_installment_snapshot',
];

const asText = (value) => (value === null || value === undefined ? null : String(value));

/** Quién modifica y con qué alcance. Fuera de alcance = 404 (no se confirma). */
async function resolveModifier(client, application, user, applicationId) {
    const decider = await userCan(user, 'credits.decide');
    const ownModifier =
        !decider &&
        (await userCan(user, 'credits.modify.own')) &&
        Number(application.created_by) === Number(user.id);

    if (!decider && !ownModifier) {
        await assertVisible(user, applicationId, client);
        throw AppError.forbidden(
            'Solo Administración, Gerencia o el vendedor que registró la solicitud pueden modificar sus condiciones'
        );
    }
    return { decider, ownModifier };
}

export async function modifyConditions(applicationId, input, user) {
    await withTransaction(async (client) => {
        const application = await loadLocked(client, applicationId);
        await assertVisible(user, applicationId, client);
        const { decider } = await resolveModifier(client, application, user, applicationId);

        // Decisión del propietario (2026-09-17): también se modifica una solicitud
        // APROBADA; la aprobación se conserva y no vuelve a evaluación.
        const approved = application.status === 'APROBADO';
        if (!PRE_DECISION_STATUSES.includes(application.status) && !approved) {
            throw AppError.conflict(`Las condiciones ya no se pueden modificar en estado ${application.status}`);
        }
        if (!approved && input.exceptions.length) {
            throw AppError.unprocessable(
                'Antes de la decisión las líneas bajo el mínimo se autorizan en la decisión, no al modificar'
            );
        }
        if (approved && !decider && input.exceptions.length) {
            throw AppError.unprocessable(
                'Solo Administración o Gerencia autorizan líneas bajo el mínimo: tus cambios quedarán pendientes de la última revisión'
            );
        }
        if (approved && !input.comment) {
            throw AppError.unprocessable(
                'Modificar una solicitud aprobada exige el motivo del cambio',
                [{ campo: 'comment', mensaje: 'Obligatorio al modificar una solicitud aprobada' }]
            );
        }
        if (application.credit_type === 'EXCEPCIONAL_CONTADO') {
            throw AppError.unprocessable(
                'El crédito excepcional a precio de contado tiene condiciones fijas (precio de contado, enganche Q0, un pago)'
            );
        }

        const items = await flow.lockItems(client, application.id);
        const byId = new Map(items.map((i) => [Number(i.id), i]));
        const comment = input.comment ?? null;
        let changes = 0;

        const record = (itemId, field, oldValue, newValue, note = comment) =>
            flow.insertChange(client, {
                applicationId: application.id,
                itemId,
                field,
                oldValue,
                newValue,
                userId: user.id,
                comment: note,
            });

        // 1. PRODUCTOS NUEVOS. Se agregan antes de retirar para que se pueda
        //    sustituir un producto por otro en una sola operación.
        for (const add of input.add_items) {
            const line = await buildLine(add, client);
            const saved = await flow.insertItem(client, application.id, line);
            await record(
                saved.id,
                'linea_agregada',
                null,
                `${line.product_code_snapshot} x${line.quantity} @ Q${line.proposed_price} en ${line.installments_count} cuotas`
            );
            changes += 1;
        }

        // 2. CONDICIONES DE LAS LÍNEAS EXISTENTES (incluida la cantidad).
        for (const change of input.items) {
            const current = byId.get(change.item_id);
            if (!current) {
                throw AppError.unprocessable(`La línea ${change.item_id} no pertenece a esta solicitud o ya fue retirada`);
            }
            // Las condiciones se recalculan con las reglas y el costo vigentes
            // (lo mismo que al crear la solicitud); el historial conserva lo anterior.
            const next = await buildLine(
                {
                    product_id: Number(current.product_id),
                    quantity: change.quantity ?? current.quantity,
                    financing_type: change.financing_type ?? current.financing_type,
                    installments_count: change.installments_count ?? current.installments_count,
                    proposed_price: change.proposed_price ?? current.proposed_price,
                },
                client
            );

            for (const field of CONDITION_FIELDS) {
                const before = asText(current[field]);
                const after = asText(next[field]);
                if (before !== after) {
                    await record(current.id, field, before, after);
                    changes += 1;
                }
            }
            if (change.quantity !== undefined && change.quantity !== current.quantity) {
                await flow.updateItemQuantity(client, current.id, change.quantity);
            }
            await flow.updateItemConditions(client, current.id, next);
        }

        // 3. PRODUCTOS RETIRADOS. La fila se conserva (is_void), nunca se borra.
        for (const removal of input.void_items) {
            const current = byId.get(removal.item_id);
            if (!current) {
                throw AppError.unprocessable(`La línea ${removal.item_id} no pertenece a esta solicitud o ya fue retirada`);
            }
            const voided = await flow.voidItem(client, current.id, user.id);
            if (!voided) {
                throw AppError.unprocessable(`La línea ${removal.item_id} ya estaba retirada`);
            }
            await record(
                current.id,
                'is_void',
                'false',
                'true',
                removal.reason ?? comment
            );
            changes += 1;
        }

        if (input.proposed_down_payment !== undefined) {
            const before = asText(application.proposed_down_payment);
            if (before !== input.proposed_down_payment) {
                await flow.setProposedDownPayment(client, application.id, input.proposed_down_payment);
                await record(null, 'proposed_down_payment', before, input.proposed_down_payment);
                changes += 1;
            }
        }

        if (changes === 0) {
            throw AppError.unprocessable('Los valores indicados son iguales a las condiciones actuales: no hay cambios');
        }

        const totals = await flow.totals(client, application.id);
        if (moneyToCents(totals.proposed_down_payment) >= moneyToCents(totals.total)) {
            throw AppError.unprocessable(
                `El enganche propuesto (Q${totals.proposed_down_payment}) debe ser menor que el total de la solicitud (Q${totals.total})`,
                { total: totals.total, proposed_down_payment: totals.proposed_down_payment }
            );
        }

        if (!approved) return;

        if (decider) {
            // Administración o Gerencia: la modificación queda aprobada en el
            // acto. Las líneas que quedan bajo el mínimo se autorizan aquí.
            await authorizeModifiedExceptions(client, application, input.exceptions, user);

            // Si había una modificación del vendedor esperando revisión, esta
            // intervención de Administración/Gerencia la resuelve y queda
            // registrada como tal: la bandera nunca se apaga en silencio.
            if (application.requires_final_review) {
                await flow.insertFinalReview(client, {
                    applicationId: application.id,
                    result: 'CONFIRMADO',
                    userId: user.id,
                    triggeredBy: application.final_review_requested_by,
                    triggeredAt: application.final_review_requested_at,
                    comment: comment
                        ? `Confirmado al modificar las condiciones: ${comment}`
                        : 'Confirmado al modificar las condiciones',
                });
                await flow.setFinalReviewFlag(client, application.id, false, user.id);
                await record(null, 'requires_final_review', 'true', 'false');
            }
            return;
        }

        // El vendedor modificó una solicitud ya aprobada: la aprobación
        // anterior deja de bastar. No vuelve a verificación ni pierde su
        // decisión; simplemente no se concreta hasta la última revisión.
        if (!application.requires_final_review) {
            await flow.setFinalReviewFlag(client, application.id, true, user.id);
            await record(null, 'requires_final_review', 'false', 'true');
        }
    });
    return detail(applicationId, user);
}

/**
 * Tras modificar una solicitud APROBADA, toda línea que quede bajo el mínimo
 * sin una autorización que cubra sus condiciones nuevas exige motivo en la
 * misma operación. La autorización se liga a la decisión existente
 * (origen MODIFICACION): no hay una segunda aprobación.
 */
async function authorizeModifiedExceptions(client, application, exceptions, user) {
    const pending = await flow.unauthorizedExceptionLines(client, application.id);
    const reasons = new Map(exceptions.map((e) => [e.item_id, e.reason]));
    const missing = pending.filter((l) => !reasons.has(Number(l.id)));
    if (missing.length) {
        throw AppError.unprocessable(
            'La modificación deja líneas bajo el mínimo comercial: autoriza cada una con su motivo',
            {
                reason: 'EXCEPTION_AUTHORIZATION_REQUIRED',
                items: missing.map((l) => ({
                    item_id: Number(l.id),
                    producto: l.product_name_snapshot,
                    precio_minimo: l.minimum_unit_price,
                    precio_propuesto: l.proposed_unit_price,
                    cuota_minima: l.line_minimum_installment,
                    cuota_propuesta: l.line_installment,
                })),
            }
        );
    }
    const pendingIds = new Set(pending.map((l) => Number(l.id)));
    const unexpected = exceptions.filter((e) => !pendingIds.has(e.item_id));
    if (unexpected.length) {
        throw AppError.unprocessable(
            'Se enviaron autorizaciones para líneas que no quedan bajo el mínimo o que ya están autorizadas',
            unexpected.map((e) => ({ item_id: e.item_id }))
        );
    }
    const decision = await flow.latestDecision(client, application.id);
    for (const line of pending) {
        await flow.insertException(client, {
            decisionId: decision.id,
            itemId: line.id,
            kind: exceptionKind(line),
            minimumUnitPrice: line.minimum_unit_price,
            proposedUnitPrice: line.proposed_unit_price,
            unitPriceDifference: line.unit_price_difference,
            minimumLineInstallment: line.line_minimum_installment,
            proposedLineInstallment: line.line_installment,
            reason: reasons.get(Number(line.id)),
            userId: user.id,
            branchId: application.branch_id,
            source: 'MODIFICACION',
        });
    }
}

// ---------------------------------------------------------------------
// ÚLTIMA REVISIÓN (Administración / Gerencia)
//
// No es una segunda decisión: la solicitud sigue APROBADA y conserva su
// única `credit_decision`. Solo confirma o rechaza las condiciones que el
// vendedor cambió después de la aprobación.
//
//   CONFIRMADO -> requires_final_review = false: ya se puede concretar.
//   RECHAZADO  -> la bandera sigue encendida y la venta sigue bloqueada.
//                 Administración o Gerencia pueden entonces corregir las
//                 condiciones ellos mismos o cancelar la solicitud.
// ---------------------------------------------------------------------

export async function finalReview(applicationId, input, user) {
    await withTransaction(async (client) => {
        const application = await loadLocked(client, applicationId);
        await assertVisible(user, applicationId, client);

        if (application.status !== 'APROBADO') {
            throw AppError.conflict(
                `Solo se revisan las condiciones de una solicitud APROBADA (estado actual: ${application.status})`
            );
        }
        if (!application.requires_final_review) {
            throw AppError.conflict('Esta solicitud no tiene cambios pendientes de revisión');
        }

        if (input.result === 'CONFIRMADO') {
            // Confirmar implica hacerse cargo de las líneas bajo el mínimo.
            await authorizeModifiedExceptions(client, application, input.exceptions, user);
        }

        await flow.insertFinalReview(client, {
            applicationId: application.id,
            result: input.result,
            userId: user.id,
            triggeredBy: application.final_review_requested_by,
            triggeredAt: application.final_review_requested_at,
            comment: input.comment ?? null,
        });

        if (input.result === 'CONFIRMADO') {
            await flow.setFinalReviewFlag(client, application.id, false, user.id);
            await flow.insertChange(client, {
                applicationId: application.id,
                itemId: null,
                field: 'requires_final_review',
                oldValue: 'true',
                newValue: 'false',
                userId: user.id,
                comment: input.comment ?? null,
            });
        }
    });
    return detail(applicationId, user);
}

// ---------------------------------------------------------------------
// DECISIÓN (Administración / Gerencia)
// ---------------------------------------------------------------------

function exceptionKind(line) {
    if (line.requires_price_exception && line.requires_installment_exception) return 'PRECIO_Y_CUOTA';
    return line.requires_price_exception ? 'PRECIO' : 'CUOTA';
}

export async function decide(applicationId, input, user) {
    await withTransaction(async (client) => {
        const application = await loadLocked(client, applicationId);
        await assertVisible(user, applicationId, client);
        const exceptional = application.credit_type === 'EXCEPCIONAL_CONTADO';

        if (exceptional) {
            if (!PRE_DECISION_STATUSES.includes(application.status)) {
                throw AppError.conflict(`No se puede decidir una solicitud en estado ${application.status}`);
            }
        } else {
            if (application.status !== 'EN_EVALUACION') {
                throw AppError.conflict(
                    application.status === 'SOLICITADO' || application.status === 'EN_VERIFICACION'
                        ? 'La solicitud no tiene una verificación concluida: no se puede aprobar ni rechazar todavía'
                        : `No se puede decidir una solicitud en estado ${application.status}`
                );
            }
            if (!application.verification_concluded_at) {
                throw AppError.unprocessable('La solicitud no tiene una verificación concluida');
            }
        }

        const lines = await flow.itemsWithFlags(client, application.id);
        const requiring = lines.filter((l) => l.requires_exception);
        const authorizations = new Map(input.exceptions.map((e) => [e.item_id, e.reason]));

        if (input.decision === 'APROBADO') {
            const missing = requiring.filter((l) => !authorizations.has(Number(l.id)));
            if (missing.length) {
                throw AppError.unprocessable(
                    'Hay líneas bajo el mínimo comercial: la aprobación requiere autorizar cada una con su motivo',
                    missing.map((l) => ({
                        item_id: Number(l.id),
                        producto: l.product_name_snapshot,
                        precio_minimo: l.minimum_unit_price,
                        precio_propuesto: l.proposed_unit_price,
                        cuota_minima: l.line_minimum_installment,
                        cuota_propuesta: l.line_installment,
                    }))
                );
            }
            const requiringIds = new Set(requiring.map((l) => Number(l.id)));
            const unexpected = input.exceptions.filter((e) => !requiringIds.has(e.item_id));
            if (unexpected.length) {
                throw AppError.unprocessable(
                    'Se enviaron autorizaciones para líneas que no están bajo el mínimo',
                    unexpected.map((e) => ({ item_id: e.item_id }))
                );
            }
            const totals = await flow.totals(client, application.id);
            if (moneyToCents(totals.proposed_down_payment) >= moneyToCents(totals.total)) {
                throw AppError.unprocessable('El enganche propuesto debe ser menor que el total de la solicitud');
            }
        } else if (input.exceptions.length) {
            throw AppError.unprocessable('Un rechazo no lleva autorizaciones de excepción');
        }

        const decision = await flow.insertDecision(client, {
            applicationId: application.id,
            userId: user.id,
            decision: input.decision,
            comment: input.comment,
        });

        if (input.decision === 'APROBADO') {
            for (const line of requiring) {
                await flow.insertException(client, {
                    decisionId: decision.id,
                    itemId: line.id,
                    kind: exceptionKind(line),
                    minimumUnitPrice: line.minimum_unit_price,
                    proposedUnitPrice: line.proposed_unit_price,
                    unitPriceDifference: line.unit_price_difference,
                    minimumLineInstallment: line.line_minimum_installment,
                    proposedLineInstallment: line.line_installment,
                    reason: authorizations.get(Number(line.id)),
                    userId: user.id,
                    branchId: application.branch_id,
                });
            }
        }

        await changeStatus(client, application, input.decision, user.id, input.comment ?? null);
    });
    return detail(applicationId, user);
}

// ---------------------------------------------------------------------
// CANCELACIÓN
// ---------------------------------------------------------------------

export async function cancel(applicationId, input, user) {
    await withTransaction(async (client) => {
        const application = await loadLocked(client, applicationId);
        const isAdmin = await userCan(user, 'credits.cancel');
        const isCreator = Number(application.created_by) === Number(user.id) && (await userCan(user, 'credits.create'));

        if (!isAdmin && !isCreator) {
            // No se confirma la existencia de expedientes ajenos.
            await assertVisible(user, applicationId, client);
            throw AppError.forbidden('Solo el vendedor que creó la solicitud o Administración pueden cancelarla');
        }

        const allowed = isAdmin ? [...PRE_DECISION_STATUSES, 'APROBADO'] : PRE_DECISION_STATUSES;
        if (!allowed.includes(application.status)) {
            throw AppError.conflict(
                application.status === 'APROBADO'
                    ? 'Una solicitud aprobada solo la puede cancelar Administración'
                    : `No se puede cancelar una solicitud en estado ${application.status}`
            );
        }

        await changeStatus(client, application, 'CANCELADO', user.id, input.reason, {
            cancelled_at: new Date(),
            cancelled_by: user.id,
            cancel_reason: input.reason,
        });
    });
    return detail(applicationId, user);
}

// ---------------------------------------------------------------------
// HISTORIAL CREDITICIO PARA EVALUAR
// ---------------------------------------------------------------------

export async function evaluationContext(applicationId, user) {
    const application = await detail(applicationId, user);
    if (!application) throw AppError.notFound('Solicitud de crédito no encontrada');
    const history = await flow.customerCreditHistory(application.customer_id, application.id);
    return { application, customer_history: history };
}
