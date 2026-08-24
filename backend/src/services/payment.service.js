import { withTransaction, query } from '../config/db.js';
import * as Payment from '../models/payment.model.js';
import * as Sale from '../models/sale.model.js';
import { AppError } from '../utils/AppError.js';
import { money, toCents, fromCents } from '../utils/money.js';
import { today, isIsoDate } from '../utils/dates.js';
import { recordEvent, EVENT_TYPES, dispatchInBackground } from './events.service.js';

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
 */
export async function createPayment(input, userId) {
    const paymentDate = input.payment_date && isIsoDate(input.payment_date) ? input.payment_date : today();

    const saleId = await withTransaction(async (client) => {
        const { rows: sales } = await client.query(
            `SELECT s.id, s.customer_id, s.status, s.total, c.full_name, c.dpi, c.phone
               FROM sales s JOIN customers c ON c.id = s.customer_id
              WHERE s.id = $1
                FOR UPDATE OF s`,
            [input.sale_id]
        );
        const sale = sales[0];
        if (!sale) throw AppError.badRequest('La venta indicada no existe');
        if (sale.status === 'anulada') throw AppError.unprocessable('No se pueden registrar pagos en una venta anulada');

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

        return sale.id;
    });

    dispatchInBackground();

    const sale = await Sale.findById(saleId);
    const installments = await Sale.findInstallments(saleId);
    const payments = await Sale.findPayments(saleId);
    return { sale, installments, payments };
}

/** Anula un pago: las asignaciones se eliminan y el saldo vuelve a subir. */
export async function voidPayment(id, reason) {
    const result = await withTransaction(async (client) => {
        const voided = await Payment.voidPayment(client, id, reason);
        if (!voided) throw AppError.conflict('El pago no existe o ya estaba anulado');
        await client.query('DELETE FROM payment_allocations WHERE payment_id = $1', [id]);
        return voided.sale_id;
    });
    return Sale.findById(result);
}

/** Cuentas por cobrar: ventas con saldo, ordenadas por urgencia de cobro. */
export async function receivables({ status = '', customerId = null, page = 1, pageSize = 20 }) {
    const filters = ["status = 'activa'", 'balance > 0'];
    const params = [];

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
