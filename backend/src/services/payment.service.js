import { createHash } from 'node:crypto';
import { withTransaction, query } from '../config/db.js';
import * as Payment from '../models/payment.model.js';
import * as Sale from '../models/sale.model.js';
import { AppError } from '../utils/AppError.js';
import { money, toCents, fromCents } from '../utils/money.js';
import { today, isIsoDate } from '../utils/dates.js';
import { recordEvent, EVENT_TYPES, dispatchInBackground } from './events.service.js';
import { saleInScope, scopeDenialMessage, ownPortfolioFilter } from './scope.service.js';
import { recordAudit } from './audit.service.js';
import { NEW_PAYMENT_METHODS } from '../validators/payment.schema.js';

export const listPayments = (opts) => Payment.list(opts);

/**
 * ESTADO DOCUMENTAL INICIAL SEGÚN EL MÉTODO (bloque 4.1)
 *
 * Reglas ya documentadas (docs/REGLAS-DE-NEGOCIO.md §13 PG4 y las decisiones
 * del bloque 4):
 *
 *   * Efectivo: reduce el saldo en el acto y queda PENDIENTE_DE_BOLETA, a la
 *     espera de su respaldo.
 *   * Remesa: se trata igual que el efectivo (decisión del propietario,
 *     2026-09-18). Es dinero que entra a caja sin respaldo bancario propio,
 *     así que queda PENDIENTE_DE_BOLETA y la referencia es opcional. No crea
 *     un estado documental distinto: reutiliza el del efectivo.
 *   * Depósito y transferencia: el correlativo o referencia es OBLIGATORIO al
 *     registrar; como ya llegan con respaldo, quedan EN_REVISION.
 *   * Tarjeta: también llega con comprobante, así que sigue el mismo camino
 *     que la transferencia: EN_REVISION con referencia obligatoria.
 *
 * `cheque` y `otro` NO están aquí a propósito: se retiraron de la operación y
 * un pago nuevo con ellos se rechaza (ver abajo). Los pagos históricos que ya
 * los usan se conservan intactos.
 *
 * REVISADA y RECHAZADA no se asignan aquí: son el resultado de la revisión,
 * que es del bloque 4.2. No existe ningún otro estado.
 */
const VOUCHER_ON_REGISTER = Object.freeze({
    efectivo: { status: 'PENDIENTE_DE_BOLETA', referenceRequired: false },
    remesa: { status: 'PENDIENTE_DE_BOLETA', referenceRequired: false },
    deposito: { status: 'EN_REVISION', referenceRequired: true },
    transferencia: { status: 'EN_REVISION', referenceRequired: true },
    tarjeta: { status: 'EN_REVISION', referenceRequired: true },
});

/**
 * Qué exige y qué estado documental deja un método de pago.
 * Devuelve `null` si el método no es operativo: quien llame decide el error.
 */
export function voucherRuleFor(method) {
    return VOUCHER_ON_REGISTER[method] ?? null;
}

