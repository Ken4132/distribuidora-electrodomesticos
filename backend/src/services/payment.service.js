import { withTransaction, query } from '../config/db.js';
import * as Payment from '../models/payment.model.js';
import * as Sale from '../models/sale.model.js';
import { AppError } from '../utils/AppError.js';
import { money, toCents, fromCents } from '../utils/money.js';
import { today, isIsoDate } from '../utils/dates.js';
import { recordEvent, EVENT_TYPES, dispatchInBackground } from './events.service.js';
import { saleInScope, scopeDenialMessage, ownPortfolioFilter } from './scope.service.js';
import { recordAudit } from './audit.service.js';

export const listPayments = (opts) => Payment.list(opts);

export async function getPayment(id) {
    const payment = await Payment.findById(id);
    if (!payment) throw AppError.notFound('Pago no encontrado');
    return payment;
}

/**
 * Registra un pago y lo asigna automáticamente a las cuotas pendientes,
 * de la más antigua a la más reciente (criterio estándar de cobranza).
 *
 * Todo ocurre en una transacción con las cuotas bloqueadas, de modo que dos
 * pagos simultáneos no puedan generar sobrepago.
 *
 * @param {object} input   datos del pago ya validados
 * @param {object} actor   quien cobra: { id, username, role, ip, userAgent }
 * @param {object} scope   alcance resuelto: { global, userId } (ver scope.service.js)
 */
export async function createPayment(input, actor, scope) {
    const paymentDate = input.payment_date && isIsoDate(input.payment_date) ? input.payment_date : today();
    const userId = actor?.id ?? null;

    let saleId;
    try {
        saleId = await withTransaction(async (client) => {
        const { rows: sales } = await client.query(
            `SELECT s.id, s.customer_id, s.status, s.total, s.created_by, s.payment_mode,
                    c.full_name, c.dpi, c.phone
               FROM sales s JOIN customers c ON c.id = s.customer_id
              WHERE s.id = $1
                FOR UPDATE OF s`,
            [input.sale_id]
        );
        const sale = sales[0];
        if (!sale) throw AppError.badRequest('La venta indicada no existe');

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

        await applyPaymentToSale(client, sale, { ...input, payment_date: paymentDate }, userId);
        return sale.id;
        });
    } catch (error) {
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

    const sale = await Sale.findById(saleId);
    const installments = await Sale.findInstallments(saleId);
    const payments = await Sale.findPayments(saleId);
    return { sale, installments, payments };
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
export async function applyPaymentToSale(client, sale, input, userId) {
    const paymentDate = input.payment_date;

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

    const payment = await Payment.createPayment(client, {
        sale_id: sale.id,
        customer_id: sale.customer_id,
        payment_date: paymentDate,
        amount: money(fromCents(amountCents)),
        method: input.method ?? 'efectivo',
        reference: input.reference,
        notes: input.notes,
        created_by: userId,
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
                remaining_balance: money(fromCents(Math.max(remainingCents, 0))),
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

    return { payment, allocations, remainingCents };
}

/** Anula un pago: las asignaciones se eliminan y el saldo vuelve a subir. */
export async function voidPayment(id, reason) {
    const result = await withTransaction(async (client) => {
        // Se bloquea la venta del pago (mismo orden de bloqueo que registrar un
        // pago o anular la venta) para no cruzarse con esas operaciones.
        const { rows: owner } = await client.query('SELECT sale_id FROM payments WHERE id = $1', [id]);
        if (owner[0]) await client.query('SELECT id FROM sales WHERE id = $1 FOR UPDATE', [owner[0].sale_id]);
        const voided = await Payment.voidPayment(client, id, reason);
        if (!voided) throw AppError.conflict('El pago no existe o ya estaba anulado');
        // Las aplicaciones a cuotas NO se borran: quedan como historial. Las vistas
        // (v_installments, v_sales) solo suman pagos en estado 'aplicado'.
        return voided.sale_id;
    });
    return Sale.findById(result);
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