/** Huella del cuerpo validado: detecta la misma clave con datos distintos. */
function fingerprintOf(payload) {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Señal interna: esta clave ya registró un pago (se devuelve ese). */
class ReplaySignal extends Error {}

const UNIQUE_REQUEST_INDEX = 'ux_payments_request';

/** Respuesta completa del pago: venta, cuotas y pagos tras la operación. */
async function saleSnapshot(saleId) {
    const [sale, installments, payments] = await Promise.all([
        Sale.findById(saleId),
        Sale.findInstallments(saleId),
        Sale.findPayments(saleId),
    ]);
    return { sale, installments, payments };
}

export async function getPayment(id) {
    const payment = await Payment.findById(id);
    if (!payment) throw AppError.notFound('Pago no encontrado');
    // Los campos técnicos de idempotencia no forman parte del expediente.
    const { client_request_id, request_fingerprint, ...rest } = payment;
    return rest;
}

/**
 * Registra un pago y lo asigna FIFO a las cuotas pendientes, de la más
 * antigua a la más reciente, sin saltar ninguna.
 *
 * Todo ocurre en una transacción con la venta y sus cuotas bloqueadas, de
 * modo que dos cobros simultáneos no puedan generar sobrepago ni repartirse
 * mal el mismo saldo.
 *
 * @param {object} input   datos del pago ya validados
 * @param {object} actor   quien cobra: { id, username, role, ip, userAgent }
 * @param {object} scope   alcance resuelto: { global, userId } (ver scope.service.js)
 * @param {{idempotencyKey?: string|null}} options
 * @returns {{sale, installments, payments, payment, replayed}}
 */
export async function createPayment(input, actor, scope, { idempotencyKey = null } = {}) {
    const paymentDate = input.payment_date && isIsoDate(input.payment_date) ? input.payment_date : today();
    const userId = actor?.id ?? null;
    const fingerprint = fingerprintOf({ ...input, payment_date: paymentDate });

    // DOBLE ENVÍO: si esta clave ya registró un pago, se devuelve aquel en
    // lugar de cobrar otra vez. Se comprueba antes de abrir la transacción y
    // otra vez dentro, con la venta ya bloqueada.
    if (idempotencyKey) {
        const previous = await replayIfDuplicate(userId, idempotencyKey, fingerprint);
        if (previous) return { ...(await saleSnapshot(previous.sale_id)), payment: previous.payment, replayed: true };
    }

    let result;
    try {
        result = await withTransaction(async (client) => {
            const { rows: sales } = await client.query(
                `SELECT s.id, s.customer_id, s.status, s.total, s.sale_date, s.created_by, s.payment_mode,
                        c.full_name, c.dpi, c.phone
                   FROM sales s JOIN customers c ON c.id = s.customer_id
                  WHERE s.id = $1
                    FOR UPDATE OF s`,
                [input.sale_id]
            );
            const sale = sales[0];
            if (!sale) throw AppError.badRequest('La venta indicada no existe');

            // Tras esperar el bloqueo, un envío repetido ya puede estar confirmado.
            if (idempotencyKey && (await Payment.findByRequestKey(userId, idempotencyKey, client))) {
                throw new ReplaySignal();
            }

            // ALCANCE (regla U6). Se comprueba aquí, dentro de la transacción y
            // sobre la MISMA fila que ya quedó bloqueada por FOR UPDATE. Hacerlo
            // en el middleware obligaría a leer la venta antes de la transacción
            // y dejaría una ventana entre comprobar el dueño y cobrar.
            const inScope = saleInScope(sale, scope);
            if (!inScope.allowed) {
                throw AppError.forbidden(scopeDenialMessage(inScope.reason), {
                    sale_id: Number(sale.id),
                    motivo: inScope.reason,
                });
            }

            if (sale.status === 'anulada') throw AppError.unprocessable('No se pueden registrar pagos en una venta anulada');

            // FECHA ECONÓMICA (regla PG1). La fecha futura ya la rechaza el
            // esquema; aquí se compara contra la venta, que es el dato que solo
            // se conoce dentro de la transacción. La base lo vuelve a impedir
            // con `trg_payments_guard_date`: esto es para dar un error claro.
            if (paymentDate < sale.sale_date) {
                throw AppError.unprocessable(
                    `La fecha del pago (${paymentDate}) no puede ser anterior a la fecha de la venta (${sale.sale_date})`,
                    [{ campo: 'payment_date', mensaje: `No puede ser anterior al ${sale.sale_date}` }]
                );
            }

            const applied = await applyPaymentToSale(
                client,
                sale,
                { ...input, payment_date: paymentDate },
                userId,
                { clientRequestId: idempotencyKey, requestFingerprint: idempotencyKey ? fingerprint : null }
            );
            return { saleId: sale.id, payment: applied.payment };
        });
    } catch (error) {
        // Dos envíos simultáneos con la misma clave: el segundo choca con el
        // índice único (o lo detecta tras el bloqueo) y devuelve el del primero.
        if (
            idempotencyKey &&
            (error instanceof ReplaySignal ||
                (error?.code === '23505' && error?.constraint === UNIQUE_REQUEST_INDEX))
        ) {
            const previous = await replayIfDuplicate(userId, idempotencyKey, fingerprint);
            if (previous) {
                return { ...(await saleSnapshot(previous.sale_id)), payment: previous.payment, replayed: true };
            }
        }

        // Un intento de cobrar fuera de la cartera propia es justo lo que hay
        // que poder ver en una auditoría. Se registra DESPUÉS del rollback,
        // porque la transacción ya quedó abortada y nada escrito en ella
        // habría sobrevivido.
        if (error?.code === 'FORBIDDEN') {
            await recordAudit({
                actor,
                action: 'payment.create.denegado',
                module: 'pagos',
                entity: 'sale',
                entityId: Number(input.sale_id) || null,
                summary: `Intentó registrar un pago en la venta #${input.sale_id}, fuera de su cartera: ${error.message}`,
                details: { sale_id: Number(input.sale_id) || null, motivo: error.details?.motivo ?? null },
                result: 'denegado',
            });
        }
        throw error;
    }

    dispatchInBackground();
    return { ...(await saleSnapshot(result.saleId)), payment: result.payment, replayed: false };
}

/** Devuelve el pago ya registrado con esa clave, o null si no existe. */
async function replayIfDuplicate(userId, clientRequestId, fingerprint) {
    const previous = await Payment.findByRequestKey(userId, clientRequestId);
    if (!previous) return null;
    if (previous.request_fingerprint !== fingerprint) {
        throw AppError.conflict('La clave Idempotency-Key ya se usó para un pago con datos distintos', {
            payment_id: Number(previous.id),
        });
    }
    return { sale_id: previous.sale_id, payment: await Payment.findById(previous.id) };
}

/**
 * Aplica un pago a una venta YA BLOQUEADA dentro de la transacción del
 * llamador: bloquea sus cuotas, valida monto contra saldo, registra el pago,
 * lo asigna FIFO (cuota más antigua primero, sin saltar ninguna) y deja los
 * eventos `payment.created` / `sale.paid` en el outbox.
 *
 * Es el ÚNICO lugar donde se aplica dinero a cuotas: lo usan el cobro
 * normal y el enganche real al concretar una venta de crédito (3.3).
 *
 * @param {object} sale  fila de la venta con customer_id, total, full_name, dpi, phone
 * @param {object} input { amount, method, reference, notes, payment_date }
 * @returns {Promise<{payment: object, allocations: object[], remainingCents: number}>}
 */
export async function applyPaymentToSale(client, sale, input, userId, options = {}) {
    const paymentDate = input.payment_date;
    const method = input.method ?? 'efectivo';

    const pending = await Payment.lockPendingInstallments(client, sale.id);
    const balanceCents = pending.reduce((acc, i) => acc + toCents(i.balance), 0);

    if (balanceCents <= 0) {
        throw AppError.conflict('Esta venta ya está totalmente pagada');
    }

    let amountCents = toCents(input.amount);
    if (amountCents <= 0) throw AppError.unprocessable('El monto del pago debe ser mayor a cero');
    if (amountCents > balanceCents) {
        throw AppError.unprocessable(
            `El pago (Q${fromCents(amountCents).toFixed(2)}) excede el saldo pendiente (Q${fromCents(
                balanceCents
            ).toFixed(2)})`
        );
    }

    // RESPALDO DOCUMENTAL (regla PG4). Se comprueba aquí, en el único punto por
    // el que pasa todo el dinero, para que valga igual en el cobro normal y en
    // el enganche de una venta a crédito.
    const voucher = voucherRuleFor(method);
    if (!voucher) {
        // Se comprueba también aquí, y no solo en el validador, porque este es
        // el único punto por el que pasa todo el dinero (cobro y enganche). La
        // base lo vuelve a impedir con `trg_payments_method_operativo`.
        throw AppError.unprocessable(
            `El método "${method}" ya no se usa para pagos nuevos. Métodos operativos: ${NEW_PAYMENT_METHODS.join(', ')}`,
            [{ campo: 'method', mensaje: 'Método retirado de la operación' }]
        );
    }
    const reference = typeof input.reference === 'string' ? input.reference.trim() : input.reference;
    if (voucher.referenceRequired && !reference) {
        throw AppError.unprocessable(
            `Un pago por ${method} necesita el correlativo o número de comprobante`,
            [{ campo: 'reference', mensaje: 'Obligatorio con este método de pago' }]
        );
    }

    // Saldo ANTES del pago: es el que lleva el recibo (bloque 4.2) y el que
    // hace legible la operación en la bitácora.
    const balanceBefore = money(fromCents(balanceCents));

    const payment = await Payment.createPayment(client, {
        sale_id: sale.id,
        customer_id: sale.customer_id,
        payment_date: paymentDate,
        amount: money(fromCents(amountCents)),
        method,
        reference: reference || null,
        notes: input.notes,
        created_by: userId,
        voucher_status: voucher.status,
        client_request_id: options.clientRequestId ?? null,
        request_fingerprint: options.requestFingerprint ?? null,
    });

    // Primer evento del expediente documental del pago.
    await Payment.recordVoucherEvent(client, {
        paymentId: payment.id,
        fromStatus: null,
        toStatus: voucher.status,
        action: 'REGISTRADO',
        actorId: userId,
        comment: reference ? `Registrado por ${method}, referencia ${reference}` : `Registrado por ${method}`,
    });

    // Asignación cuota por cuota
    const allocations = [];
    for (const installment of pending) {
        if (amountCents <= 0) break;
        const due = toCents(installment.balance);
        const applied = Math.min(due, amountCents);
        await Payment.allocate(client, payment.id, installment.id, money(fromCents(applied)));
        allocations.push({ installment_number: installment.number, amount: money(fromCents(applied)) });
        amountCents -= applied;
    }

    const remainingCents = balanceCents - toCents(payment.amount);
    const fullyPaid = remainingCents <= 0;

    await recordEvent(
        {
            type: EVENT_TYPES.PAYMENT_CREATED,
            aggregate: 'payment',
            aggregateId: payment.id,
            payload: {
                payment_id: payment.id,
                receipt_number: `P-${String(payment.id).padStart(6, '0')}`,
                sale_id: sale.id,
                sale_number: `V-${String(sale.id).padStart(6, '0')}`,
                payment_date: paymentDate,
                amount: payment.amount,
                method: payment.method,
                allocations,
                balance_before: balanceBefore,
                remaining_balance: money(fromCents(Math.max(remainingCents, 0))),
                voucher_status: voucher.status,
                reference: reference || null,
                customer: {
                    id: sale.customer_id,
                    dpi: sale.dpi,
                    full_name: sale.full_name,
                    phone: sale.phone,
                },
            },
        },
        client
    );

    if (fullyPaid) {
        await recordEvent(
            {
                type: EVENT_TYPES.SALE_PAID,
                aggregate: 'sale',
                aggregateId: sale.id,
                payload: {
                    sale_id: sale.id,
                    sale_number: `V-${String(sale.id).padStart(6, '0')}`,
                    total: sale.total,
                    paid_on: paymentDate,
                    customer: { id: sale.customer_id, dpi: sale.dpi, full_name: sale.full_name, phone: sale.phone },
                },
            },
            client
        );
    }

    return {
        payment: { ...payment, balance_before: balanceBefore, balance_after: money(fromCents(Math.max(remainingCents, 0))) },
        allocations,
        remainingCents,
    };
}

/**
 * ANULA UN PAGO (solo Administración, regla PG3).
 *
 * Solo se anula el ÚLTIMO pago aplicado de la venta. El motivo es el FIFO:
 * las cuotas se llenaron en el orden en que entraron los pagos, así que
 * anular uno intermedio dejaría una distribución que no corresponde a ningún
 * recorrido posible. Para anular uno anterior hay que anular antes los
 * posteriores, y cada anulación queda registrada.
 *
 * Qué NO hace:
 *   * no borra el pago: lo marca `anulado` con motivo, fecha y responsable;
 *   * no borra sus asignaciones a cuotas: son la trazabilidad del FIFO. Las
 *     vistas solo suman los pagos `aplicado`, así que el saldo sube solo;
 *   * no saca el pago de su depósito. La conciliación del depósito refleja
 *     después la anulación (v_deposits separa esperado, anulado y aplicado)
 *     sin alterar ni ocultar el depósito.
 */
export async function voidPayment(id, reason, actor) {
    const saleId = await withTransaction(async (client) => {
        // Mismo orden de bloqueo que registrar un pago o anular la venta: se
        // bloquea primero la venta, así esta comprobación y la anulación no
        // pueden cruzarse con un cobro que entre a la vez.
        const { rows: owner } = await client.query('SELECT sale_id FROM payments WHERE id = $1', [id]);
        if (!owner[0]) throw AppError.notFound('Pago no encontrado');
        await client.query('SELECT id FROM sales WHERE id = $1 FOR UPDATE', [owner[0].sale_id]);

        const state = await Payment.lastAppliedCheck(client, id);
        if (!state) throw AppError.notFound('Pago no encontrado');
        if (state.status !== 'aplicado') throw AppError.conflict('El pago ya estaba anulado');

        if (state.blocking_id) {
            // El mensaje es el que ve el cajero: se le dice exactamente qué
            // pago estorba, no un error de base de datos.
            throw AppError.conflict(
                `Solo se puede anular el último pago aplicado de la venta. Anula primero el pago P-${String(
                    state.blocking_id
                ).padStart(6, '0')}.`,
                {
                    reason: 'NOT_LAST_PAYMENT',
                    payment_id: Number(id),
                    blocking_payment_id: Number(state.blocking_id),
                }
            );
        }

        const voided = await Payment.voidPayment(client, id, reason, actor?.id ?? null);
        if (!voided) throw AppError.conflict('El pago no existe o ya estaba anulado');

        // Si el pago estaba en un depósito, ahí se queda: la conciliación lo
        // seguirá listando y mostrará el efecto por separado.
        const deposit = await Payment.depositOf(client, id);
        if (deposit) {
            await client.query(
                `INSERT INTO deposit_events (deposit_id, event, from_status, to_status, actor_id, comment)
                 VALUES ($1, 'OBSERVADO', $2, $2, $3, $4)`,
                [
                    deposit.id,
                    deposit.status,
                    actor?.id ?? null,
                    `Se anuló el pago P-${String(id).padStart(6, '0')} incluido en este depósito: ${reason}`,
                ]
            );
        }

        return voided.sale_id;
    });

    return Sale.findById(saleId);
}

/**
 * Cuentas por cobrar: ventas con saldo, ordenadas por urgencia de cobro.
 *
 * Con alcance propio (`receivables.view.own`) solo se devuelven los créditos
 * que registró el propio usuario. El filtro va en el SQL, no en el resultado:
 * lo que no le corresponde nunca sale de la base de datos.
 */
export async function receivables({ status = '', customerId = null, page = 1, pageSize = 20, scope = null }) {
    const filters = ["status = 'activa'", 'balance > 0'];
    const params = [];

    if (scope && !scope.global) {
        filters.push(ownPortfolioFilter(scope, params));
    }

    if (status) {
        params.push(status);
        filters.push(`account_status = $${params.length}`);
    }
    if (customerId) {
        params.push(customerId);
        filters.push(`customer_id = $${params.length}`);
    }

    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const { rows } = await query(
        `SELECT *, COUNT(*) OVER()::int AS total_count
           FROM v_sales
          WHERE ${filters.join(' AND ')}
       ORDER BY (account_status = 'vencida') DESC, next_due_date NULLS LAST, id
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    const total = rows[0]?.total_count ?? 0;
    return {
        data: rows.map(({ total_count, ...s }) => s),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
}
